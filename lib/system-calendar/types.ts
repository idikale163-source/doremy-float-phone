/**
 * 系统日历：让角色看见你真实日程，也能把纪念日写进你的系统日历。
 *
 * 与其他两块的分工：
 *   感知（lib/perception）——只读手机状态，数据不出设备；
 *   设备动作（lib/device-action）——只写设备状态，一次性可撤销；
 *   系统日历（本模块）——读写用户真实日程，是持久数据。
 *
 * 产品边界（改代码前先读）：
 *  - 读和写是**两种授权、两种开关**。用户可能只想让角色「知道我的安排」，
 *    但不接受「往我日历里写东西」。混成一个开关等于剥夺了这个选择。
 *  - 只读摘要字段（标题/时间/地点），不读参与者、不读备注原文。
 *    日程标题足够让角色知情了；参与者和备注常有敏感信息。
 *  - 写只新增，**绝不修改或删除用户已有的日程**。角色无权动用户的安排。
 *  - 写入的事件带可识别标记，用户能在日历里一眼看出哪些是角色加的。
 */

/** 系统日历里的一条事件（原生侧已裁成摘要，见 CalendarBridge.readEventsJson）。 */
export type SystemCalendarEvent = {
  title: string;
  /** 开始时间（毫秒时间戳） */
  begin: number;
  /** 结束时间（毫秒时间戳） */
  end: number;
  /** 是否全天事件 */
  allDay: boolean;
  location: string;
};

/** 壳如实上报的日历能力与授权状态。 */
export type SystemCalendarCapabilities = {
  /** 已授予读权限 */
  readable?: boolean;
  /** 已授予写权限 */
  writable?: boolean;
  /** 设备上存在可写入的日历账户（没有则写入必然失败） */
  hasWritableCalendar?: boolean;
};

/** 写入结果。 */
export type SystemCalendarWriteResult =
  | { ok: true; eventId: number }
  | { ok: false; reason: string; needPermission?: string };

/** 把毫秒时间戳说成人话（给角色看的）。 */
export function formatEventTime(event: SystemCalendarEvent): string {
  const start = new Date(event.begin);
  if (Number.isNaN(start.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  const datePart = `${start.getFullYear()}-${p2(start.getMonth() + 1)}-${p2(start.getDate())}`;
  if (event.allDay) return `${datePart}（全天）`;
  const end = new Date(event.end);
  const startTime = `${p2(start.getHours())}:${p2(start.getMinutes())}`;
  const endTime = Number.isNaN(end.getTime()) ? "" : `${p2(end.getHours())}:${p2(end.getMinutes())}`;
  return endTime ? `${datePart} ${startTime}-${endTime}` : `${datePart} ${startTime}`;
}
