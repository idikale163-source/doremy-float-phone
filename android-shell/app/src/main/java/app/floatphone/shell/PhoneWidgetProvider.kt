package app.floatphone.shell

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Bundle
import android.widget.RemoteViews

/**
 * 桌面小组件：在桌面上显示角色留下的话。
 *
 * 实现方式（改之前先读）：
 *   小组件本身**只放一个 ImageView**，图由 PhoneWidgetRenderer 用离屏 WebView
 *   渲染网页模板得到。为什么绕这一圈：Android 的 RemoteViews 只允许
 *   LinearLayout/TextView/ImageView 这类基础控件，写不了 CSS——
 *   而用户要的正是「自己排版、自己写样式」，只能靠网页渲染成图。
 *   代价：图里不能有独立可点的按钮，整块点一下是打开小手机。
 *
 * 更新时机：
 *   · 网页侧内容一变 → widgetUpdate → renderAndPush → updateAll（立刻，无频率限制）；
 *   · 系统定时（updatePeriodMillis，最快 30 分钟）→ onUpdate → 用缓存 HTML 重画。
 *   后者是「小手机完全关闭」时的兜底。
 */
class PhoneWidgetProvider : AppWidgetProvider() {

    companion object {
        /** 尺寸信息从 RemoteViews 拿不到，用户在设置页配的值由网页传来。
         *  这里存一份，供 onUpdate（系统定时，网页不在场）重画时用。 */
        private const val PREFS = "shell_phone_widget"
        private const val KEY_W = "width_dp"
        private const val KEY_H = "height_dp"
        private const val KEY_SCALE = "scale"

        fun saveSize(context: Context, widthDp: Int, heightDp: Int, scale: Int) {
            runCatching {
                context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putInt(KEY_W, widthDp)
                    .putInt(KEY_H, heightDp)
                    .putInt(KEY_SCALE, scale)
                    .apply()
            }
        }

        fun loadSize(context: Context): Triple<Int, Int, Int> {
            val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return Triple(
                prefs.getInt(KEY_W, 300),
                prefs.getInt(KEY_H, 150),
                prefs.getInt(KEY_SCALE, 2),
            )
        }

        /** 桌面上是否已经放了至少一个本小组件实例。 */
        fun isPlaced(context: Context): Boolean {
            return runCatching {
                val manager = AppWidgetManager.getInstance(context)
                manager.getAppWidgetIds(ComponentName(context, PhoneWidgetProvider::class.java)).isNotEmpty()
            }.getOrDefault(false)
        }

        /**
         * 拉起系统的「添加到桌面」引导。
         * Android 8+ 用 requestPinAppWidget；更低版本降级为提示用户手动添加。
         */
        fun requestPin(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O && manager.isRequestPinAppWidgetSupported) {
                    val provider = ComponentName(context, PhoneWidgetProvider::class.java)
                    manager.requestPinAppWidget(provider, null, null)
                }
            }
        }

        /** 刷新桌面上所有实例。内容更新后调用。 */
        fun updateAll(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(ComponentName(context, PhoneWidgetProvider::class.java))
                for (id in ids) {
                    updateOne(context, manager, id)
                }
            }
        }

        /** 画一个实例：读渲染好的 PNG，贴进 RemoteViews。 */
        fun updateOne(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.phone_widget)
            val file = PhoneWidgetRenderer.pngFile(context)
            val bitmap = if (file.exists()) runCatching { BitmapFactory.decodeFile(file.absolutePath) }.getOrNull() else null
            if (bitmap != null) {
                views.setImageViewBitmap(R.id.widget_image, bitmap)
            } else {
                // 还没渲染过：放占位图，不要显示成空白块
                views.setImageViewResource(R.id.widget_image, R.drawable.appicon)
            }

            // 整块可点：打开小手机。用包名显式构造 Intent，避免被别家 App 截获。
            val launch = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pending = PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.widget_image, pending)
            manager.updateAppWidget(widgetId, views)
        }
    }

    /** 系统定时触发（最快 30 分钟一次）：用缓存 HTML 重画，不联网。 */
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, manager, appWidgetIds)
        val (w, h, scale) = loadSize(context)
        // 用缓存重画一次，让图跟上尺寸改动；随后立刻贴图（渲染是异步的，
        // 这里先把现有 PNG 贴上去，等渲染完成后的 updateAll 再刷新一次）。
        PhoneWidgetRenderer.renderCached(context, w, h, scale)
        for (id in appWidgetIds) updateOne(context, manager, id)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        super.onAppWidgetOptionsChanged(context, manager, appWidgetId, newOptions)
        // 用户拖动了小组件尺寸：用新尺寸重画。用户配的 dp 仍是基准，
        // 这里只让渲染跟上系统给的框（超出的部分会被裁掉，不做拉伸以免变形）。
        val minW = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
        val minH = newOptions.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
        if (minW > 0 && minH > 0) {
            val (_, _, scale) = loadSize(context)
            PhoneWidgetRenderer.renderCached(context, minW, minH, scale)
        }
        updateOne(context, manager, appWidgetId)
    }
}
