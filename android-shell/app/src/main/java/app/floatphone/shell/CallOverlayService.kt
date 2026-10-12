package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 通话浮窗服务：把正在进行的通话做成能浮在其他 App 上层的原生小窗。
 *
 * 为什么必须原生：网页里的悬浮元素出不了浏览器窗口，用户切到微信/视频，
 * 通话小窗随之消失。这里用 WindowManager + TYPE_APPLICATION_OVERLAY 挂到
 * 系统层级，任何 App 前台时都看得见。
 *
 * 职责边界：本服务只做「显示与交互」（绘制、拖动、缩放、按钮、快捷回复框），
 * 音频与对话逻辑仍归网页。交互经 ShellBus 以 CustomEvent 投回页面：
 *   restore —— 点浮窗回全屏；hangup —— 挂断；reply —— 快捷回复文本；
 *   tick    —— 每秒心跳，带 seconds（时长）。
 * 后台 WebView 的 setInterval 会被系统节流甚至冻结，自动搭话因此可能停摆；
 * 把计时器搬到原生、每秒戳一下页面，是「切出去也能一直聊」的关键。
 *
 * 前台服务：Android 8+ 后台服务随时可被杀，故 startForeground 常驻，
 * 顺带把进程钉住，网页的 TTS 才不至于切走后被掐。
 */
/**
 * 长按浮窗弹出的快捷回复条配色。
 *
 * 原先这些颜色写死在本文件里（深底 + 蓝按钮），想换只能改代码重编。现在抽成几套
 * 预设：网页侧「设置 → 通话浮窗外观」选一套，键名经 AndroidShell.setOverlayTheme()
 * 存进 SharedPreferences；换主题时已弹出的回复条就地重绘，不用重开通话。
 */
data class ReplyTheme(
    val key: String,
    val label: String,
    /** 条身底色 */
    val bar: Int,
    /** 输入文字 */
    val text: Int,
    /** 占位文字 */
    val hint: Int,
    /** 发送键底色 */
    val accent: Int,
    /** 发送键文字（浅色底上白字会看不清，故单列一项） */
    val sendText: Int,
    /** 次要按钮（收起）文字 */
    val muted: Int,
) {
    companion object {
        /**
         * 兜底预设键。
         *
         * 这里单独定义一份、而不是用 CallOverlayService.Companion 里的同名常量：
         * data class 的伴生对象与外层 Service 的伴生对象是两个作用域，前者看不到后者，
         * 直接引用会编译不过（Unresolved reference）。ReplyTheme 保持自成一体，
         * 也不该反过来依赖 Service。
         */
        private const val THEME_DEFAULT = "dark"

        fun build(key: String, label: String, bar: Long, text: Long, hint: Long, accent: Long, sendText: Long, muted: Long) =
            ReplyTheme(key, label, bar.toInt(), text.toInt(), hint.toInt(), accent.toInt(), sendText.toInt(), muted.toInt())

        val DARK = build("dark", "暗夜", 0xF21B1B22, 0xFFFFFFFF, 0xFF8A93A6, 0xFF3B82F6, 0xFFFFFFFF, 0xFFC9D1E0)
        val LIGHT = build("light", "浅色", 0xF2FFFFFF, 0xFF1B1B22, 0xFF8A93A6, 0xFF3B82F6, 0xFFFFFFFF, 0xFF5A6270)
        val OCEAN = build("ocean", "深海", 0xF20E1A2B, 0xFFFFFFFF, 0xFF7E8DA6, 0xFF4C8DFF, 0xFFFFFFFF, 0xFF9FB0C9)
        val SAKURA = build("sakura", "樱粉", 0xF22A1B24, 0xFFFFFFFF, 0xFFB08A9C, 0xFFE56B9A, 0xFFFFFFFF, 0xFFC9A3B3)
        val BAMBOO = build("bamboo", "青竹", 0xF2152419, 0xFFFFFFFF, 0xFF8AA694, 0xFF30A46C, 0xFFFFFFFF, 0xFFA3C9B3)
        val VIOLET = build("violet", "夜幕", 0xF21D182B, 0xFFFFFFFF, 0xFF938AA6, 0xFF9B6BFF, 0xFFFFFFFF, 0xFFB3A9C9)

        val ALL = listOf(DARK, LIGHT, OCEAN, SAKURA, BAMBOO, VIOLET)

        fun of(key: String?): ReplyTheme = ALL.firstOrNull { it.key == key } ?: DARK

        /** 只认 #RRGGBB；解析不出就用兜底色。带 alpha 的 #AARRGGBB 也接受。 */
        private fun parseColor(value: String?, fallback: Int): Int {
            if (value.isNullOrBlank()) return fallback
            return runCatching { Color.parseColor(value.trim()) }.getOrDefault(fallback)
        }

        /**
         * 从网页下发的这份 JSON 构造实际配色：
         * `{ "key": "dark", "custom": { "bar": "#223344", "barAlpha": 0.8, ... } }`
         *
         * 设计成「预设打底 + 逐项覆盖」：用户想一键换色就选预设，想细调就只覆盖某些项，
         * 没动到的仍跟随预设，不必把八项全存一遍。老版本只存一个主题键，这里也兼容。
         */
        fun fromJson(json: String?): ReplyTheme {
            val base = of(THEME_DEFAULT)
            if (json.isNullOrBlank()) return base
            val root = runCatching { JSONObject(json) }.getOrNull() ?: return base
            val theme = of(root.optString("key", THEME_DEFAULT))
            val custom = root.optJSONObject("custom") ?: return theme
            // barAlpha 与 bar 分开：条身底色只存 RGB，透明度单独一项，
            // 免得在 #RRGGBBAA 与 #AARRGGBB 两种写法之间来回出错。
            val alpha = custom.optDouble("barAlpha", -1.0)
                .takeIf { it in 0.0..1.0 }
                ?.let { (it * 255).toInt() } ?: -1
            val barColor = custom.optString("bar", "")
            val bar = if (barColor.isNotBlank() && alpha >= 0) {
                (alpha shl 24) or (parseColor(barColor, theme.bar and 0x00FFFFFF) and 0x00FFFFFF)
            } else if (barColor.isNotBlank()) {
                parseColor(barColor, theme.bar)
            } else if (alpha >= 0) {
                (alpha shl 24) or (theme.bar and 0x00FFFFFF)
            } else {
                theme.bar
            }
            return theme.copy(
                bar = bar,
                text = parseColor(custom.optString("text", ""), theme.text),
                hint = parseColor(custom.optString("hint", ""), theme.hint),
                accent = parseColor(custom.optString("accent", ""), theme.accent),
                sendText = parseColor(custom.optString("sendText", ""), theme.sendText),
                muted = parseColor(custom.optString("muted", ""), theme.muted),
            )
        }
    }
}

class CallOverlayService : Service() {

    companion object {
        private const val CH_OVERLAY = "shell_call_overlay"
        private const val NOTIF_ID = 3
        private const val PREFS = "call_overlay_prefs"

        const val ACTION_START = "app.floatphone.shell.OVERLAY_START"
        /** 切到后台：把预热好的窗口显示出来（不再从后台启动服务） */
        const val ACTION_SHOW = "app.floatphone.shell.OVERLAY_SHOW"
        /** 回到前台：把窗口藏起来，服务继续活着，下次切后台秒显 */
        const val ACTION_HIDE = "app.floatphone.shell.OVERLAY_HIDE"
        const val ACTION_UPDATE = "app.floatphone.shell.OVERLAY_UPDATE"
        const val ACTION_STOP = "app.floatphone.shell.OVERLAY_STOP"

        const val EXTRA_NAME = "name"
        const val EXTRA_AVATAR = "avatar"
        const val EXTRA_META = "meta"
        const val EXTRA_CALL_ID = "call_id"

        /**
         * 头像经 Intent 传不过去。
         *
         * Binder 事务上限约 1MB，而头像可能是几 MB 的 data URL（base64 还要再涨 1/3），
         * 直接 putExtra 会抛 TransactionTooLargeException，服务压根起不来——
         * 表现就是「浮窗不出现」，而失败原因只有翻诊断才看得到。
         * 这里把内联头像落成 cacheDir 里的文件，Intent 只带路径。
         *
         * http(s) 直链与已是路径的值原样返回。
         */
        fun prepareAvatarRef(context: Context, avatar: String): String {
            val value = avatar.trim()
            if (value.isEmpty()) return ""
            if (!value.startsWith("data:image/")) return value
            return runCatching {
                val comma = value.indexOf(',')
                if (comma < 0) return@runCatching ""
                val bytes = Base64.decode(value.substring(comma + 1), Base64.DEFAULT)
                // 固定文件名：每次覆盖，不会在缓存里越堆越多
                val file = File(context.cacheDir, "call_overlay_avatar.img")
                file.writeBytes(bytes)
                file.absolutePath
            }.getOrDefault("")
        }
        /** 网页传来的「已通话秒数」——浮窗是切出去才建的，不能从 0 自己数 */
        const val EXTRA_ELAPSED = "elapsed"

        /**
         * 快捷回复条配色（在网页侧「通话浮窗外观」里调，存 SharedPreferences）。
         *
         * 存的是网页下发的整份 JSON（预设键 + 逐项自定义），见 ReplyTheme.fromJson。
         * 旧版本这里只存一个主题键，读取时若发现不是 JSON 就按老格式兼容。
         */
        const val PREF_THEME = "overlay_theme"
        const val THEME_DEFAULT = "dark"
        /** 旧版遗留的纯主题键存储位（1.0.5 及以前），读取时兜底用 */
        private const val PREF_THEME_LEGACY = "overlay_theme_key"

        private const val MIN_W_DP = 88
        private const val MIN_H_DP = 120
        private const val MAX_W_DP = 320
        private const val MAX_H_DP = 460
        private const val DEFAULT_W_DP = 108
        private const val DEFAULT_H_DP = 150
        private const val EDGE_DP = 14

        @Volatile
        private var running = false

        /** 启动浮窗服务。返回是否真的起来了；失败原因记进 lastError 供诊断查看。 */
        fun start(context: Context, name: String, avatar: String, meta: String, callId: String, elapsedSeconds: Int): Boolean {
            val intent = Intent(context, CallOverlayService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_AVATAR, avatar)
                putExtra(EXTRA_META, meta)
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_ELAPSED, elapsedSeconds)
            }
            // 这里不能吞掉异常：Android 12+ 从后台启动前台服务会抛
            // ForegroundServiceStartNotAllowedException，正是「浮窗偶尔不出现」的成因，
            // 记下来才能在诊断面板里看到，而不是只看到一个不出现的浮窗。
            return runCatching {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
                true
            }.getOrElse { error ->
                recordError("startForegroundService", error)
                false
            }
        }

        fun update(context: Context, name: String, avatar: String, meta: String, elapsedSeconds: Int) {
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply {
                    action = ACTION_UPDATE
                    putExtra(EXTRA_NAME, name)
                    putExtra(EXTRA_AVATAR, avatar)
                    putExtra(EXTRA_META, meta)
                    putExtra(EXTRA_ELAPSED, elapsedSeconds)
                })
            }
        }

        fun stop(context: Context) {
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply { action = ACTION_STOP })
            }
        }

        /**
         * 更新「待发 N」角标。
         *
         * 走同进程实例直改，不另开 Intent 动作：角标是高频小改动（用户每发一条消息
         * 就要变一次），为它排队一个 Service Intent 既慢又没必要。实例不在（没在通话）
         * 时静默忽略。
         */
        fun updatePending(context: Context, count: Int) {
            liveInstance?.applyPendingCount(count)
        }

        /**
         * 显示浮窗（App 刚切到后台时调用）。
         *
         * 注意这里用 startService 而不是 startForegroundService：服务在通话接通时
         * 就已经在前台预热好了（见 ACTION_START 注释）。Android 12+ 禁止 App 在
         * 后台启动前台服务，而「切出去」正是后台——过去在这里调 startForegroundService，
         * 被系统拒绝、异常又被吞掉，表现就是「浮窗有时不弹，但声音照旧」。
         */
        fun show(context: Context) {
            // 优先同进程直接操作实例：绕开 Android 12+ 对后台启动服务的限制，
            // 也免掉 Intent 投递的时序竞态（竞态会让「刚接通就切出去」这一下落空）。
            val instance = liveInstance
            if (instance != null) {
                instance.main.post { instance.showOverlay(true) }
                return
            }
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply { action = ACTION_SHOW })
            }
        }

        /**
         * 宿主 Activity 进入后台（onStop）：把预热好的浮窗亮出来。
         *
         * 这是浮窗可见性的主路径，不再只依赖网页的 visibilitychange + 桥调用。
         * 原因：App 一退到后台，WebView 的 JS 随时会被系统冻结或节流，那条
         * 「网页通知原生显示」的链路本身就会断——表现正是「退出去以后浮窗不弹，
         * 但声音照旧」（放音在原生/媒体通道，不依赖网页）。而 Activity 的
         * onStop/onStart 是系统直接给的，不受 JS 是否还在跑影响。
         *
         * 实例不存在（当前没在通话、或预热失败）：什么都不做。此刻 App 已在
         * 后台，绝不能在这里 startForegroundService，系统会直接拒绝。
         */
        fun onHostBackground() {
            hostInForeground = false
            val instance = liveInstance ?: return
            instance.main.post { instance.showOverlay(true) }
        }

        /** 宿主 Activity 回到前台（onStart）：把浮窗藏起来，服务继续跑。 */
        fun onHostForeground() {
            hostInForeground = true
            val instance = liveInstance ?: return
            instance.main.post {
                instance.showOverlay(false)
                instance.removeReplyBar()
            }
        }

        /** 隐藏浮窗（回到 App 前台时调用）：服务继续活着，下次切出去秒显。 */
        fun hide(context: Context) {
            if (!running) return
            runCatching {
                context.startService(Intent(context, CallOverlayService::class.java).apply { action = ACTION_HIDE })
            }
        }

        /** 正在运行的实例：主题改动时用它把已弹出的回复条就地重绘。 */
        @Volatile
        private var liveInstance: CallOverlayService? = null

        /**
         * 宿主 Activity 是否在前台。
         *
         * 用于堵一个时序漏洞：用户拨号后立刻切走，那 3 秒接通动画结束时 App 已在
         * 后台，此刻 startForegroundService 会被 Android 12+ 拒绝、浮窗建不出来。
         * 有了这个标记，ACTION_START 就能判断「该不该立刻亮出来」——预热动作本身
         * 仍在通话屏挂载时（前台）完成，不受限制。
         */
        @Volatile
        private var hostInForeground = true

        /** 读取存下的配色 JSON（原始串，交给 ReplyTheme.fromJson 解析）。 */
        fun currentThemeJson(context: Context): String {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(PREF_THEME, null)
            // 老版本存的是裸键（dark/light…），转成新格式，保证升级后颜色不丢
            if (!raw.isNullOrBlank() && !raw.trimStart().startsWith("{")) {
                return "{\"key\":\"" + ReplyTheme.of(raw).key + "\"}"
            }
            if (raw.isNullOrBlank()) {
                val legacy = prefs.getString(PREF_THEME_LEGACY, null)
                if (!legacy.isNullOrBlank()) return "{\"key\":\"" + ReplyTheme.of(legacy).key + "\"}"
            }
            return raw ?: ""
        }

        /** 写入配色 JSON（网页侧「通话浮窗外观」下发），并让已弹出的回复条即时重绘。 */
        fun setThemeJson(context: Context, json: String) {
            runCatching {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(PREF_THEME, json).apply()
            }
            liveInstance?.applyThemeJson(json)
        }

        /** 浮窗权限是否已授予（Android 6+ 需用户在系统设置里手动开）。 */
        fun canDraw(context: Context): Boolean =
            Build.VERSION.SDK_INT < 23 || android.provider.Settings.canDrawOverlays(context)

        /**
         * 最近一次失败的描述。
         *
         * 浮窗这条链路上全是 runCatching——好处是不会因为浮窗异常拖垮通话，
         * 坏处是「不出现」时没有任何线索，只能靠猜。这里把最后一次失败原因记下来，
         * 经 debugInfo 传给网页，在「通话浮窗外观 → 诊断」里直接看。
         */
        @Volatile
        private var lastError: String = ""

        private fun recordError(where: String, error: Throwable) {
            lastError = "$where: ${error.javaClass.simpleName}: ${error.message}"
        }

        /**
         * 浮窗内部状态快照（JSON），给网页诊断面板用。
         *
         * 排查「浮窗怎么又不见了」要看的就是这几项：
         *   canDraw false        → 权限没给，系统不允许画浮层
         *   running false        → 服务没跑起来（多半是后台启动被系统拒了）
         *   hasInstance false    → 服务在跑但没有活动实例（通话没接到 START）
         *   windowAdded false    → 窗口没挂上（addView 失败，见 lastError）
         *   visible false        → 窗口挂上了但被藏起来（App 判定为前台）
         */
        fun debugInfo(context: Context): String {
            val instance = liveInstance
            return runCatching {
                JSONObject()
                    .put("canDraw", canDraw(context))
                    .put("running", running)
                    .put("hostInForeground", hostInForeground)
                    .put("hasInstance", instance != null)
                    .put("windowAdded", instance?.rootView != null)
                    .put("visible", instance?.overlayVisible == true)
                    .put("lastError", lastError)
                    .toString()
            }.getOrDefault("{}")
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var windowManager: WindowManager

    private var charName = ""
    private var avatarUrl = ""
    private var metaText = ""
    private var currentCallId = ""

    // 时长基准：网页把「已通话秒数」传进来，这里记下基准点，之后按墙钟推算。
    // 不自己从 0 开始数——浮窗是切到后台才创建的，从头数会和网页计时对不上。
    private var baseSeconds: Int = 0
    private var baseAtMillis: Long = 0L
    private var heartbeat: Thread? = null
    @Volatile private var stopped = false

    private val avatarClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private var avatarBitmap: Bitmap? = null
    private var lastAvatarUrl = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                // 通话一接通就在前台把服务暖好：窗口建出来但先藏着，切后台再亮。
                //
                // 为什么不是等到切出去再建：Android 12+ 禁止 App 从后台启动前台服务，
                // 而「用户切到别的 App」那一刻，本 App 恰好就在后台。过去直接在那时
                // startForegroundService，被系统拒绝、异常又被静默吞掉，浮窗就再也
                // 弹不出来（声音照旧，因为放音是 WebView 的事，不依赖浮窗）。
                charName = intent.getStringExtra(EXTRA_NAME).orEmpty()
                avatarUrl = intent.getStringExtra(EXTRA_AVATAR).orEmpty()
                metaText = intent.getStringExtra(EXTRA_META).orEmpty()
                currentCallId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty()
                running = true
                stopped = false
                // 登记实例：主题改动时要靠它把已弹出的回复条就地重绘
                liveInstance = this
                setElapsedBase(intent.getIntExtra(EXTRA_ELAPSED, 0))
                // 正常情况下预热只建窗口不显示，等切后台再亮；
                // 但若此刻 App 已在后台（拨号中途切走），就直接显示出来。
                showOverlay(visible = !hostInForeground)
                startHeartbeat()
            }
            ACTION_SHOW -> {
                // 切到后台：把预热好的窗口亮出来（服务早已在前台运行，
                // 这里只是改可见性，不涉及「后台启动前台服务」的限制）
                showOverlay(visible = true)
            }
            ACTION_HIDE -> {
                // 回到前台：只把窗口藏起来，服务继续跑，计时与自动搭话不断
                showOverlay(visible = false)
                removeReplyBar()
            }
            ACTION_UPDATE -> {
                val name = intent.getStringExtra(EXTRA_NAME).orEmpty()
                val meta = intent.getStringExtra(EXTRA_META).orEmpty()
                val avatar = intent.getStringExtra(EXTRA_AVATAR).orEmpty()
                charName = name
                metaText = meta
                // 页面在后台冻结时它对时长的认知会滞后；每次更新顺带校准基准，
                // 保证「通话记录里的时长」与浮窗显示的是同一个数。
                // 只在「网页给的值更大」时才校准基准。
                // 无条件覆盖会有个坑：页面在后台被系统冻结时，它报上来的秒数会停在旧值，
                // 每 10 秒一次的回灌于是把浮窗时间往回拽——用户看到的就是时长来回跳。
                if (intent.hasExtra(EXTRA_ELAPSED)) {
                    val reported = intent.getIntExtra(EXTRA_ELAPSED, 0)
                    if (reported > currentElapsed()) setElapsedBase(reported)
                }
                if (avatar != avatarUrl) {
                    avatarUrl = avatar
                    refreshAvatarAsync()
                }
                main.post { renderOverlay() }
            }
            ACTION_STOP -> {
                teardown()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    /** 记下时长基准：从现在起，已通话秒数 = base + 经过的墙钟时间。 */
    private fun setElapsedBase(seconds: Int) {
        baseSeconds = seconds.coerceAtLeast(0)
        baseAtMillis = System.currentTimeMillis()
    }

    /** 当前已通话秒数（按墙钟推算，不依赖心跳是否准点）。 */
    private fun currentElapsed(): Int = runCatching {
        baseSeconds + ((System.currentTimeMillis() - baseAtMillis) / 1000L).toInt()
    }.getOrDefault(baseSeconds)

    private fun teardown() {
        stopped = true
        running = false
        if (liveInstance === this) liveInstance = null
        heartbeat?.interrupt()
        heartbeat = null
        removeReplyBar()
        rootView?.let { view -> runCatching { windowManager.removeView(view) } }
        rootView = null
        stopForeground(true)
        stopSelf()
    }

    /**
     * 心跳：每秒把时长与 tick 事件推给网页。
     * 页面侧据此驱动通话计时与自动搭话，绕开后台 WebView 定时器被冻结的问题。
     * 页面已不可用（WebView 已销毁）时不再空转。
     */
    private fun startHeartbeat() {
        // 已在跑就不再起第二条：浮窗被反复 START 时，每来一次都新起线程的话，
        // 旧线程因为 stopped 被置回 false 而不会退出，心跳线程会越积越多。
        if (heartbeat?.isAlive == true) return
        heartbeat = Thread {
            while (!stopped && !Thread.currentThread().isInterrupted) {
                try { Thread.sleep(1000) } catch (e: InterruptedException) { break }
                if (stopped) break
                val elapsed = currentElapsed()
                // 时长由原生维护并刷新：网页被系统冻结时也照常走秒，不依赖回调
                main.post { renderMeta() }
                if (!ShellBus.isWebAlive()) continue
                ShellBus.dispatchOverlayEvent(
                    "tick",
                    JSONObject().put("seconds", elapsed).put("callId", currentCallId),
                )
            }
        }.also { it.name = "call-overlay-heartbeat"; it.start() }
    }

    // ── 通知 ──

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH_OVERLAY, "通话浮窗", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "通话期间在其他应用上层显示小窗"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun buildNotification(): android.app.Notification = buildOverlayNotification()

    private fun buildOverlayNotification(): android.app.Notification {
        val back = PendingIntent.getActivity(
            this, 71,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CH_OVERLAY)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(charName.ifBlank { "通话进行中" })
            .setContentText(if (metaText.isBlank()) "点按返回小手机" else "$metaText · 点按返回小手机")
            .setOngoing(true)
            .setContentIntent(back)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification() {
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildOverlayNotification()) }
    }

    // ── 浮窗几何 ──

    private var rootView: View? = null
    private var rootLayout: FrameLayout? = null
    /** 浮窗是否应该可见。预热时窗口已建好但先藏着，真正的显隐由它决定，
     *  这样「切后台」与「建窗口」两条时序谁先到都不会错。 */
    private var overlayVisible = false
    private var bgImage: ImageView? = null
    private var nameView: TextView? = null
    private var metaView: TextView? = null
    /** 左上角「待发 N」角标：网页侧队列里还有没轮到的消息时显示，
     *  让人知道话没丢、只是在等角色说完。和网页小窗的角标对齐。 */
    private var badgeView: TextView? = null
    /** 独立的快捷回复条（另一个 WindowManager 窗口，不与小窗共用） */
    private var replyWindow: View? = null
    private var replyInput: EditText? = null
    /** 条身与发送键：换主题时用它俩就地重绘，不必重开通话 */
    private var replyBar: LinearLayout? = null
    private var replySend: Button? = null
    /** 回复条自己的位置（可拖动），与通话小窗各记各的 */
    private var replyBarX = 0
    private var replyBarY = 0

    private var widthPx = 0
    private var heightPx = 0
    private var posX = 0
    private var posY = 0

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun clampGeometry() {
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val minW = dp(MIN_W_DP)
        val minH = dp(MIN_H_DP)
        val maxW = maxOf(minW, minOf(dp(MAX_W_DP), screenW - dp(EDGE_DP) * 2))
        val maxH = maxOf(minH, minOf(dp(MAX_H_DP), screenH - dp(EDGE_DP) * 2))
        widthPx = widthPx.coerceIn(minW, maxW)
        heightPx = heightPx.coerceIn(minH, maxH)
        posX = posX.coerceIn(dp(EDGE_DP), maxOf(dp(EDGE_DP), screenW - widthPx - dp(EDGE_DP)))
        posY = posY.coerceIn(dp(EDGE_DP), maxOf(dp(EDGE_DP), screenH - heightPx - dp(EDGE_DP)))
    }

    private fun loadGeometry() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val savedW = prefs.getInt("w", 0)
        val savedH = prefs.getInt("h", 0)
        val savedX = prefs.getInt("x", -1)
        val savedY = prefs.getInt("y", -1)
        widthPx = if (savedW > 0) savedW else dp(DEFAULT_W_DP)
        heightPx = if (savedH > 0) savedH else dp(DEFAULT_H_DP)
        posX = if (savedX >= 0) savedX else screenW - widthPx - dp(EDGE_DP)
        posY = if (savedY >= 0) savedY else screenH - heightPx - dp(260)
        clampGeometry()
    }

    private fun saveGeometry() {
        runCatching {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("w", widthPx).putInt("h", heightPx)
                .putInt("x", posX).putInt("y", posY)
                .apply()
        }
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        return WindowManager.LayoutParams(
            widthPx, heightPx, type, flags,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = posX
            y = posY
        }
    }

    private fun applyLayoutParams() {
        val view = rootView ?: return
        val params = (view.layoutParams as? WindowManager.LayoutParams) ?: return
        params.width = widthPx
        params.height = heightPx
        params.x = posX
        params.y = posY
        runCatching { windowManager.updateViewLayout(view, params) }
    }

    /**
     * 把浮窗挂到屏幕上。
     *
     * visible=false 时窗口建出来但先藏着——这是通话接通时的「预热」：此时 App 还在
     * 前台，启动前台服务不会被系统拒绝；等真正切到后台再 showOverlay(true) 亮出来。
     */
    private fun showOverlay(visible: Boolean = true) {
        if (!canDraw(this)) {
            // 没拿到浮窗权限：通知照常有（点它能回通话页），并告诉网页弹引导
            updateNotification()
            ShellBus.dispatchOverlayEvent("needPermission")
            return
        }
        overlayVisible = visible
        loadGeometry()
        main.post {
            if (rootView == null) {
                val layout = FrameLayout(this)
                buildContentView(layout)
                // 只有真挂上窗口才算建好。
                // 之前是先赋值 rootView 再 addView，异常还被静默吞掉：一旦 addView
                // 失败，rootView 就非空而窗口并不存在，之后每次 show 都只是去改一个
                // 没挂上的 View 的可见性——浮窗永远不出现，且没有任何报错。
                val added = runCatching { windowManager.addView(layout, buildLayoutParams()) }
                if (added.isFailure) {
                    rootLayout = null
                    added.exceptionOrNull()?.let { recordError("addView", it) }
                    ShellBus.dispatchOverlayEvent("needPermission")
                    return@post
                }
                rootLayout = layout
                rootView = layout
            }
            renderOverlay()
            refreshAvatarAsync()
            // 用最新意图而不是本次调用的入参：窗口是异步建的，这期间
            // 可能又来了 show/hide，按最新意图决定可见性才不会错。
            rootView?.visibility = if (overlayVisible) View.VISIBLE else View.GONE
        }
        updateNotification()
    }

    /** 构建浮窗内容：底图 + 压暗遮罩 + 底部信息 + 右下缩放柄 + 长按弹出的回复框。 */
    private fun buildContentView(layout: FrameLayout) {
        layout.removeAllViews()
        // 圆角矩形：窗口天生是矩形，给根布局铺一层圆角背景并开启 clipToOutline，
        // 子视图（底图、压暗遮罩、文字）会被裁进这个圆角里；圆角外没有背景即透明，
        // 看上去就是一块圆角矩形。
        layout.background = GradientDrawable().apply {
            cornerRadius = dp(16).toFloat()
            setColor(Color.parseColor("#1B1B22"))
        }
        layout.clipToOutline = true

        // 注意：底图不要挂 setOnClickListener。
        // ImageView 可点击时会消费触摸事件，父容器（浮窗根布局）的拖动监听
        // 就永远收不到 DOWN/MOVE，表现为「只能缩放、拖不动，一按还跳回 App」。
        // 「轻点回前台」的判定统一放进 attachDrag 的抬手逻辑里。
        bgImage = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#1B1B22"))
            isClickable = false
            isFocusable = false
        }
        layout.addView(bgImage, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        // 压暗遮罩：白字在任何底图上都读得清
        layout.addView(View(this).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(Color.parseColor("#CC000000"), Color.parseColor("#00000000")),
            )
            isClickable = false
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))

        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(8), dp(4), dp(8), dp(7))
            isClickable = false
        }
        nameView = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setShadowLayer(4f, 0f, 1f, Color.parseColor("#99000000"))
        }
        metaView = TextView(this).apply {
            setTextColor(Color.parseColor("#E0FFFFFF"))
            textSize = 10.5f
            gravity = Gravity.CENTER
            maxLines = 2
            setShadowLayer(4f, 0f, 1f, Color.parseColor("#99000000"))
        }
        info.addView(nameView)
        info.addView(metaView)
        layout.addView(info, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))

        // 左上角「待发 N」角标。
        // 之前只有网页小窗有，切到原生浮窗后从回复条发的消息在排队时毫无提示，
        // 用户以为消息丢了。这里补齐，和网页小窗行为一致。
        badgeView = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 10f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(7), dp(3), dp(7), dp(3))
            background = GradientDrawable().apply {
                cornerRadius = dp(9).toFloat()
                setColor(Color.parseColor("#CC000000"))
            }
            visibility = View.GONE
            isClickable = false
            isFocusable = false
        }
        layout.addView(badgeView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.START,
        ).apply {
            setMargins(dp(7), dp(7), 0, 0)
        })

        // 右下角缩放柄
        val handle = View(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#40FFFFFF"))
            }
        }
        layout.addView(handle, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, dp(5), dp(5))
        })
        attachResize(handle, layout)

        // 快捷回复条不放在小窗里，而是长按时另开一个独立的窄条窗口（见 openReplyBar）。
        // 原因：小窗最窄只有 88dp，塞一个输入框进去字都看不清；独立窗口还能
        // 单独申请输入焦点、唤起键盘，也能各自记忆拖到的位置。

        attachDrag(layout)
    }

    // ── 渲染 ──

    /**
     * 点浮窗 → 把小手机拉回前台并通知网页恢复全屏。
     * 「拉前台」只能原生做（网页改不了自己的前后台）；先派事件再拉起，
     * 页面收到事件时已在前台，切回全屏不会有延迟感。
     */
    private fun bringAppToFront() {
        ShellBus.dispatchOverlayEvent("restore", JSONObject().put("callId", currentCallId))
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    /** 把 {{time}} 占位替换成原生计时，网页只需在 meta 里写 {{time}} */
    private fun renderMeta() {
        val total = currentElapsed()
        val minutes = total / 60
        val seconds = total % 60
        val stamp = "%02d:%02d".format(minutes, seconds)
        metaView?.text = metaText.replace("{{time}}", stamp)
    }

    private fun renderOverlay() {
        nameView?.text = charName.ifBlank { "通话" }
        renderMeta()
        val bitmap = avatarBitmap
        if (bitmap != null) {
            bgImage?.setImageBitmap(bitmap)
        } else {
            bgImage?.setImageDrawable(null)
            bgImage?.setBackgroundColor(Color.parseColor("#2A2F3A"))
        }
    }

    /** 拉取头像（本地文件路径 / data: 内联 / http(s) 直链），失败退回纯色底。 */
    private fun refreshAvatarAsync() {
        val url = avatarUrl.trim()
        if (url.isEmpty() || url == lastAvatarUrl) return
        lastAvatarUrl = url
        // 本地文件与 data URL 都能立刻解出来，不必开线程
        if (url.startsWith("data:image/") || !url.startsWith("http")) {
            avatarBitmap = decodeLocalAvatar(url)
            main.post { renderOverlay() }
            return
        }
        Thread {
            val bitmap = runCatching {
                if (!url.startsWith("http://") && !url.startsWith("https://")) return@runCatching null
                val request = Request.Builder().url(url).build()
                avatarClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@runCatching null
                    val bytes = response.body?.bytes() ?: return@runCatching null
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            }.getOrNull()
            if (bitmap != null) {
                avatarBitmap = bitmap
                main.post { renderOverlay() }
            }
        }.also { it.name = "call-overlay-avatar"; it.start() }
    }

    private fun decodeDataUrl(dataUrl: String): Bitmap? = runCatching {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return@runCatching null
        val header = dataUrl.substring(0, comma)
        if (!header.contains("base64", ignoreCase = true)) return@runCatching null
        val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    /**
     * 解析本地头像：cacheDir 里的文件，或仍以 data URL 形式传进来的（老路径）。
     * 解码时按需降采样——浮窗最宽才 320dp，没必要为一个小窗解一张几千万像素的图。
     */
    private fun decodeLocalAvatar(pathOrDataUrl: String): Bitmap? = runCatching {
        if (pathOrDataUrl.startsWith("data:image/")) return@runCatching decodeDataUrl(pathOrDataUrl)
        val file = File(pathOrDataUrl)
        if (!file.exists()) return@runCatching null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(pathOrDataUrl, bounds)
        if (bounds.outWidth <= 0) return@runCatching null
        var sample = 1
        while (bounds.outWidth / sample > 1024) sample *= 2
        BitmapFactory.decodeFile(pathOrDataUrl, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    // ── 拖动 ──

    private fun attachDrag(layout: FrameLayout) {
        var downX = 0f
        var downY = 0f
        var originX = 0
        var originY = 0
        var moved = false
        var longPressFired = false

        // 长按用延时任务判定，而不是抬手时看按住时长：
        // 这样按住约半秒就立刻弹出输入条，不用等手指抬起。
        val longPressRunnable = Runnable {
            longPressFired = true
            openReplyBar()
        }

        layout.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    originX = posX
                    originY = posY
                    moved = false
                    longPressFired = false
                    main.postDelayed(longPressRunnable, 480)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!moved && Math.abs(dx) + Math.abs(dy) > dp(5)) {
                        moved = true
                        // 一旦移动就取消长按：拖动时不该弹出输入条
                        main.removeCallbacks(longPressRunnable)
                    }
                    if (moved) {
                        posX = originX + dx.toInt()
                        posY = originY + dy.toInt()
                        clampGeometry()
                        applyLayoutParams()
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longPressRunnable)
                    if (moved) {
                        saveGeometry()
                    } else if (!longPressFired) {
                        // 既没拖动也没长按 = 轻点：才回前台
                        bringAppToFront()
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** 右下角拖拽缩放：同步改窗口尺寸与位置基准。 */
    private fun attachResize(handle: View, layout: FrameLayout) {
        var downX = 0f
        var downY = 0f
        var originW = 0
        var originH = 0
        handle.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    originW = widthPx
                    originH = heightPx
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    widthPx = originW + (event.rawX - downX).toInt()
                    heightPx = originH + (event.rawY - downY).toInt()
                    clampGeometry()
                    applyLayoutParams()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    saveGeometry()
                    true
                }
                else -> false
            }
        }
    }

    // ── 快捷回复（独立窄条窗口，可拖动） ──

    /**
     * 长按浮窗时弹出：一个独立的输入条，发完自动收起。
     *
     * 单独开窗口而不是塞进小窗，是为了四件事：
     * 1. 小窗最窄只有 88dp，输入框塞进去字看不见；
     * 2. 独立窗口可以申请输入焦点并唤起键盘（小窗是 FLAG_NOT_FOCUSABLE）；
     * 3. 只占一条宽度，不遮挡用户正在看的别的内容；
     * 4. 可以自己记住被拖到的位置，和通话小窗互不干扰。
     */
    private fun openReplyBar() {
        val existing = replyWindow
        if (existing != null) {
            existing.visibility = View.VISIBLE
            replyInput?.requestFocus()
            showIme(replyInput)
            return
        }

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val barHeight = dp(56)
        val screenH = resources.displayMetrics.heightPixels
        val screenW = resources.displayMetrics.widthPixels
        replyBarX = prefs.getInt("reply_x", 0)
        replyBarY = prefs.getInt("reply_y", screenH - barHeight - dp(90))

        val theme = ReplyTheme.fromJson(currentThemeJson(this))

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            // 底色由 paintReplyTheme 按当前配色刷上，这里不写死，免得第一帧闪默认色
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        replyInput = EditText(this).apply {
            hint = "说点什么…"
            textSize = 14f
            maxLines = 1
            background = null
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) {
                    submitReply()
                    true
                } else false
            }
        }
        val send = Button(this).apply {
            text = "发送"
            textSize = 13f
            setPadding(dp(14), dp(6), dp(14), dp(6))
            setOnClickListener { submitReply() }
        }
        // 回复条只留「发送」和「收起」。
        // 原先还有个「回到通话」——用户反馈条上不要它：想回全屏直接轻点浮窗即可，
        // 一条窄条上挤三个按钮反而容易点错。
        val close = Button(this).apply {
            text = "收起"
            textSize = 13f
            background = null
            setOnClickListener { removeReplyBar() }
        }
        bar.addView(replyInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(send, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        bar.addView(close, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        replyBar = bar
        replySend = send
        paintReplyTheme(theme)

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        // 要能打字，就不能带 FLAG_NOT_FOCUSABLE；
        // 带 FLAG_NOT_TOUCH_MODAL 则点到条外不会传给本窗口，别处照常可点。
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = replyBarX
            y = replyBarY
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE
        }

        // 拖动：按住条身移动。返回 false 让子控件（输入框/按钮）照常拿到事件，
        // 否则输入框没法选中文字、移动光标。
        var barDownX = 0f
        var barDownY = 0f
        var barOriginX = 0
        var barOriginY = 0
        var barMoved = false
        bar.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    barDownX = event.rawX
                    barDownY = event.rawY
                    barOriginX = replyBarX
                    barOriginY = replyBarY
                    barMoved = false
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - barDownX
                    val dy = event.rawY - barDownY
                    if (!barMoved && Math.abs(dx) + Math.abs(dy) > dp(5)) barMoved = true
                    if (barMoved) {
                        replyBarX = (barOriginX + dx.toInt()).coerceIn(0, maxOf(0, screenW - dp(60)))
                        replyBarY = (barOriginY + dy.toInt()).coerceIn(0, maxOf(0, screenH - barHeight))
                        params.x = replyBarX
                        params.y = replyBarY
                        runCatching { windowManager.updateViewLayout(bar, params) }
                    }
                    barMoved
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (barMoved) {
                        runCatching {
                            prefs.edit().putInt("reply_x", replyBarX).putInt("reply_y", replyBarY).apply()
                        }
                    }
                    barMoved
                }
                else -> false
            }
        }

        main.post {
            runCatching {
                windowManager.addView(bar, params)
                replyWindow = bar
                replyInput?.requestFocus()
                showIme(replyInput)
            }
        }
    }

    /** 更新「待发 N」角标；count <= 0 时隐藏。非主线程调用会自行切回主线程。 */
    private fun applyPendingCount(count: Int) {
        main.post {
            val badge = badgeView ?: return@post
            if (count <= 0) {
                badge.visibility = View.GONE
            } else {
                badge.text = "待发 $count"
                badge.visibility = View.VISIBLE
            }
        }
    }

    /** 移除回复条（隐藏并释放窗口） */
    private fun removeReplyBar() {
        val view = replyWindow ?: return
        replyWindow = null
        replyInput = null
        replyBar = null
        replySend = null
        main.post { runCatching { windowManager.removeView(view) } }
    }

    /** 给回复条刷上主题色。换主题时也会调它，所以分出来单独一个方法。 */
    private fun paintReplyTheme(theme: ReplyTheme) {
        val bar = replyBar ?: return
        bar.setBackgroundColor(theme.bar)
        replyInput?.setTextColor(theme.text)
        replyInput?.setHintTextColor(theme.hint)
        replySend?.setTextColor(theme.sendText)
        replySend?.background = GradientDrawable().apply {
            cornerRadius = dp(8).toFloat()
            setColor(theme.accent)
        }
        // 「收起」在布局里是第 3 个子控件（前两个是输入框和发送）
        for (index in 2 until bar.childCount) {
            (bar.getChildAt(index) as? Button)?.setTextColor(theme.muted)
        }
    }

    /** 配色变了：已弹出的回复条就地重绘（网页侧调完立刻能看到效果）。 */
    private fun applyThemeJson(json: String) {
        val theme = ReplyTheme.fromJson(json)
        main.post { paintReplyTheme(theme) }
    }

    private fun showIme(target: EditText?) {
        val view = target ?: return
        runCatching {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.showSoftInput(view, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
    }

    /** 发送后自动收起输入条——用户要的就是「发完就消失，不占屏幕」。 */
    private fun submitReply() {
        val text = replyInput?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        // 送给网页，按「用户发言」走一趟正常对话轮（会落聊天记录、触发角色回复）
        ShellBus.dispatchOverlayEvent("reply", JSONObject().put("text", text).put("callId", currentCallId))
        removeReplyBar()
    }
}
