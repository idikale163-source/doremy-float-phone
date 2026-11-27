"use client";

// 安卓壳「通话浮窗」的接线钩子：把某个通话屏接到原生浮窗上。
//
// 三个通话屏（语音/视频/群聊）需要的行为完全一样，抽到这里避免三份拷贝：
//   · 页面转入后台且处于壳内时，顶出原生浮窗（不依赖用户是否按了缩小键）；
//   · 浮窗事件回灌：tick 校准时长、reply 走对话轮、restore 回全屏、hangup 挂断；
//   · 页面后台期间定期把网页侧时长回灌给原生；
//   · 卸载时收掉浮窗（否则桌面留一个点不动的悬空小窗）；
//   · 未授权浮窗权限时给出引导标记。
//
// 回调与「取当前时长」都用 ref 持有：它们依赖每秒变化的通话状态，
// 若进依赖会让订阅与浮窗每秒重建一次。

import { useEffect, useRef, useState } from "react";

import {
    ensureShellOverlayListener,
    hideShellCallOverlay,
    requestOverlayPermission,
    showShellCallOverlay,
    startShellCallOverlay,
    stopShellCallOverlay,
    subscribeShellOverlayEvents,
    supportsCallOverlay,
    supportsOverlayShowHide,
    updateShellCallOverlay,
    updateShellCallOverlayPending,
} from "@/lib/shell-call-overlay";

type UseShellCallOverlayParams = {
    /** 通话是否已接通（CONNECTING / ENDED 之外的状态） */
    active: boolean;
    /** 浮窗上的通话类型文字，如「语音通话」「群视频通话 (4人)」 */
    label: string;
    name: string;
    avatar: string | null;
    /** 读当前已通话秒数（用 getter 而不是值：值每秒都变，进依赖会重建浮窗） */
    getDuration: () => number;
    /** 原生浮窗里的快捷回复：应与界面输入走同一条通路 */
    onReply: (text: string) => void;
    onHangup: () => void;
    onRestore?: () => void;
    /** 原生计时校准（调用方应只前进不后退） */
    onTick: (seconds: number) => void;
    /** 待发消息条数：同步到原生浮窗左上角角标（与网页小窗对齐）。
     *  通话忙碌时排队的消息在切到别的 App 后看不见队列，角标是唯一的提示。 */
    pendingCount?: number;
};

/**
 * 接入原生通话浮窗。
 *
 * 调用位置要求：放在 onReply / onHangup 所引用的函数定义之后，
 * 否则会撞上 const 的暂时性死区（渲染时直接抛错）。
 */
export function useShellCallOverlay(params: UseShellCallOverlayParams) {
    const supported = typeof window !== "undefined" && supportsCallOverlay();
    const [pageHidden, setPageHidden] = useState(false);
    const [showPermissionHint, setShowPermissionHint] = useState(false);

    // 本次通话的 id：原生事件带上它，用来确认事件属于当前这一通
    const callIdRef = useRef(`call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // 回调与取值的 ref 快照（每次渲染刷新，effect 里读最新值）
    const handlersRef = useRef(params);
    handlersRef.current = params;

    useEffect(() => {
        if (typeof document === "undefined") return;
        const onVisibility = () => setPageHidden(document.visibilityState === "hidden");
        document.addEventListener("visibilitychange", onVisibility);
        onVisibility();
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    // 浮窗服务是否已经暖好（start 过、还没 stop）
    const overlayStartedRef = useRef(false);
    // 这一版壳是否支持「预热 + 显示/隐藏」的浮窗生命周期
    const supportsPrewarm = typeof window !== "undefined" && supportsOverlayShowHide();

    // ── 浮窗生命周期 ──
    //
    // 新壳（有 show/hide）：通话一接通、App 还在前台时就把服务暖好（窗口先藏着）；
    // 切到后台只 show，回到前台只 hide，服务全程活着。这样既不会撞上 Android 12+
    // 「后台禁止启动前台服务」的限制（那正是「浮窗有时不弹、声音却照旧」的成因），
    // 也不会因为反复 start/stop 把计时清零。
    //
    // 老壳（1.0.4 及以前，只有 start/stop，且 start 会立刻显示窗口）：退回旧行为——
    // 切到后台才 start、回到前台就 stop。预热方案在老壳上会把浮窗糊在通话界面上。
    //
    // 依赖里刻意不放 name/avatar/label：它们变化只该走 update，
    // 进了依赖会让浮窗跟着重建、计时归零。
    useEffect(() => {
        if (!supported) return;
        const handlers = handlersRef.current;

        if (!supportsPrewarm) {
            if (params.active && pageHidden) {
                const allowed = startShellCallOverlay({
                    name: handlers.name,
                    avatar: handlers.avatar,
                    meta: [handlers.label, "{{time}}"],
                    callId: callIdRef.current,
                    elapsedSeconds: handlers.getDuration(),
                });
                setShowPermissionHint(!allowed);
            } else {
                setShowPermissionHint(false);
                stopShellCallOverlay();
            }
            return;
        }

        if (!params.active) {
            overlayStartedRef.current = false;
            stopShellCallOverlay();
            return;
        }
        if (!overlayStartedRef.current) {
            const allowed = startShellCallOverlay({
                name: handlers.name,
                avatar: handlers.avatar,
                // {{time}} 交给原生替换成它自己维护的计时：WebView 被冻结也不停
                meta: [handlers.label, "{{time}}"],
                callId: callIdRef.current,
                // 带上网页已通话秒数，否则原生从 0 起数，两边时长对不上
                elapsedSeconds: handlers.getDuration(),
            });
            setShowPermissionHint(!allowed);
            // 只有真起来了才算预热完成。
            //
            // 这里曾经是先置位、后启动，于是「启动失败」也被记成「已预热」：
            // 之后每次切后台只调 show/hide（服务没起来时是空操作），再也不重试，
            // 表现为「失败一次之后浮窗永远不再出现」。保持 false 则下次可见性
            // 变化会重新尝试启动。
            overlayStartedRef.current = allowed;
        }
        if (pageHidden) {
            showShellCallOverlay();
        } else {
            setShowPermissionHint(false);
            hideShellCallOverlay();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [supported, supportsPrewarm, params.active, pageHidden]);

    // 名字 / 头像 / 通话类型变了：只更新内容，不重建窗口
    useEffect(() => {
        if (!supported || !params.active) return;
        // 新壳要等服务暖好；老壳没有预热概念，start 时已带上当时的值
        if (supportsPrewarm && !overlayStartedRef.current) return;
        updateShellCallOverlay({
            name: params.name,
            avatar: params.avatar,
            meta: [params.label, "{{time}}"],
        });
    }, [supported, supportsPrewarm, params.active, params.name, params.avatar, params.label]);

    // 待发条数同步到原生浮窗角标。
    // 数字只有 0~5 这么几个值，直接每次都调，不值得为它做去抖。
    //
    // 依赖里必须带上 pageHidden：浮窗是「切到后台」才亮出来的。如果用户在
    // App 内就已经排了几条消息、然后才切出去，那一刻 pendingCount 并没有变化，
    // 只靠它的 effect 不会重跑，角标就是空的——直到下一条消息入队才补上。
    // 带上 pageHidden 后，切后台（浮窗亮起）会再推一次当前条数。
    useEffect(() => {
        if (!supported || !params.active) return;
        // 新壳要等服务暖好；老壳没有角标这个概念
        if (supportsPrewarm && !overlayStartedRef.current) return;
        updateShellCallOverlayPending(params.pendingCount ?? 0);
    }, [supported, supportsPrewarm, params.active, params.pendingCount, pageHidden]);

    // 后台期间定期回灌时长，纠正两边漂移。
    //
    // 只前进不后退由两侧共同把关：这里 getDuration() 走墙钟推算（不读会被
    // 冻结的 state），原生侧也只接受「比它自己算出来的更大」的值。
    useEffect(() => {
        if (!supported || !pageHidden || !params.active) return;
        const timer = window.setInterval(() => {
            const handlers = handlersRef.current;
            updateShellCallOverlay({
                name: handlers.name,
                avatar: handlers.avatar,
                meta: [handlers.label, "{{time}}"],
                elapsedSeconds: handlers.getDuration(),
            });
        }, 10000);
        return () => window.clearInterval(timer);
    }, [supported, pageHidden, params.active]);

    // 原生事件回灌
    useEffect(() => {
        if (!supported) return;
        ensureShellOverlayListener();
        return subscribeShellOverlayEvents((event) => {
            // 只认当前这一通的事件，换通话后旧事件丢弃
            if (event.callId && event.callId !== callIdRef.current) return;
            const handlers = handlersRef.current;
            switch (event.action) {
                case "reply": {
                    const text = (event.text || "").trim();
                    if (text) handlers.onReply(text);
                    return;
                }
                case "tick": {
                    if (typeof event.seconds === "number") handlers.onTick(event.seconds);
                    return;
                }
                case "restore":
                    handlers.onRestore?.();
                    return;
                case "hangup":
                    handlers.onHangup();
                    return;
                case "needPermission":
                    setShowPermissionHint(true);
                    return;
                default:
                    return;
            }
        });
    }, [supported]);

    // 卸载时收掉浮窗
    useEffect(() => {
        if (!supported) return;
        return () => {
            overlayStartedRef.current = false;
            stopShellCallOverlay();
        };
    }, [supported]);

    return {
        /** 壳内但浮窗权限未开：界面应给一条授权引导 */
        showPermissionHint,
        dismissPermissionHint: () => setShowPermissionHint(false),
        requestPermission: requestOverlayPermission,
        /** 壳是否支持原生浮窗（普通浏览器为 false） */
        supported,
    };
}
