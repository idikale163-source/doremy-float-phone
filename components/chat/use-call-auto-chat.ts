"use client";

// 通话「自动搭话」的运行时：三种通话屏（语音 / 视频 / 群聊）共用一套逻辑。
//
// 背景：煲电话粥时用户不说话，对面就一直干等。开启后在通话处于 IDLE
//（谁也没在说）且静默超过随机时长时，触发一次「无用户输入」的对话轮——
// 复用各通话屏自己的 runConversationTurn（不传 userText），让角色基于当前
// 上下文自己找话说，不额外拼提示词。
//
// 原先这段逻辑只写在语音通话屏里，视频/群聊要补同样能力时就只能再抄两份。
// 抽到这里后，三处共享同一份节拍与计数，设置也共用（lib/call-auto-chat）。

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import {
    type CallAutoChatConfig,
    type CallAutoChatStatus,
    clearCallAutoChatStatusReader,
    loadCallAutoChatConfig,
    publishCallAutoChatStatus,
    randomAutoChatDelaySeconds,
    saveCallAutoChatConfig,
} from "@/lib/call-auto-chat";

/** 诊断日志前缀：控制台里按它过滤，一眼看全自动搭话的心跳 */
const LOG_PREFIX = "[自动搭话]";

/**
 * 心跳诊断日志：排查「角色不主动开口」时看这里——每秒一条，带通话状态 /
 * 剩余等待秒数 / 空转次数 / 本轮已说条数，以及这一秒没触发的具体原因。
 * 想静音：控制台执行 window.__callAutoChatDebug = false（刷新页面后恢复默认开启）。
 */
function debugLog(message: string) {
    if (typeof window !== "undefined"
        && (window as unknown as { __callAutoChatDebug?: boolean }).__callAutoChatDebug === false) {
        return;
    }
    // 用 log 而不是 debug：安卓壳远调 / 手机浏览器默认不展开 Verbose 级别
    console.log(`${LOG_PREFIX} ${message}`);
}

type UseCallAutoChatParams = {
    /** 通话是否进行中（CONNECTING / ENDED 之外）。结束后停表 */
    active: boolean;
    /** 读当前通话状态：只有 IDLE（谁也没在说）时才允许主动开口 */
    callStateRef: MutableRefObject<string>;
    /** 触发一次「角色主动开口」的对话轮 */
    runTurn: () => void;
    /** 开口前的准备（各通话屏在这里停掉在听的识别，免把角色自己的声音录进去） */
    beforeTrigger?: () => void;
    /** 倒计时归零、真的开口了（用于打日志或埋点；可选） */
    onTriggered?: () => void;
};

export function useCallAutoChat({
    active,
    callStateRef,
    runTurn,
    beforeTrigger,
    onTriggered,
}: UseCallAutoChatParams) {
    const [config, setConfig] = useState<CallAutoChatConfig>(() => loadCallAutoChatConfig());

    // 回调与状态走 ref：它们每秒都可能变，进了依赖会让心跳定时器反复重建
    const runTurnRef = useRef(runTurn);
    const beforeTriggerRef = useRef(beforeTrigger);
    const onTriggeredRef = useRef(onTriggered);
    runTurnRef.current = runTurn;
    beforeTriggerRef.current = beforeTrigger;
    onTriggeredRef.current = onTriggered;

    const configRef = useRef(config);
    configRef.current = config;

    // 下一次可开口的时刻（毫秒时间戳，0 = 尚未排期）
    const deadlineRef = useRef(0);
    // 本次通话已自动开口条数（用户一开口清零）
    const turnsRef = useRef(0);
    // 角色连着几轮没说出内容：等待时长按此翻倍，避免空转连发
    const emptyTurnsRef = useRef(0);
    // 重复原因的日志节流：角色连说十几秒时，「有人在说」不必每秒打一条
    const lastReasonRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
    // 最近几条事件，供通话设置面板显示（手机上开不了控制台）
    const eventsRef = useRef<string[]>([]);
    // 最近一次心跳的墙钟时间、当前状态说明：面板靠这两项判断「心跳还活着吗、在等什么」
    const tickedAtRef = useRef(0);
    const reasonRef = useRef("尚未开始");

    /** 同一原因 5 秒内只留一条日志（正常倒计时不受影响，仍逐秒打） */
    const logReason = (key: string, message: string) => {
        const now = Date.now();
        const last = lastReasonRef.current;
        if (last.key === key && now - last.at < 5000) return;
        lastReasonRef.current = { key, at: now };
        debugLog(message);
    };

    /** 记一条事件：控制台日志 + 面板事件流（都留，一个给电脑一个给手机） */
    const pushEvent = (message: string) => {
        const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${message}`;
        eventsRef.current = [...eventsRef.current, line].slice(-5);
        debugLog(message);
    };

    /** 打包一份当前快照。通话屏的面板每 500ms 读一次，只用于显示，不参与判定 */
    const buildStatus = useCallback((): CallAutoChatStatus => ({
        state: callStateRef.current,
        deadlineAt: deadlineRef.current,
        tickedAt: tickedAtRef.current,
        turns: turnsRef.current,
        maxTurns: configRef.current.maxTurns,
        emptyTurns: emptyTurnsRef.current,
        reason: reasonRef.current,
        events: eventsRef.current,
    }), [callStateRef]);

    /**
     * 安排下一次开口。
     * 每次角色说完（或空转一趟）都调一次：按配置在 [min, max] 里随机取间隔，
     * 真人是忽快忽慢的，固定节拍像定时器。空转那几轮按翻倍惩罚（最多 4 倍）。
     */
    const schedule = useCallback(() => {
        const current = configRef.current;
        if (!current.enabled) {
            deadlineRef.current = 0;
            return;
        }
        const backoff = 1 + Math.min(emptyTurnsRef.current, 3);
        deadlineRef.current = Date.now() + randomAutoChatDelaySeconds(current) * backoff * 1000;
    }, []);

    /** 用户开口了：重新计数（上限按「你开口后」重新算） */
    const notifyUserSpoke = useCallback(() => {
        turnsRef.current = 0;
        emptyTurnsRef.current = 0;
        deadlineRef.current = 0;
        pushEvent("你开口了：本轮计数与空转清零");
    }, []);

    /**
     * 角色说完一轮。
     * @param produced 这一轮是否真的说出了内容（false = 空转，下次等更久）
     */
    const notifyAssistantSpoke = useCallback((produced: boolean) => {
        emptyTurnsRef.current = produced ? 0 : emptyTurnsRef.current + 1;
        schedule();
        const next = deadlineRef.current
            ? `，下次等待 ${((deadlineRef.current - Date.now()) / 1000).toFixed(1)}s`
            : "（未排期：开关关闭或通话已结束）";
        pushEvent(`角色开口一轮（${produced ? "有内容" : "空转"}）${next}`);
    }, [schedule]);

    /** 改设置并即时生效（存盘 + 广播给其它页面），顺带把节拍复位 */
    const update = useCallback((patch: Partial<CallAutoChatConfig>) => {
        const before = configRef.current;
        const next = saveCallAutoChatConfig({ ...before, ...patch });
        setConfig(next);
        configRef.current = next;
        // 开关或上限变了：计数从头来（用户刚拨动开关，不该接着旧的算）
        if (next.enabled !== before.enabled || next.maxTurns !== before.maxTurns) {
            turnsRef.current = 0;
            emptyTurnsRef.current = 0;
        }
        // 间隔或开关变了：重新排期，改动立刻见效
        if (
            next.enabled !== before.enabled
            || next.minSeconds !== before.minSeconds
            || next.maxSeconds !== before.maxSeconds
        ) {
            deadlineRef.current = next.enabled
                ? Date.now() + randomAutoChatDelaySeconds(next) * 1000
                : 0;
            pushEvent(
                next.enabled
                    ? `设置变更：间隔 ${next.minSeconds}~${next.maxSeconds}s，`
                      + `上限 ${next.maxTurns > 0 ? `${next.maxTurns} 条` : "不限"}，已重排`
                    : "设置变更：自动搭话已关闭",
            );
        }
        return next;
    }, []);

    // 心跳：每秒看一眼是否到了开口时刻。
    // 缩成小窗 / 切到后台也照常触发——用户要的就是「挂着也一直聊」。
    useEffect(() => {
        if (!active) {
            deadlineRef.current = 0;
            pushEvent("通话不在进行中，心跳停表");
            return;
        }
        if (!config.enabled) {
            deadlineRef.current = 0;
            pushEvent("自动搭话已关闭，心跳停表");
            return;
        }
        // 登记状态读取器：挂在通话屏上的设置面板从这里读，不用改三个通话屏
        publishCallAutoChatStatus(buildStatus);
        // 刚开启（或刚进通话）：从当下起算一个随机间隔
        if (!deadlineRef.current) {
            const firstDelay = randomAutoChatDelaySeconds(config);
            deadlineRef.current = Date.now() + firstDelay * 1000;
            pushEvent(
                `心跳启动：首次等待 ${firstDelay.toFixed(1)}s`
                + `（间隔 ${config.minSeconds}~${config.maxSeconds}s，`
                + `上限 ${config.maxTurns > 0 ? `${config.maxTurns} 条` : "不限"}）`,
            );
        }
        tickedAtRef.current = Date.now();
        const timer = window.setInterval(() => {
            tickedAtRef.current = Date.now();
            const current = configRef.current;
            if (!current.enabled) return;
            const limit = current.maxTurns;
            const turns = limit > 0 ? `${turnsRef.current}/${limit}` : `${turnsRef.current}/不限`;
            const state = callStateRef.current;
            const deadline = deadlineRef.current;
            // 「剩余」在走 = 心跳还活着；整段时间一条日志都没有 = 定时器被系统冻结
            // （切回前台会补上）；显示「待重排」= 刚触发过或用户刚开口
            const remain = deadline
                ? `${Math.max(0, (deadline - Date.now()) / 1000).toFixed(1)}s`
                : "待重排";
            // 不触发的每一档原因都写出来——只看「没反应」是猜不出卡在哪的
            const head = `状态=${state} 剩余=${remain} 空转=${emptyTurnsRef.current} 本轮=${turns}`;
            if (state !== "IDLE") {
                reasonRef.current = "角色或你正在说话，等安静下来再开口";
                logReason(`state:${state}`, `${head} → 有人在说，本轮不触发`);
                return;
            }
            if (limit > 0 && turnsRef.current >= limit) {
                reasonRef.current = `已达本次通话上限（${limit} 条），你开口后才重新计数`;
                logReason("limit", `${head} → 已达本次通话上限，等你开口才重新计数`);
                return;
            }
            if (!deadline || Date.now() < deadline) {
                reasonRef.current = "静默倒计时中";
                debugLog(`${head} → 等待中`);
                return;
            }
            turnsRef.current += 1;
            deadlineRef.current = 0;
            reasonRef.current = "刚触发，正在等角色回应";
            pushEvent(`触发自动搭话（第 ${turnsRef.current} 条）`);
            beforeTriggerRef.current?.();
            onTriggeredRef.current?.();
            runTurnRef.current();
        }, 1000);
        return () => {
            window.clearInterval(timer);
            clearCallAutoChatStatusReader(buildStatus);
        };
        // callStateRef / runTurn 走 ref，不进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, config]);

    return { config, update, schedule, notifyUserSpoke, notifyAssistantSpoke };
}
