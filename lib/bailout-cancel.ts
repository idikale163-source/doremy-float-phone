// lib/bailout-cancel.ts
//
// 「撤销服务端离线预约」的信号。
//
// 存储层（timed-wake-storage / idle-reconnect-storage）删规则时只能改本地，
// 不能直接调 push-bailout-client 的撤销函数——后者依赖前者，反向导入会成环。
// 所以这里只广播一个事件，由 push-bailout-client 监听并真正发 DELETE。
//
// 不这么做的后果：用户关掉/删掉主动消息后，服务端那条预约仍然有效；
// 而「长时间没消息时（可重复）」这类任务的续排在服务端自动进行
//（push-generate 内的 idleRepeat 分支），于是本地关了、通知还在一轮轮弹。

export const BAILOUT_CANCEL_EVENT = "ai-phone-bailout-cancel";

export type BailoutCancelDetail = {
    /** 精确撤销某个 triggerKey。 */
    key?: string;
    /** 撤销某个前缀下的全部预约（如 idle:<ruleId>:）。 */
    prefix?: string;
};

export function emitBailoutCancel(detail: BailoutCancelDetail): void {
    if (typeof window === "undefined") return;
    if (!detail.key && !detail.prefix) return;
    try {
        window.dispatchEvent(new CustomEvent(BAILOUT_CANCEL_EVENT, { detail }));
    } catch {
        // 老 WebView 不支持 CustomEvent 构造器：仅少一次即时撤销，
        // 下次重挂时 arm* 会按同前缀清理旧键兜底。
    }
}
