"use client";

// 通话里的「待发送队列」。
//
// 问题：角色正在说话（AI_SPEAKING）或正在思考（PROCESSING）时，通话屏不接受
// 新输入——原先的写法是 `if (callStateRef.current === "IDLE") runConversationTurn(text)`，
// 条件不满足就把消息直接丢掉，连个提示都没有。从浮窗回复条发消息时因此常常
// 「空发」：输入框收了字、条也收起了，消息却哪儿都没去。
//
// 这里改成排队：忙的时候先存起来，通话一回到 IDLE 立刻发出去。
// 消息不会再丢，界面上也能看到「还有几条等着发」。
//
// 与自动搭话的配合：手动消息优先。队列里有待发消息时，自动搭话的心跳会因为
// 状态不是 IDLE 而自然让路。

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { updateShellCallOverlayPending } from "@/lib/shell-call-overlay";

/** 一次最多排几条。超了说明对面一直说不完，先拒掉免得越积越多、
 *  等想起来时一股脑全发出去。 */
export const MAX_PENDING_REPLIES = 5;

/** 提交结果：直接发出 / 已排队 / 拒收（队列满或空文本） */
export type ReplySubmitResult = "sent" | "queued" | "rejected";

type UseCallReplyQueueParams = {
    /** 当前通话状态（state，不是 ref——要触发 flush 的 effect） */
    callState: string;
    /** 状态 ref：提交那一刻判断忙不忙，避免闭包拿到旧值 */
    callStateRef: MutableRefObject<string>;
    /** 真正发出去的入口（各通话屏的 runConversationTurn） */
    runTurn: (text: string) => void;
    /** 通话是否还在进行（挂断后不再补发） */
    active: boolean;
};

export function useCallReplyQueue({ callState, callStateRef, runTurn, active }: UseCallReplyQueueParams) {
    const queueRef = useRef<string[]>([]);
    const [pending, setPending] = useState(0);
    // runTurn 每秒可能重建（依赖计时等），走 ref 免得 flush 的 effect 跟着重装
    const runTurnRef = useRef(runTurn);
    runTurnRef.current = runTurn;

    /**
     * 提交一条消息。
     * · 通话空闲 → 立刻发出（返回 "sent"）
     * · 正在说话/思考 → 排队（返回 "queued"）
     * · 队列已满或空文本 → 拒收（返回 "rejected"），调用方应保留输入内容
     */
    const submit = useCallback((text: string): ReplySubmitResult => {
        const trimmed = text.trim();
        if (!trimmed) return "rejected";
        if (callStateRef.current === "IDLE") {
            runTurnRef.current(trimmed);
            return "sent";
        }
        if (queueRef.current.length >= MAX_PENDING_REPLIES) return "rejected";
        queueRef.current.push(trimmed);
        setPending(queueRef.current.length);
        return "queued";
    }, [callStateRef]);

    const clear = useCallback(() => {
        queueRef.current = [];
        setPending(0);
    }, []);

    // 待发条数同步到安卓壳的原生浮窗角标。
    //
    // 接在这个共用 hook 里而不是各通话屏的接线处：语音/视频/群聊三个屏都用它，
    // 一处生效全覆盖，不必每屏各接一遍（视频屏此前就因为漏接，从浮窗回复条
    // 发出的消息在排队时毫无提示）。非壳环境与老壳上是 no-op。
    // 挂断清空后 pending 归 0，角标随之隐藏。
    useEffect(() => {
        updateShellCallOverlayPending(pending);
    }, [pending]);

    // 回到 IDLE 就把排队的发出去。
    // 一次只发一条：发出去后状态立刻变 PROCESSING，effect 重跑时不再是 IDLE，
    // 自然停手；等角色这一轮说完、再次回到 IDLE 时接着发下一条。
    useEffect(() => {
        if (!active) return;
        if (callState !== "IDLE") return;
        if (queueRef.current.length === 0) return;
        const next = queueRef.current.shift();
        setPending(queueRef.current.length);
        if (next) runTurnRef.current(next);
    }, [active, callState]);

    // 通话结束：清空。挂断之后再把话补发出去就不对了。
    useEffect(() => {
        if (!active) clear();
    }, [active, clear]);

    return { submit, pending, clear };
}
