package app.floatphone.shell

import android.content.Context
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * 健康桥：把「昨晚睡了多久」交给网页。
 *
 * 为什么走 Health Connect 而不是直接读某个运动 App：
 *   华为运动健康、小米运动、三星健康各有一套私有数据，接一家就只能覆盖一部分
 *   用户；Health Connect 由系统统一汇聚，这些 App 的数据都会写进去，接一次就
 *   对所有 ROM 生效。代价是用户得在系统里启用它并逐项授权——这个代价是明摆着的，
 *   所以界面上会如实说明，而不是假装零成本。
 *
 * 设计边界（改这个文件前先读）：
 *  - **只读不写**：只申请 READ_SLEEP，不申请任何写入权限。角色不该往用户的
 *    健康档案里写东西，那是医疗数据，不是聊天记录。
 *  - **只读睡眠**：不读心率、血氧、体重这些更身体性的指标。睡眠时长已经足够
 *    支撑「你昨晚没睡好」这种关心；往下读是另一个量级的隐私，得有明确需求再加。
 *  - **只回时长与起止**：不回睡眠分期（深睡/浅睡/REM）。分期是医学化的读数，
 *    角色拿它说事只会像个体检报告。
 *  - **取不到就如实说取不到**：没装 / 没授权 / 没数据，都返回空，绝不编一个
 *    「昨晚睡了 8 小时」——这种假数据角色会当真，比不说糟得多。
 */
class HealthBridge(private val context: Context) {

    companion object {
        /**
         * 读取睡眠所需的 Health Connect 权限。
         *
         * 用 getReadPermission(SleepSessionRecord::class) 而不是某个
         * PERMISSION_* 常量：Health Connect 里没有「睡眠」专用常量，
         * 权限是按记录类型算出来的。
         *
         * 用 get() 属性而不是 val 初始化：它是函数调用，写在初始化表达式里
         * 会在类加载时就执行，万一抛异常等于整个桥都不可用；按需算最多只坏一次。
         */
        val PERM_SLEEP: String
            get() = HealthPermission.getReadPermission(SleepSessionRecord::class)

        /** 缓存存活多久。睡眠数据一天才变几次，没必要频繁重读。 */
        private const val CACHE_TTL_MS = 30 * 60 * 1000L

        /** 往回看多少小时。36 小时足够覆盖「昨晚那一觉」而不拖进前天的。 */
        private const val LOOKBACK_HOURS = 36L

        /**
         * 缓存。Health Connect 的读取是挂起函数，而网页要能同步读，
         * 所以必须由后台协程取好、这里存着。
         */
        @Volatile
        private var cachedJson: String = ""

        @Volatile
        private var cachedAt: Long = 0L

        /** 睡眠读取权限当前是否已授予（异步刷新，网页靠轮询确认）。 */
        @Volatile
        private var granted = false

        /** 是否正有一次刷新在进行（避免叠请求）。 */
        @Volatile
        private var refreshing = false

        /** 最近一次失败原因（诊断用）。 */
        @Volatile
        private var lastError: String = ""

        /** 累计成功刷新次数（诊断用）。 */
        @Volatile
        private var refreshCount = 0
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ── 可用性 ──────────────────────────────────────

    /**
     * Health Connect 在这台设备上能不能用。
     *
     * 三种结果要分开：
     *   SDK_AVAILABLE                    —— 能用；
     *   SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED —— 装了但版本太旧，得去更新；
     *   SDK_UNAVAILABLE                  —— 没装（Android 13 及以下），得先去装。
     * 合成的「不能用」没法告诉用户下一步该干嘛，所以原样往上报。
     */
    fun sdkStatus(): Int = try {
        HealthConnectClient.getSdkStatus(context)
    } catch (e: Throwable) {
        HealthConnectClient.SDK_UNAVAILABLE
    }

    /** 能不能读（只有 SDK_AVAILABLE 才算能）。 */
    fun isAvailable(): Boolean = sdkStatus() == HealthConnectClient.SDK_AVAILABLE

    /** 睡眠读取权限是否已授予（读的是异步刷新的缓存）。 */
    fun hasSleepPermission(): Boolean = granted

    /**
     * 跳到 Health Connect 的设置页（用户在那里看数据来源与撤销授权）。
     * 未安装时退回应用市场页，让用户能装上。返回是否成功跳转。
     */
    fun openHealthSettings(): Boolean = try {
        context.startActivity(
            Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    } catch (e: Throwable) {
        // 没装 Health Connect 时上面的 Activity 不存在，跳不动——
        // 退回应用市场页让用户能装上，而不是静默什么都不发生。
        try {
            context.startActivity(
                Intent(
                    Intent.ACTION_VIEW,
                    android.net.Uri.parse("market://details?id=com.google.android.apps.healthdata"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        } catch (e2: Throwable) {
            false
        }
    }

    // ── 刷新（异步取，落缓存）──────────────────────

    /**
     * 取一次权限状态与最近的睡眠数据，落进缓存。
     *
     * 为什么是「取好存着」而不是「读的时候现取」：Health Connect 的每个
     * API 都是挂起函数，而 @JavascriptInterface 必须是同步的。所以模式与
     * 位置桥一致：网页按采样周期先调 refresh，下一次读走缓存。
     */
    fun refresh() {
        if (refreshing) return
        if (!isAvailable()) {
            // 记下「不可用」而不是留个空缓存：诊断面板要能区分
            // 「没装 Health Connect」和「装了但没给权限」。
            lastError = "Health Connect 不可用（未安装或需更新）"
            return
        }
        refreshing = true
        scope.launch {
            try {
                // 权限控制器要从客户端上拿（client.permissionController）。
                // 原来写的 PermissionController.create(context) 并不存在——
                // 那是凭印象写的，CI 已证伪。
                val client = HealthConnectClient.getOrCreate(context)
                val has = client.permissionController.getGrantedPermissions().contains(PERM_SLEEP)
                granted = has
                if (!has) {
                    cachedJson = ""
                    cachedAt = 0L
                    lastError = "还没有睡眠读取权限"
                    return@launch
                }
                // 缓存还新鲜就不重读。网页每个采样周期都会调一次 refresh，
                // 而睡眠一天才变几次——不拦一下等于每分钟往 Health Connect
                // 查一次，纯属白耗电。
                if (cachedJson.isNotEmpty()
                    && System.currentTimeMillis() - cachedAt < CACHE_TTL_MS
                ) {
                    lastError = ""
                    return@launch
                }
                readSleepIntoCache()
                lastError = ""
                refreshCount += 1
            } catch (e: Throwable) {
                lastError = e.message ?: "读健康数据失败"
            } finally {
                refreshing = false
            }
        }
    }

    /**
     * 读最近 36 小时的睡眠，合并成「最近一觉」写进缓存。
     *
     * 合并口径：按时间排序后，把**结束时刻的间隔小于 2 小时**的相邻段算作
     * 同一觉——手环常把一夜拆成好几段（中途醒了），不合并就会报成
     * 「睡了 3 觉，每觉两小时」，读着像故障。间隔大于 2 小时则视为两觉
     * （午睡、夜班分段），分开算，只报最近那一觉。
     */
    private suspend fun readSleepIntoCache() {
        val client = HealthConnectClient.getOrCreate(context)
        val end = Instant.now()
        val start = end.minus(LOOKBACK_HOURS, ChronoUnit.HOURS)
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end),
            ),
        )

        val sessions = response.records
            .filter { it.endTime.isAfter(it.startTime) }
            .sortedBy { it.startTime }
        if (sessions.isEmpty()) {
            cachedJson = ""
            cachedAt = System.currentTimeMillis()
            return
        }

        // 合并相邻段：间隔 < 2 小时视为同一觉
        data class Span(var start: Instant, var end: Instant)
        val merged = ArrayList<Span>()
        for (record in sessions) {
            val last = merged.lastOrNull()
            if (last != null && ChronoUnit.MINUTES.between(last.end, record.startTime) < 120) {
                if (record.endTime.isAfter(last.end)) last.end = record.endTime
            } else {
                merged.add(Span(record.startTime, record.endTime))
            }
        }
        val latest = merged.last()
        val minutes = ChronoUnit.MINUTES.between(latest.start, latest.end).toInt()

        val json = JSONObject()
            .put("sleepMinutes", minutes.coerceAtLeast(0))
            .put("sleepEndAt", latest.end.toEpochMilli())
            .put("sleepStartAt", latest.start.toEpochMilli())
        cachedJson = json.toString()
        cachedAt = System.currentTimeMillis()
    }

    // ── 同步读取（网页用）──────────────────────────

    /**
     * 读缓存的最近一觉。返回 JSON：{sleepMinutes, sleepEndAt, sleepStartAt}；
     * 没有新鲜缓存时返回空对象。
     *
     * 刻意不在这里「顺手取一次」：读取是挂起函数，同步方法里取不了；
     * 硬要取只能阻塞等，会把 WebView 主线程卡住。
     */
    fun readJson(): JSONObject {
        if (!granted) return JSONObject()
        if (cachedJson.isEmpty()) return JSONObject()
        if (System.currentTimeMillis() - cachedAt > CACHE_TTL_MS) return JSONObject()
        return runCatching { JSONObject(cachedJson) }.getOrDefault(JSONObject())
    }

    /**
     * 能力与授权状态。
     *
     * 三项分开报，用户才知道卡在哪一环：
     *   health          —— 这个壳版本接没接（接了）；
     *   healthAvailable —— Health Connect 装没装 / 能不能用；
     *   healthGranted   —— 睡眠读取权限给没给。
     * 「能用但没授权」和「根本不可用」是两回事，混在一起用户不知道下一步干嘛。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("health", true)
        .put("healthAvailable", isAvailable())
        .put("healthGranted", granted)
        .put("healthSdkStatus", sdkStatus())
        .toString()

    /** 诊断面板用的内部状态（只含状态与计数，不含睡眠内容）。 */
    fun diagnosticsJson(): String = JSONObject()
        .put("available", isAvailable())
        .put("granted", granted)
        .put("refreshing", refreshing)
        .put("refreshCount", refreshCount)
        .put("hasCache", cachedJson.isNotEmpty()
            && System.currentTimeMillis() - cachedAt <= CACHE_TTL_MS)
        .put("cacheAgeMs", if (cachedAt > 0) System.currentTimeMillis() - cachedAt else -1)
        .put("lastError", lastError)
        .toString()
}
