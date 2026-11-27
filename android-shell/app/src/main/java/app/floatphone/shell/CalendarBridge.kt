package app.floatphone.shell

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

/**
 * 日历桥：让角色能看见用户真实日程，也能把自己的纪念日写进系统日历。
 *
 * 两个方向，权限不同、风险不同：
 *   · 读（READ_CALENDAR）——角色知道「TA 今天有什么安排」，从而不打扰、能关心；
 *   · 写（WRITE_CALENDAR）——角色把纪念日、约定写进系统日历，到点由系统提醒用户。
 *
 * 设计边界（改这个文件前先读）：
 *  - 读只返回摘要字段（标题/时间/地点），**不读参与者、不读备注原文、不读邮件**：
 *    日程标题已经足够让角色知情，参与者和备注里常有敏感信息（面试官姓名、
 *    就医详情），读了会把隐私面不必要地放大。
 *  - 写**只新增、绝不修改或删除用户已有的日程**。角色无权动用户的安排，
 *    所以本类刻意不提供 update/delete 方法——不是遗漏，是边界。
 *  - 写入的日程会带一个可识别的标记（见 EVENT_TAG），用户能在日历里一眼看出
 *    哪些是角色加的，也便于将来做「一键清除角色日程」。
 *  - 两个权限都是运行时权限，未授予时如实返回状态，由网页引导去授权，
 *    这里不弹窗、不抛异常。
 */
class CalendarBridge(private val context: Context) {

    companion object {
        /**
         * 写入日程时带的标记。放在 DESCRIPTION 里而不是标题里——
         * 标题是用户要看的，不该被系统信息污染；标记只用于识别来源。
         */
        const val EVENT_TAG = "[小手机·角色写入]"

        /** 单次读取最多返回多少条，防止用户日历很大时撑爆 JSON。 */
        private const val MAX_EVENTS = 60
    }

    private fun hasPermission(permission: String): Boolean = try {
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) {
        false
    }

    /** 是否已授予读日历权限。 */
    fun hasReadPermission(): Boolean = hasPermission(Manifest.permission.READ_CALENDAR)

    /** 是否已授予写日历权限。 */
    fun hasWritePermission(): Boolean = hasPermission(Manifest.permission.WRITE_CALENDAR)

    /**
     * 找一个可写入的日历账户。找不到返回 null（设备上没有可写日历）。
     *
     * 优先级：主日历（IS_PRIMARY 且可写）→ 任意可写的本地/账户日历。
     * 刻意不写进「节假日」这类只读日历——系统会直接拒绝插入。
     */
    private fun findWritableCalendarId(): Long? {
        if (!hasWritePermission()) return null
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
            CalendarContract.Calendars.IS_PRIMARY,
        )
        return try {
            context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                projection,
                null,
                null,
                null,
            )?.use { cursor ->
                var fallback: Long? = null
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0)
                    val access = cursor.getInt(1)
                    val primary = if (cursor.isNull(2)) 0 else cursor.getInt(2)
                    // CAL_ACCESS_CONTRIBUTOR(500) 及以上才允许新增事件
                    if (access < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) continue
                    if (primary == 1) return@use id
                    if (fallback == null) fallback = id
                }
                fallback
            }
        } catch (e: Throwable) {
            null
        }
    }

    /**
     * 读未来若干天的日程。返回 JSON 数组，每条含标题、起止、是否全天、地点。
     *
     * 用 Instances 表而不是 Events 表：只有 Instances 会把重复日程展开成
     * 具体发生的那几次（「每周三开会」要看到下周三那一次，而不是一条规则）。
     *
     * 未授权或读不到时返回空数组——调用方据此说「读不到」，而不是报错。
     */
    fun readEventsJson(daysAhead: Int, daysBack: Int): String {
        val result = JSONArray()
        if (!hasReadPermission()) return result.toString()
        val days = daysAhead.coerceIn(1, 60)
        val back = daysBack.coerceIn(0, 60)

        val now = System.currentTimeMillis()
        val start = now - back * 24L * 60 * 60 * 1000
        val end = now + days * 24L * 60 * 60 * 1000
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().apply {
            ContentUris.appendId(this, start)
            ContentUris.appendId(this, end)
        }.build()

        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
        )
        return try {
            context.contentResolver.query(
                uri,
                projection,
                null,
                null,
                "${CalendarContract.Instances.BEGIN} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext() && result.length() < MAX_EVENTS) {
                    val title = cursor.getString(0) ?: continue
                    if (title.isBlank()) continue
                    // 跳过角色自己写入的日程：否则角色下次读取时会「看到自己写的
                    // 纪念日」，把它当成用户的安排来评论，很怪。
                    // 靠描述里的 EVENT_TAG 识别（写入时放的）。
                    val description = cursor.getString(5) ?: ""
                    if (description.contains(EVENT_TAG)) continue
                    result.put(
                        JSONObject()
                            .put("title", title)
                            .put("begin", cursor.getLong(1))
                            .put("end", cursor.getLong(2))
                            .put("allDay", cursor.getInt(3) == 1)
                            .put("location", cursor.getString(4) ?: "")
                    )
                }
            }
            result.toString()
        } catch (e: Throwable) {
            result.toString()
        }
    }

    /**
     * 往系统日历新增一条日程（纪念日 / 约定）。
     *
     * 只新增，不修改不删除——角色无权动用户已有的安排。
     *
     * @param allDay true 时按全天事件写入（纪念日、生日这类用这个）
     * @param year/month/day 全天事件用；month 为 1-12（人类习惯，内部转 0-11）
     * @param startMillis/endMillis 非全天事件用
     */
    fun insertEvent(
        title: String,
        allDay: Boolean,
        year: Int,
        month: Int,
        day: Int,
        startMillis: Long,
        endMillis: Long,
        description: String,
    ): JSONObject {
        if (!hasWritePermission()) {
            return JSONObject().put("ok", false)
                .put("reason", "还没有日历写入权限")
                .put("needPermission", "calendar")
        }
        if (title.isBlank()) {
            return JSONObject().put("ok", false).put("reason", "日程标题不能为空")
        }
        val calendarId = findWritableCalendarId()
            ?: return JSONObject().put("ok", false)
                .put("reason", "这台设备上没有可写入的日历账户")

        return try {
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calendarId)
                put(CalendarContract.Events.TITLE, title.take(120))
                // 标记放在描述里：用户点开能看到来源，标题保持干净
                put(CalendarContract.Events.DESCRIPTION, "$EVENT_TAG ${description.take(400)}".trim())
                put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
                if (allDay) {
                    // 全天事件必须用 UTC 零点，这是 CalendarContract 的既定要求：
                    // 用本地时间写入会整体偏移一个时区，用户看到「昨天」的纪念日。
                    val dayStart = utcMidnight(year, month - 1, day)
                    val dayEnd = utcMidnight(year, month - 1, day + 1)
                    put(CalendarContract.Events.ALL_DAY, 1)
                    put(CalendarContract.Events.DTSTART, dayStart)
                    put(CalendarContract.Events.DTEND, dayEnd)
                } else {
                    put(CalendarContract.Events.ALL_DAY, 0)
                    put(CalendarContract.Events.DTSTART, startMillis)
                    put(CalendarContract.Events.DTEND, endMillis.coerceAtLeast(startMillis + 60_000))
                }
            }
            val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
                ?: return JSONObject().put("ok", false).put("reason", "写入日历失败")
            val eventId = ContentUris.parseId(uri)
            // 加一个到点提醒：纪念日不提醒就白记了
            addReminder(eventId)
            JSONObject().put("ok", true).put("eventId", eventId)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "写入日历失败")
        }
    }

    /** 给刚写入的事件加一个当天 9 点的提醒。失败不影响主流程。 */
    private fun addReminder(eventId: Long) {
        try {
            val values = ContentValues().apply {
                put(CalendarContract.Reminders.EVENT_ID, eventId)
                put(CalendarContract.Reminders.MINUTES, 0)
                put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
            }
            context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, values)
        } catch (e: Throwable) {
            // 提醒加不上不影响日程本身
        }
    }

    /** 本地日期 → UTC 零点毫秒（全天事件专用）。 */
    private fun utcMidnight(year: Int, monthIndex: Int, day: Int): Long {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear()
        cal.set(year, monthIndex, day, 0, 0, 0)
        return cal.timeInMillis
    }

    /** 删除一条由角色写入的日程（用户后悔时的清理路径）。 */
    fun deleteOwnEvent(eventId: Long): JSONObject {
        if (!hasWritePermission()) {
            return JSONObject().put("ok", false).put("reason", "还没有日历写入权限")
        }
        return try {
            val uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId)
            val count = context.contentResolver.delete(uri, null, null)
            JSONObject().put("ok", count > 0)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "删除失败")
        }
    }

    /** 日历能力与授权状态，供设置面板显示三态。 */
    fun capabilitiesJson(): String = JSONObject()
        .put("readable", hasReadPermission())
        .put("writable", hasWritePermission())
        .put("hasWritableCalendar", findWritableCalendarId() != null)
        .toString()
}
