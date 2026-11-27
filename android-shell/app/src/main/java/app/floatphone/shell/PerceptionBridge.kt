package app.floatphone.shell

import android.Manifest
import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * 感知桥：把手机自身的状态交给网页。
 *
 * 设计边界（重要，改这个文件前先读）：
 *  - 本类只做「读取」与「格式化」，不做任何判断、不写日志、不外传。
 *    什么时候取值、取到什么算「值得上报」、上报给谁，全部由网页侧的
 *    lib/perception/ 决定 —— 这样阈值、频率、开关都能随网页部署即时调整，
 *    不必为了调一个数字重新编译 APK。
 *  - 所有方法都不抛异常：取不到就返回空值或哨兵值（-1 / 空串），
 *    网页侧按「未知」处理，绝不让一个传感器拖垮整个界面或通话链路。
 *  - 只用零权限或 Manifest 已声明的权限：
 *      · 电量/充电状态 —— BatteryManager，零权限
 *      · 网络类型     —— ACCESS_NETWORK_STATE（已声明）
 *      · 应用显示名   —— QUERY_ALL_PACKAGES（已声明）
 *      · 步数         —— ACTIVITY_RECOGNITION（已声明，Android 10+ 需运行时授权）
 *    需要运行时授权的定位/日历/联系人不在本类，另见后续阶段。
 */
class PerceptionBridge(private val context: Context) {

    companion object {
        private const val PREFS = "perception_bridge"
        private const val KEY_STEP_DATE = "step_date"
        private const val KEY_STEP_BASELINE = "step_baseline"

        /**
         * 步数传感器是**异步**的：Android 没有同步取值接口，值只能由监听器推过来。
         * 所以这里缓存最后一次读到的累计值，快照方法只读缓存——
         * 若改成「读的时候现挂一个监听器」，首次调用必然拿不到值，
         * 而且每次采样都注册/注销会白白耗电。
         */
        @Volatile
        private var cumulativeSteps: Float = -1f

        @Volatile
        private var sensorAttached = false

        /**
         * 挂上步数传感器监听。幂等：重复调用不会挂第二个。
         *
         * 由 MainActivity 在启动时调用；网页侧首次读步数时也会补挂一次，
         * 覆盖「先打开 App、之后才授权活动识别」这种情况。
         */
        @JvmStatic
        fun attachStepSensor(context: Context) {
            if (sensorAttached) return
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
            try {
                if (context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION)
                    != PackageManager.PERMISSION_GRANTED
                ) return
                val sm = context.applicationContext
                    .getSystemService(Context.SENSOR_SERVICE) as SensorManager
                val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return
                sm.registerListener(object : SensorEventListener {
                    override fun onSensorChanged(event: SensorEvent) {
                        val value = event.values.firstOrNull() ?: return
                        cumulativeSteps = value
                    }

                    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
                }, sensor, SensorManager.SENSOR_DELAY_NORMAL)
                sensorAttached = true
            } catch (e: Throwable) {
                // 传感器不可用时静默降级：步数一直读不到，网页侧会省略这一项
            }
        }
    }

    /**
     * 电量百分比 + 是否在充电。零权限。
     *
     * 用 BatteryManager 的属性接口而不是 ACTION_BATTERY_CHANGED 粘性广播：
     * 后者要 registerReceiver(null, filter)，而 Android 14（targetSdk 34）对动态
     * 注册接收者加了 RECEIVER_EXPORTED/NOT_EXPORTED 强制要求，系统广播虽豁免，
     * 但少一个需要推敲的地方总是好的。属性接口只需 API 23（isCharging）。
     */
    fun batteryJson(): JSONObject = try {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val percent = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        // 充电判定优先用状态位，取不到才回退 isCharging。
        //
        // 为什么不能只看 isCharging：它在部分机型上会漏报——尤其「插着电源但电池已满」
        // 与「刚插上、还没被识别」这两种时刻。网页侧一旦读到 false 就发一条「充电结束」，
        // 过会儿又变 true 发「充电开始」，用户看到的就是充电状态乱跳、识别不准（实测反馈）。
        // BATTERY_PROPERTY_STATUS 给的是完整状态位：CHARGING / FULL / DISCHARGING /
        // NOT_CHARGING / UNKNOWN，「插着电源」= CHARGING 或 FULL。
        val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_STATUS)
        } else {
            Int.MIN_VALUE
        }
        val charging = if (status != Int.MIN_VALUE && status != BatteryManager.BATTERY_STATUS_UNKNOWN) {
            status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        } else {
            bm.isCharging
        }
        JSONObject()
            .put("percent", if (percent in 0..100) percent else -1)
            .put("charging", charging)
            // 状态原文一并回传：诊断时能看出到底是哪种（充电/已满/放电/未知），
            // 而不是只有一个 true/false 让人猜为什么不准。
            .put("status", status)
    } catch (e: Throwable) {
        JSONObject()
    }

    /**
     * 网络类型与是否计费网络。需 ACCESS_NETWORK_STATE（已声明）。
     * type: wifi / cellular / ethernet / vpn / other / none（未知一律 none）。
     * metered=true 表示走流量，网页侧可据此提示「省着点」。
     */
    fun networkJson(): JSONObject = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
        val metered = caps?.let {
            !it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        } ?: true
        JSONObject()
            .put("type", type)
            .put("metered", metered)
    } catch (e: Throwable) {
        JSONObject()
    }

    /**
     * 包名 → 应用显示名。取不到返回空串，调用方退回显示包名。
     *
     * 前台应用感知上报的是包名（com.tencent.mm 这种），直接喂给角色毫无意义。
     * 这一步是「让角色看懂你在用什么」的必要翻译。需 QUERY_ALL_PACKAGES（已声明）。
     */
    fun appLabel(packageName: String): String = try {
        if (packageName.isBlank()) "" else {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        }
    } catch (e: Throwable) {
        ""
    }

    /**
     * 当天步数的估算值。取不到返回 -1（网页侧直接省略这一项，不会报「0 步」）。
     *
     * 原理：TYPE_STEP_COUNTER 给的是「开机以来累计步数」，要得到「今天」
     * 需要减掉今天零点的那个累计值。而零点时 App 不一定在跑，所以这里
     * 只能以「今天第一次读到时的累计值」作为基线。
     *
     * 代价要清楚：如果 App 是上午 10 点才第一次打开，那么基线就是 10 点的值，
     * 报出来的是「10 点之后走的步数」，会少算早晨那段。所以：
     *   · 这是一个**粗线索**（在走动 / 宅着），不是计步器的精确数字；
     *   · 跨天那一次刻意返回 -1 而不是 0 ——「今天走了 0 步」会引出
     *     「你今天没出门啊」这种错误结论，「读不到」则会被干脆省略。
     * 想要精确值需要接 Health Connect，不在本阶段范围。
     *
     * 需 ACTIVITY_RECOGNITION 运行时权限（Android 10+）。
     */
    fun stepsJson(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1
        if (context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION)
            != PackageManager.PERMISSION_GRANTED
        ) return -1
        // 权限可能是刚授的，补挂一次（幂等）
        attachStepSensor(context)
        val cumulative = cumulativeSteps
        if (cumulative < 0f) return -1

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val today = todayKey()
        val storedDate = prefs.getString(KEY_STEP_DATE, "").orEmpty()
        val baseline = prefs.getFloat(KEY_STEP_BASELINE, -1f)
        // 设备重启会让累计值归零：旧基线比现值还大，必须重设
        val rebooted = baseline >= 0f && cumulative < baseline

        if (storedDate != today || baseline < 0f || rebooted) {
            prefs.edit()
                .putString(KEY_STEP_DATE, today)
                .putFloat(KEY_STEP_BASELINE, cumulative)
                .apply()
            return -1
        }
        return (cumulative - baseline).toInt().coerceAtLeast(0)
    }

    private fun todayKey(): String {
        val c = Calendar.getInstance()
        return "${c.get(Calendar.YEAR)}-${c.get(Calendar.MONTH) + 1}-${c.get(Calendar.DAY_OF_MONTH)}"
    }

    // ── 使用情况（屏幕使用时间）─────────────────────────────

    /**
     * 是否已授予「使用情况访问」权限（屏幕使用时间的前提）。
     *
     * 截屏/查岗那边由 DeviceActionBridge 回答同一个问题，两边语义一致，
     * 但**不共用**：PerceptionBridge 自己也要用它来决定 usageStatsJson 返回什么，
     * 跨类调用会把「感知只读、设备动作只写」的分工搅乱。
     */
    private fun hasUsageStatsAccess(): Boolean = try {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        }
        mode == AppOpsManager.MODE_ALLOWED
    } catch (e: Throwable) {
        false
    }

    /**
     * 读「今天各应用用了多久」，按使用时长降序返回 JSON 数组。
     *
     * 每条只有三个字段：package / label / minutes。
     * 刻意**不返回**使用的时间点、启动次数、具体页面——「用了多久」已经
     * 足够让角色说一句「你今天刷了好久的视频」，而时间点会暴露作息细节，
     * 属于不必要的隐私放大。
     *
     * 未授权、系统不支持、查询异常都返回空数组：调用方据此说「读不到」，
     * 而不是拿到一堆假数据。
     *
     * @param maxEntries 最多返回几条（按时长降序取前 N）。默认 12。
     */
    fun usageStatsJson(maxEntries: Int): String {
        val result = JSONArray()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return result.toString()
        if (!hasUsageStatsAccess()) return result.toString()
        return try {
            val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val now = System.currentTimeMillis()
            // 从今天零点算起。用「当天」而不是「最近 24 小时」，
            // 因为角色问的是「你今天在干嘛」，跨天的时间段会算进昨天，读着别扭。
            val begin = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }.timeInMillis
            val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, begin, now)
                ?: return result.toString()

            // 同一包名可能返回多条（分桶），先按包名累加
            val totalByPackage = HashMap<String, Long>()
            for (stat in stats) {
                val pkg = stat.packageName ?: continue
                val ms = stat.totalTimeInForeground
                if (ms <= 0L) continue
                totalByPackage[pkg] = (totalByPackage[pkg] ?: 0L) + ms
            }

            val limit = maxEntries.coerceIn(1, 50)
            val top = totalByPackage.entries
                .sortedByDescending { it.value }
                .take(limit)

            for ((pkg, ms) in top) {
                val minutes = (ms / 60_000L).toInt()
                // 不足一分钟的不列：那种多半是系统组件被拉起一下，
                // 报给角色只会变成噪声。
                if (minutes < 1) continue
                result.put(
                    JSONObject()
                        .put("package", pkg)
                        .put("label", appLabel(pkg))
                        .put("minutes", minutes),
                )
            }
            result.toString()
        } catch (e: Throwable) {
            result.toString()
        }
    }

    /**
     * 一次取全的设备快照。网页侧的采样定时器每次只跨桥一次，
     * 比分别问电量、问网络少一半调用开销。
     */
    fun snapshotJson(): String = JSONObject()
        .put("battery", batteryJson())
        .put("network", networkJson())
        .put("steps", stepsJson())
        .toString()

    /**
     * 本机支持哪些感知能力 —— 给「感知 → 诊断」面板用。
     *
     * 网页据此显示「已接通 / 不支持」，而不是让用户对着一个没反应的开关猜原因。
     * 这解决了这次审计暴露的老问题：Manifest 声明了一堆权限，但底下什么都没有，
     * 用户完全看不出来。以后每接通一项就来这里登记一项。
     *
     * 注意：「回到手机」是纯网页能力（前后台计时），但它是网页设置页要展示的
     * 能力之一，所以也在这里登记为 true，避免面板把它显示成「当前版本不支持」。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("battery", true)
        .put("network", true)
        .put("appLabel", true)
        .put("foregroundApp", true)
        .put("steps", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        .put("returnToPhone", true)
        // 位置已接通（见 LocationBridge）：能读就报能读，授权态另报——
        // 混为一谈会让用户以为手机不支持、从而放弃授权。
        .put("location", true)
        .put("calendar", false)
        .put("contacts", false)
        // usageStats 现在是真接通了（见 usageStatsJson）：能读就报能读。
        // 注意区分「支持」与「已授权」——授权状态走 hasUsageStatsAccess()，
        // 混为一谈会让用户以为手机不支持、从而放弃授权。
        .put("usageStats", Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
        .put("usageStatsGranted", hasUsageStatsAccess())
        // 睡眠接的是 Health Connect（见 HealthBridge）：能力上是支持的，
        // 「装没装 / 授没授权」另由健康桥回答——不在这里报，免得两处状态打架。
        .put("sleep", true)
        .toString()
}
