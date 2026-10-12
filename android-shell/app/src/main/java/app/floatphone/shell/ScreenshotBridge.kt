package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import android.view.Display
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 截屏桥：把用户此刻的真实屏幕画面交给网页（进而交给角色）。
 *
 * 为什么走无障碍服务而不是 MediaProjection：
 *   MediaProjection 每次都要弹一个「开始录制或投射」的系统授权框，用户必须
 *   手动确认再点一次——对一个「角色想看一眼你在干嘛」的轻动作来说代价太大。
 *   Android 11 (API 30) 起 AccessibilityService.takeScreenshot() 可以在
 *   **无障碍已授权的前提下直接取到画面**，代价是必须让用户先开无障碍服务
 *   （本项目的通话浮窗保活本来就需要它，所以不算额外负担）。
 *
 * 设计边界（改这个文件前先读）：
 *  - **不做隐蔽截屏**：只提供「调一次截一张」，没有定时、没有后台、没有监听。
 *    截之前由网页侧明确提示用户，这里不替网页做任何判断。
 *  - **只在本机流转**：原生只把画面交回网页，存不存、给不给角色看由网页决定
 *    （见 lib/screenshot/），原生不上传任何地方。
 *  - **失败必须说清**：取不到画面时如实返回原因（版本太低 / 无障碍没开 /
 *    系统拒绝 / 太频繁），绝不返回一张空白图冒充成功。
 *  - 结果是**异步**的：takeScreenshot 本身是回调式 API，所以 capture() 只回
 *    「是否受理」，真正的画面经 ShellBus 的 'screenshot' 事件推回网页。
 */
object ScreenshotBridge {

    /**
     * 当前挂着的无障碍服务实例。CallControlService 连上/断开时在这里登记。
     * 必须借它的实例——takeScreenshot() 是 AccessibilityService 的方法。
     */
    @Volatile
    private var service: AccessibilityService? = null

    /** 截屏进行中。takeScreenshot 有调用间隔限制，连点只会白白撞系统拒绝。 */
    @Volatile
    private var capturing = false

    /** 回调线程：缩图与 PNG 编码不该占主线程。 */
    private val executor: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "screenshot-bridge").apply { isDaemon = true }
        }
    }

    /**
     * 输出画面的宽度上限（等比缩放，不裁剪）。
     *
     * 全屏原图在 1440 宽的手机上是数 MB 的 PNG，base64 还要再涨三分之一，
     * 经 evaluateJavascript 推回网页时既慢又占内存；720 宽足够看清界面内容。
     */
    private const val MAX_WIDTH = 720

    /** 由 CallControlService 调用：登记或注销可用实例。 */
    fun attach(target: AccessibilityService?) {
        service = target
        // 服务断开时把进行中标志清掉，否则重连后第一次截屏会被误判成「上一张还没完」。
        if (target == null) capturing = false
    }

    /** 能不能截。真正成不成还要看 takeScreenshot 的回调。 */
    fun canCapture(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && service != null

    /** 无障碍服务是否已开（截屏的唯一前提）。 */
    fun isAccessibilityOn(): Boolean = service != null

    /** 能力与状态快照，给设置面板显示三态。 */
    fun capabilitiesJson(): String = JSONObject()
        .put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        .put("accessibilityOn", service != null)
        .put("ready", canCapture())
        .toString()

    // ── 诊断留痕 ────────────────────────────────────────────
    //
    // 截屏这条链路上「点了没反应」最难查：系统 API 全是回调式，失败分支又被
    // 兜底吞掉，用户只看得到「什么都没发生」。这里把关键节点记下来，
    // 设置页的诊断面板直接读，不必连 USB 调试。
    //
    // 只记状态与尺寸，**绝不记画面内容**——留痕里不会出现任何截图数据。

    /** 最近一次失败原因（空串 = 没记到失败）。 */
    @Volatile
    private var lastError: String = ""

    /** 最近一次截屏的时刻（毫秒）；0 = 从未截过。 */
    @Volatile
    private var lastCaptureAt: Long = 0L

    /** 最近一次截屏是否成功。 */
    @Volatile
    private var lastCaptureOk: Boolean = false

    /** 最近一次截屏的补充说明（成功记尺寸体积，失败记原因）。 */
    @Volatile
    private var lastCaptureNote: String = ""

    /** 累计截屏次数（成功 + 失败）。 */
    @Volatile
    private var captureCount: Int = 0

    private fun recordFailure(where: String, reason: String) {
        lastError = "$where: $reason"
        lastCaptureAt = System.currentTimeMillis()
        lastCaptureOk = false
        lastCaptureNote = reason
        captureCount += 1
    }

    /** 诊断快照：截屏桥的内部状态，给设置页的「诊断」面板读。 */
    fun diagnosticsJson(): String = JSONObject()
        .put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        .put("accessibilityOn", service != null)
        .put("ready", canCapture())
        .put("capturing", capturing)
        .put("lastError", lastError)
        .put("lastCaptureAt", lastCaptureAt)
        .put("lastCaptureOk", lastCaptureOk)
        .put("lastCaptureNote", lastCaptureNote)
        .put("captureCount", captureCount)
        .toString()

    /**
     * 发起一次截屏。
     *
     * @return `{"ok":true,"accepted":true}` 表示已经交给系统；
     *         画面稍后经 ShellBus 的 'screenshot' 事件推回网页
     *         （成功带 base64/width/height，失败带 reason）。
     */
    fun capture(): JSONObject {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return fail("系统版本太低，截屏需要 Android 11 及以上")
        }
        if (service == null) return fail("无障碍服务没有开启，截屏无法进行")
        if (capturing) return fail("上一张还没截完，请稍等一下")

        captureBitmap { bitmap, error ->
            if (bitmap == null) {
                val reason = error ?: "截屏失败"
                recordFailure("capture", reason)
                publish(JSONObject().put("ok", false).put("reason", reason))
                return@captureBitmap
            }
            encodeAndPublish(bitmap)
        }
        return JSONObject().put("ok", true).put("accepted", true)
    }

    /** 记住一次成功的截屏（尺寸与体积，不含画面）。 */
    private fun recordSuccess(width: Int, height: Int, bytes: Int) {
        lastCaptureAt = System.currentTimeMillis()
        lastCaptureOk = true
        lastCaptureNote = "${width}×${height} · ${bytes / 1024} KB"
        captureCount += 1
    }

    /**
     * 只取一张原始位图（已等比缩到 MAX_WIDTH 以内），交给调用方处置。
     *
     * 查岗浮层复用它：先拿到图给用户过目，用户点头才编码外发——
     * 「不给」的那条路上，这张位图从头到尾没有变成过 base64。
     *
     * @param onResult 失败时 bitmap 为 null、error 为人话原因；可能同步回调。
     */
    fun captureBitmap(onResult: (Bitmap?, String?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            onResult(null, "系统版本太低，截屏需要 Android 11 及以上")
            return
        }
        val svc = service
        if (svc == null) {
            onResult(null, "无障碍服务没有开启，截屏无法进行")
            return
        }
        if (capturing) {
            onResult(null, "上一张还没截完，请稍等一下")
            return
        }
        capturing = true
        try {
            svc.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                executor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        capturing = false
                        onResult(bitmapFrom(result), null)
                    }

                    override fun onFailure(errorCode: Int) {
                        capturing = false
                        onResult(null, failureReason(errorCode))
                    }
                },
            )
        } catch (e: Throwable) {
            // 有些 ROM 把 takeScreenshot 收紧了，或无障碍被中途关掉；
            // 如实回报，并且一定要把 capturing 标志放掉。
            capturing = false
            onResult(null, e.message ?: "发起截屏失败")
        }
    }

    /** 把 ScreenshotResult 转成软件位图并等比缩小；失败返回 null。 */
    private fun bitmapFrom(result: AccessibilityService.ScreenshotResult): Bitmap? {
        val buffer = result.hardwareBuffer
        return try {
            // wrapHardwareBuffer 给的是 GPU 上的位图，缩放/编码前先复制成软件位图：
            // hardware bitmap 上直接做缩放会抛异常。
            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return null
            val software = hardware.copy(Bitmap.Config.ARGB_8888, false) ?: return null
            scaleDown(software)
        } catch (e: Throwable) {
            null
        } finally {
            // HardwareBuffer 不关会一直占着图形内存，截几次就能把机器拖垮。
            runCatching { buffer.close() }
        }
    }

    /** 把位图编码成 PNG 并推回网页。 */
    private fun encodeAndPublish(bitmap: Bitmap) {
        try {
            val png = ByteArrayOutputStream()
            val bytes = try {
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)) {
                    publish(JSONObject().put("ok", false).put("reason", "无法编码屏幕画面"))
                    return
                }
                png.toByteArray()
            } finally {
                runCatching { png.close() }
            }
            recordSuccess(bitmap.width, bitmap.height, bytes.size)
            publish(
                JSONObject()
                    .put("ok", true)
                    .put("width", bitmap.width)
                    .put("height", bitmap.height)
                    .put("bytes", bytes.size)
                    .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)),
            )
        } catch (e: Throwable) {
            val reason = e.message ?: "处理屏幕画面失败"
            recordFailure("encode", reason)
            publish(JSONObject().put("ok", false).put("reason", reason))
        }
    }

    /** 等比缩到 MAX_WIDTH 以内；本来就够小就原样返回。 */
    private fun scaleDown(source: Bitmap): Bitmap {
        if (source.width <= MAX_WIDTH) return source
        val ratio = MAX_WIDTH.toFloat() / source.width
        val height = (source.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(source, MAX_WIDTH, height, true)
    }

    /** 系统失败码 → 人话。绝不把错误码糊到用户脸上。 */
    private fun failureReason(errorCode: Int): String = when (errorCode) {
        AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS ->
            "系统拒绝了截屏：无障碍服务没有截屏权限"
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT ->
            "截屏太频繁了，过一会儿再试"
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY ->
            "屏幕不可用（可能正处在息屏或投屏切换中）"
        else -> "截屏失败（错误码 $errorCode）"
    }

    private fun publish(payload: JSONObject) {
        ShellBus.dispatchOverlayEvent("screenshot", payload)
    }

    private fun fail(reason: String): JSONObject = JSONObject().put("ok", false).put("reason", reason)
}
