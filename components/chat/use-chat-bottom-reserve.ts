"use client";

import { useLayoutEffect, type RefObject } from "react";

const CHAT_BOTTOM_RESERVE_CSS_VAR = "--chat-bottom-reserve";
const STICK_TO_BOTTOM_THRESHOLD = 120;

function findBottomOverlay(wrapper: HTMLElement): HTMLElement | null {
    for (const child of Array.from(wrapper.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const ui = child.dataset.ui;
        if (ui === "input" || ui === "multi-select") return child;
    }
    return null;
}

export function useChatBottomReserve<TWrapper extends HTMLElement, TScroll extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    scrollRef: RefObject<TScroll | null>,
    refreshKey: string,
) {
    useLayoutEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        let frame = 0;
        let bottomScrollFrame = 0;
        let observer: ResizeObserver | null = null;
        let lastClientHeight = 0;
        let lastNearBottom = true;

        const scheduleStickToBottom = () => {
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            bottomScrollFrame = window.requestAnimationFrame(() => {
                bottomScrollFrame = 0;
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
            });
        };

        const measure = () => {
            frame = 0;
            const overlay = findBottomOverlay(wrapper);
            if (!overlay) {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
                return;
            }

            const el = scrollRef.current;
            const height = Math.ceil(overlay.getBoundingClientRect().height);

            if (height > 0) {
                wrapper.style.setProperty(CHAT_BOTTOM_RESERVE_CSS_VAR, `${height}px`);
            } else {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
            }

            if (el) {
                const clientHeight = el.clientHeight;
                const nearBottom = el.scrollHeight - el.scrollTop - clientHeight < STICK_TO_BOTTOM_THRESHOLD;
                // 键盘弹出（interactive-widget=resizes-content）会瞬间压缩手机屏，
                // clientHeight 骤降数百像素，"距底部距离"被动放大、远超 120px 阈值，
                // 若只按当前距离判断会把贴底误判成浏览历史，导致最新消息停在原位、
                // 输入栏上移，中间露出大片空白。这里用收缩前的贴底状态补偿：
                // 只要压缩前在底部，压缩后仍然贴底。
                const viewportShrank = lastClientHeight > 0 && clientHeight < lastClientHeight - 8;
                if (nearBottom || (viewportShrank && lastNearBottom)) scheduleStickToBottom();
                lastClientHeight = clientHeight;
                lastNearBottom = nearBottom;
            }
        };

        const requestMeasure = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        const overlay = findBottomOverlay(wrapper);
        if (overlay && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(requestMeasure);
            observer.observe(overlay);
            // 关键：同时观察滚动容器自身。键盘弹出时 window resize 监听器可能在
            // --phone-screen-height 更新之前运行，measure 读到的还是压缩前的旧高度，
            // 之后的真实压缩没有任何事件再触发测量。ResizeObserver 回调在布局变化
            // 之后执行，保证 measure 能看到收缩后的 clientHeight，让贴底补偿生效。
            if (scrollRef.current) observer.observe(scrollRef.current);
        }

        measure();
        window.addEventListener("resize", requestMeasure);
        window.visualViewport?.addEventListener("resize", requestMeasure);
        window.visualViewport?.addEventListener("scroll", requestMeasure);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            observer?.disconnect();
            window.removeEventListener("resize", requestMeasure);
            window.visualViewport?.removeEventListener("resize", requestMeasure);
            window.visualViewport?.removeEventListener("scroll", requestMeasure);
        };
    }, [wrapperRef, scrollRef, refreshKey]);
}
