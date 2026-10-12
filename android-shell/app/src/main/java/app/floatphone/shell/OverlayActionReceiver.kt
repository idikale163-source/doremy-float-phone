package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 浮窗通知上的动作（以及未来可能的浮窗快捷操作）。
 *
 * 为什么用广播而不是直接把逻辑写在 Service 里：通知的 action 按钮由系统在
 * 应用进程之外触发，指向 Service 的逻辑不好写（且 Android 12+ 对从通知启动
 * 前台服务有额外限制）。走一个静态注册的 Receiver 最稳，它只做「转发给网页」，
 * 不持有任何状态。
 */
class OverlayActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_HANGUP = "app.floatphone.shell.OVERLAY_HANGUP"
        const val ACTION_RESTORE = "app.floatphone.shell.OVERLAY_RESTORE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_HANGUP -> ShellBus.dispatchOverlayEvent("hangup")
            ACTION_RESTORE -> ShellBus.dispatchOverlayEvent("restore")
        }
    }
}
