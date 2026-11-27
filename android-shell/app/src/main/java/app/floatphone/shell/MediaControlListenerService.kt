package app.floatphone.shell

import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService

/**
 * 一个「什么都不做」的通知监听服务。
 *
 * 为什么需要它：Android 只允许两类应用读取活跃媒体会话（MediaSessionManager.getActiveSessions）——
 * 系统签名的应用，和持有「通知使用权」的应用。拿到活跃会话之后才能：
 *   · 通过 MediaController 直接下发播放/暂停，比盲发媒体按键可靠得多；
 *   · 读回当前播放状态，确认指令到底有没有生效。
 *
 * 它**不读任何通知内容**：onNotificationPosted / onNotificationRemoved 都刻意不重写，
 * 系统推送来的通知正文在这里从头到尾没有被碰过。存在的唯一目的，是让
 * MediaSessionManager 认这个调用方有资格。
 */
class MediaControlListenerService : NotificationListenerService() {

    companion object {
        @Volatile
        private var instance: MediaControlListenerService? = null

        /** 当前连接实例；用户没授权、或系统还没绑定时为 null。 */
        fun current(): MediaControlListenerService? = instance

        /** 传给 MediaSessionManager.getActiveSessions 的调用标识。 */
        fun tokenFor(context: Context): ComponentName =
            ComponentName(context, MediaControlListenerService::class.java)
    }

    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        // 只清自己：断开回调可能来自另一个实例，无脑置 null 会把新连接抹掉
        if (instance === this) instance = null
    }
}
