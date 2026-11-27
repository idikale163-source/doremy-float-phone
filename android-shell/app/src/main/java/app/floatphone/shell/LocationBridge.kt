package app.floatphone.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Locale
import kotlin.math.abs
import kotlin.math.round

/**
 * 位置桥：把「手机现在大概在哪儿」交给网页。
 *
 * 与 PerceptionBridge 同一分工：本类只「读」与「取名」，不做判断——
 * 什么时候算「到了一个新地方」、要不要告诉角色，全部由网页侧的
 * lib/perception 决定，阈值随网页部署即时生效。
 *
 * 设计边界（改这个文件前先读）：
 *  - **只前台、不后台**：只用前台运行时权限，刻意**不申请**
 *    ACCESS_BACKGROUND_LOCATION。采样本来就发生在 App 活着的时候
 *    （网页定时器），后台持续定位只会白耗电，并把「角色知道我大概在哪」
 *    升级成「角色一直跟着我」——那是另一件事，不该顺手做掉。
 *  - **不追踪轨迹**：只回一个「当前位置」，不保留历史、不记录路径、
 *    不识别常去地点。网页只在两次取值之间比一下距离。
 *  - **坐标降精度**：上报前四舍五入到小数点后 3 位（约 110 米）。
 *    「到家了」「到公司了」只需要这个量级，精确坐标却能定位到具体楼栋。
 *  - **地名只到区/街道级**：刻意不取门牌与地标名。
 *  - 未授权、定位开关关着、取不到，都如实返回空对象。调用方据此说
 *    「读不到」，绝不返回一个假坐标——角色会当真，比不说更糟。
 */
class LocationBridge(private val context: Context) {

    companion object {
        /** 缓存的定位结果存活多久。超过就视为过时，宁可不报。 */
        private const val CACHE_TTL_MS = 10 * 60 * 1000L

        /** 一次性取点的超时。定位冷启动要几秒，但别让网页干等。 */
        private const val FIX_TIMEOUT_MS = 12_000L

        /** 坐标保留几位小数。3 位约 110 米，够说「到了哪一片」。 */
        private const val COORD_DECIMALS = 3

        /**
         * 缓存最近一次结果。
         *
         * 定位是异步的，而这个桥要被网页同步读取，所以必须有缓存这一层。
         * 进程被杀会丢，无所谓——下次采样会重新取。
         */
        @Volatile
        private var cachedJson: String = ""

        @Volatile
        private var cachedAt: Long = 0L

        /** 是否正有一次取点在进行（避免反复刷新叠出一堆请求）。 */
        @Volatile
        private var fixing = false

        /** 诊断留痕：最近一次失败原因与累计取点次数。 */
        @Volatile
        private var lastError: String = ""

        @Volatile
        private var fixCount: Int = 0
    }

    private val main = Handler(Looper.getMainLooper())

    // ── 权限与开关状态 ──────────────────────────

    private fun granted(permission: String): Boolean = try {
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) {
        false
    }

    /** 是否拿到精确定位。 */
    fun hasFine(): Boolean = granted(Manifest.permission.ACCESS_FINE_LOCATION)

    /** 是否拿到粗略定位。 */
    fun hasCoarse(): Boolean = granted(Manifest.permission.ACCESS_COARSE_LOCATION)

    /** 粗略或精确，任一到手就能读（系统按精度档授权）。 */
    fun hasAny(): Boolean = hasFine() || hasCoarse()

    /**
     * 系统定位总开关开着没。
     *
     * 必须单独报：权限给了但用户在快捷开关里关了定位，读出来永远是空的。
     * 不区分这两件事，用户会以为「权限都给了怎么还是读不到」而放弃。
     */
    fun isLocationEnabled(): Boolean = try {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lm.isLocationEnabled
        } else {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }
    } catch (e: Throwable) {
        false
    }

    /**
     * 读「当前大概在哪」。返回 JSON：{lat, lon, accuracy, place}；
     * 读不到返回空对象。place 为空串表示反查没成功——坐标仍然可用。
     *
     * 顺序：新鲜缓存 → 系统最后已知位置。缓存让这个方法能同步回答。
     */
    fun readJson(): JSONObject {
        if (!hasAny()) return JSONObject()
        if (!isLocationEnabled()) return JSONObject()

        if (cachedJson.isNotEmpty() && System.currentTimeMillis() - cachedAt < CACHE_TTL_MS) {
            return runCatching { JSONObject(cachedJson) }.getOrDefault(JSONObject())
        }

        val known = freshestLastKnown() ?: return JSONObject()
        return cache(known)
    }

    /**
     * 主动取一次实时位置（一次性，不是持续追踪）。
     *
     * 为什么需要它：「最后已知位置」可能是几小时前的，拿它说「到了公司」
     * 就错了。取完结果落进缓存，之后 readJson() 就能读到。
     * 有请求在进行时直接返回，不叠加。
     */
    fun refresh() {
        if (!hasAny() || !isLocationEnabled()) return
        if (fixing) return
        fixing = true
        lastError = ""

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = ArrayList<String>()
        // 优先融合定位（API 31+，更省电更准），退回网络/GPS。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            providers.add(LocationManager.FUSED_PROVIDER)
        }
        runCatching {
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                providers.add(LocationManager.NETWORK_PROVIDER)
            }
        }
        runCatching {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                providers.add(LocationManager.GPS_PROVIDER)
            }
        }
        if (providers.isEmpty()) {
            fixing = false
            lastError = "系统里没有可用的定位来源"
            return
        }

        var settled = false
        val settle: (Location?) -> Unit = { location ->
            if (!settled) {
                settled = true
                fixing = false
                if (location == null) {
                    lastError = "这次没能取到位置"
                } else {
                    cache(location)
                    fixCount += 1
                    reverseGeocode(location)
                }
            }
        }

        val timeout = Runnable { settle(null) }
        main.postDelayed(timeout, FIX_TIMEOUT_MS)

        try {
            val provider = providers.first()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                lm.getCurrentLocation(
                    provider,
                    CancellationSignal(),
                    ContextCompat.getMainExecutor(context),
                ) { location ->
                    main.removeCallbacks(timeout)
                    settle(location)
                }
            } else {
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(
                    provider,
                    object : LocationListener {
                        override fun onLocationChanged(location: Location) {
                            main.removeCallbacks(timeout)
                            settle(location)
                        }

                        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
                        override fun onProviderEnabled(provider: String) = Unit
                        override fun onProviderDisabled(provider: String) = Unit
                    },
                    Looper.getMainLooper(),
                )
            }
        } catch (e: SecurityException) {
            main.removeCallbacks(timeout)
            lastError = "没有定位权限"
            settle(null)
        } catch (e: Throwable) {
            main.removeCallbacks(timeout)
            lastError = e.message ?: "取位置失败"
            settle(null)
        }
    }

    /** 从各 provider 的最后已知位置里挑最新的那个。都空则返回 null。 */
    private fun freshestLastKnown(): Location? {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        var best: Location? = null
        for (name in providers) {
            val candidate = try {
                if (lm.isProviderEnabled(name)) lm.getLastKnownLocation(name) else null
            } catch (e: Throwable) {
                null
            } ?: continue
            val current = best
            if (current == null || candidate.time > current.time) best = candidate
        }
        return best
    }

    /**
     * 把一次定位写进缓存（坐标降精度，保留已有地名）。
     *
     * 保留地名：refresh() 里先落坐标、再异步反查名字，若反查还没回来
     * 就有一次 readJson()，此时至少坐标是新的，名字退而上一次那个
     * （大概率仍是同一片区域，比空着更有用）。
     */
    private fun cache(location: Location): JSONObject {
        val prevPlace = runCatching {
            JSONObject(cachedJson).optString("place", "")
        }.getOrDefault("")
        val json = JSONObject()
            .put("lat", roundTo(location.latitude))
            .put("lon", roundTo(location.longitude))
            .put("accuracy", location.accuracy.toInt())
            .put("place", prevPlace)
        cachedJson = json.toString()
        cachedAt = System.currentTimeMillis()
        return json
    }

    private fun roundTo(value: Double): Double {
        val factor = Math.pow(10.0, COORD_DECIMALS.toDouble())
        return round(value * factor) / factor
    }

    /**
     * 坐标 → 粗粒度地名（区/街道一级）。
     *
     * 在后台线程做：Geocoder 是阻塞调用，放主线程会卡住浮层与网页。
     * 失败或拿不到就静默放弃——地名只是「说人话」的装饰，坐标本身
     * 仍然可用，不值得为它报错或重试。
     *
     * 刻意只取区/街道级名字，不取门牌、不取 POI 名。
     */
    private fun reverseGeocode(location: Location) {
        if (!Geocoder.isPresent()) return
        val targetLat = roundTo(location.latitude)
        Thread {
            val place = try {
                @Suppress("DEPRECATION")
                val list = Geocoder(context, Locale.getDefault())
                    .getFromLocation(location.latitude, location.longitude, 1)
                val address = list?.firstOrNull()
                // 从细到粗试，取到第一个非空的：区 → 城市 → 县 → 省。
                address?.subLocality
                    ?: address?.locality
                    ?: address?.subAdminArea
                    ?: address?.adminArea
                    ?: ""
            } catch (e: Throwable) {
                ""
            }
            if (place.isNotBlank()) {
                // 只在坐标没被刷新过时才补名字，避免把旧地名贴到新坐标上
                main.post {
                    runCatching {
                        val current = JSONObject(cachedJson)
                        if (abs(current.optDouble("lat", 0.0) - targetLat) < 1e-6) {
                            current.put("place", place)
                            cachedJson = current.toString()
                        }
                    }
                }
            }
        }.start()
    }

    /**
     * 能力与授权状态。
     *
     * 三件事分开报，用户才知道卡在哪一环：
     *   location          —— 这个壳版本能不能做（能）；
     *   locationGranted   —— 用户给没给定位权限；
     *   locationServiceOn —— 系统定位总开关有没有开着。
     * 后两者任一为假都读不到，「权限给了但开关关着」最容易被漏掉。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("location", true)
        .put("locationGranted", hasAny())
        .put("locationFineGranted", hasFine())
        .put("locationServiceOn", isLocationEnabled())
        .put("locationCached", cachedJson.isNotEmpty()
            && System.currentTimeMillis() - cachedAt < CACHE_TTL_MS)
        .toString()

    /** 诊断面板用的内部状态（只含状态与计数，不含具体坐标）。 */
    fun diagnosticsJson(): String = JSONObject()
        .put("fixing", fixing)
        .put("fixCount", fixCount)
        .put("hasCache", cachedJson.isNotEmpty())
        .put("cacheAgeMs", if (cachedAt > 0) System.currentTimeMillis() - cachedAt else -1)
        .put("lastError", lastError)
        .toString()
}
