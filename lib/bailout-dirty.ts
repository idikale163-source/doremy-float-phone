// lib/bailout-dirty.ts
//
// 「离线预约需要重挂」的信号。
//
// 背景：定时唤醒 / 冷场重连的排期过去只写本地（localStorage），真正把任务
// POST 到服务端要等 refreshScheduledBailouts()——而它原本只在「启动 20 秒后」
// 和「切后台」两个时点跑，且要重新组装完整提示词与 LLM 请求。
// 用户新建主动消息后若很快退出或被系统杀掉，这次 POST 根本来不及发生：
// push_jobs 里一条记录都没有，服务端从头到尾不知道这个任务存在。
//
// 于是在排期/规则落盘处广播本事件，由监听方立刻挂单。之后随便杀进程，
// 任务都已经在服务端等着了。

export const BAILOUT_DIRTY_EVENT = "ai-phone-bailout-dirty";

export function markBailoutDirty(): void {
    if (typeof window === "undefined") return;
    try {
        window.dispatchEvent(new CustomEvent(BAILOUT_DIRTY_EVENT));
    } catch {
        // 老 WebView 不支持 CustomEvent 构造器时忽略：只是少一次即时挂单，
        // 启动后的兜底巡检仍会补上。
    }
}
