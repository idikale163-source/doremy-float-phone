// lib/call-session-store.ts
//
// 全局通话会话：把「当前是否在通话」从聊天室里提出来。
//
// 原实现把通话状态放在 ChatRoom 内部，通话界面又 portal 到聊天室的父容器，
// 于是通话的可见性完全绑死在聊天室上：返回会话列表 → 通话层跟着被隐藏（看着像
// 已挂断）；回到手机桌面 → 整个聊天 App 卸载，通话直接销毁。
//
// 改成全局状态后，通话界面由 desktop-shell 常驻渲染，切会话、回桌面、开别的 App
// 都不影响通话继续，缩成小窗时也能一直留在手机界面上。
//
// 只存「身份」不存会话对象：会话与角色都可以按 id 从本地存储取回，避免两份状态
// 不同步（改名、换头像后悬浮窗显示旧值）。

"use client";

export type ActiveCallKind = "voice" | "video";

export type ActiveCall = {
    sessionId: string;
    /** 单聊：角色 id。群聊通话没有单一角色，用群会话本身承载（留空字符串）。 */
    characterId: string;
    kind: ActiveCallKind;
    initiator: "user" | "character";
    /** initiator="character" 时发起通话的角色名（群聊来电要显示具体是谁打来的）。 */
    initiatorName?: string;
    minimized: boolean;
    /**
     * 每次拨号都换一个新值，用作 React key：
     * 同一会话挂断后再拨时强制重挂组件，不沿用上一次的通话中状态。
     */
    callId: string;
};

let activeCall: ActiveCall | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* 单个订阅者出错不影响其余 */ }
    }
}

/** 供 useSyncExternalStore 订阅。 */
export function subscribeActiveCall(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * 当前通话快照。
 *
 * 必须始终返回同一个对象引用（只有真正变更时才换新对象），否则
 * useSyncExternalStore 会判定「快照一直在变」而无限重渲染。
 */
export function getActiveCall(): ActiveCall | null {
    return activeCall;
}

/** 服务端渲染时没有通话；给 useSyncExternalStore 的三参用法兜底。 */
export function getActiveCallServerSnapshot(): ActiveCall | null {
    return null;
}

/** 发起通话（或来电被接听后建立通话）。同会话重复调用视为重拨。 */
export function startCall(input: {
    sessionId: string;
    characterId: string;
    kind: ActiveCallKind;
    initiator: "user" | "character";
    initiatorName?: string;
}): void {
    activeCall = {
        ...input,
        minimized: false,
        callId: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };
    emit();
}

/** 缩成悬浮窗：通话继续，仅界面变小窗。 */
export function minimizeCall(): void {
    if (!activeCall || activeCall.minimized) return;
    activeCall = { ...activeCall, minimized: true };
    emit();
}

/** 从悬浮窗恢复全屏。 */
export function restoreCall(): void {
    if (!activeCall || !activeCall.minimized) return;
    activeCall = { ...activeCall, minimized: false };
    emit();
}

/**
 * 挂断：清除全局状态，通话界面随之卸载，并广播一条结束事件。
 *
 * 通话界面已提升到 desktop-shell，聊天室不再是它的父级，收不了挂断回调；
 * 原来挂在聊天室里的收尾（刷新通话留痕 + 让角色回应一次）改由这条事件触发。
 */
export function endCall(): void {
    const ended = activeCall;
    if (!ended) return;
    activeCall = null;
    emit();
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("chat-call-ended", {
            detail: { sessionId: ended.sessionId },
        }));
    }
}

/** 当前是否正在通话（含悬浮态）。 */
export function hasActiveCall(): boolean {
    return activeCall !== null;
}

/** 指定会话是否正在通话——聊天室据此避免重复发起。 */
export function isCallActiveForSession(sessionId: string): boolean {
    return activeCall?.sessionId === sessionId;
}
