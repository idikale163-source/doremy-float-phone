// lib/call-auto-chat.ts
//
// 通话「自动搭话」：通话中用户长时间不出声，让角色主动开口。
//
// 煲电话粥的痛点是「我不说话，对面就一直干等」。开启后，每当通话处于 IDLE
// （谁也没在说）且静默超过设定时长，就触发一次「无用户输入」的对话轮 ——
// 复用通话屏输入框左侧「重回」键那条通路（runConversationTurn 不传 userText），
// 让角色基于当前上下文自己找话说。不额外拼提示词，行为与手动点「重回」一致。
//
// 间隔走「随机区间」：固定节拍像定时器，真人是忽快忽慢的。设成 20~60 秒后，
// 每次触发的等待时长都在这区间里随机取值。
// 另设「本次通话上限条数」，避免挂着电话没人听时无限烧 token（0 = 不限）。
//
// 存储：kv-db（IndexedDB），与其它设置一致。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_call_auto_chat_v2";
registerKvMigration(STORAGE_KEY);

export type CallAutoChatConfig = {
    /** 是否开启自动搭话 */
    enabled: boolean;
    /** 触发间隔下限（秒） */
    minSeconds: number;
    /** 触发间隔上限（秒）；等于 minSeconds 即固定间隔 */
    maxSeconds: number;
    /** 本次通话最多自动搭话多少条；0 = 不限 */
    maxTurns: number;
};

/** 原生计时事件（安卓壳浮窗每秒推一次）。
 *  后台 WebView 的 setInterval 会被系统节流甚至冻结，靠它把通话时长与自动搭话
 *  的节拍托管给原生，切到别的 App 后依然准点。 */
export const SHELL_CALL_TICK_EVENT = "shell-call-overlay";

export const DEFAULT_CALL_AUTO_CHAT_CONFIG: CallAutoChatConfig = {
    enabled: true,
    minSeconds: 20,
    maxSeconds: 60,
    maxTurns: 20,
};

/** 间隔允许范围（秒）：太短会变成连珠炮，太长就失去「陪着」的意义 */
export const MIN_INTERVAL_SECONDS = 5;
export const MAX_INTERVAL_SECONDS = 3600;
/** 上限允许范围（条） */
export const MAX_TURNS_LIMIT = 999;

/** 配置被改动后广播（通话屏开着时据此即时生效，不用重进通话） */
export const CALL_AUTO_CHAT_UPDATED_EVENT = "call-auto-chat-updated";

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
}

function normalize(raw: unknown): CallAutoChatConfig {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_CALL_AUTO_CHAT_CONFIG };
    const source = raw as Partial<CallAutoChatConfig>;
    // 缺省视为开启：老配置或手改存储后仍能正常工作
    const enabled = source.enabled !== false;
    const minSeconds = clampNumber(
        source.minSeconds,
        MIN_INTERVAL_SECONDS,
        MAX_INTERVAL_SECONDS,
        DEFAULT_CALL_AUTO_CHAT_CONFIG.minSeconds,
    );
    const maxSeconds = clampNumber(
        source.maxSeconds,
        minSeconds,
        MAX_INTERVAL_SECONDS,
        Math.max(minSeconds, DEFAULT_CALL_AUTO_CHAT_CONFIG.maxSeconds),
    );
    const maxTurns = clampNumber(
        source.maxTurns,
        0,
        MAX_TURNS_LIMIT,
        DEFAULT_CALL_AUTO_CHAT_CONFIG.maxTurns,
    );
    return { enabled, minSeconds, maxSeconds, maxTurns };
}

export function loadCallAutoChatConfig(): CallAutoChatConfig {
    if (typeof window === "undefined") return { ...DEFAULT_CALL_AUTO_CHAT_CONFIG };
    try {
        const raw = kvGet(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_CALL_AUTO_CHAT_CONFIG };
        return normalize(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_CALL_AUTO_CHAT_CONFIG };
    }
}

/** 保存并返回规范化后的配置（调用方拿它同步 UI，避免输入 3 被夹到 5 后显示不同步） */
export function saveCallAutoChatConfig(config: CallAutoChatConfig): CallAutoChatConfig {
    const next = normalize(config);
    if (typeof window !== "undefined") {
        kvSet(STORAGE_KEY, JSON.stringify(next));
        window.dispatchEvent(new CustomEvent(CALL_AUTO_CHAT_UPDATED_EVENT, { detail: next }));
    }
    return next;
}

/** 当前是否开启自动搭话 */
export function isCallAutoChatEnabled(): boolean {
    return loadCallAutoChatConfig().enabled;
}

/** 在 [minSeconds, maxSeconds] 之间随机取一个等待秒数 */
export function randomAutoChatDelaySeconds(config: CallAutoChatConfig): number {
    const min = Math.max(MIN_INTERVAL_SECONDS, config.minSeconds);
    const max = Math.max(min, config.maxSeconds);
    if (max <= min) return min;
    return min + Math.random() * (max - min);
}

// ── 运行状态：给通话设置面板看「现在到底在等什么」──────────────────────────
//
// 手机上开不了控制台（安卓壳里更没有 F12），所以心跳把每秒的快照登记在这里，
// 通话屏那个「自动搭话」面板读它显示。诊断信息一样，只是换了个能看见的地方。

export type CallAutoChatStatus = {
    /** 通话状态：IDLE（谁也没在说）/ 其它 */
    state: string;
    /** 下次开口的时刻（毫秒时间戳）；0 = 尚未排期 */
    deadlineAt: number;
    /** 最近一次心跳的墙钟时间；0 = 心跳已停表。与当前时间差太大 = 定时器被系统冻结 */
    tickedAt: number;
    /** 本次通话已自动开口条数 */
    turns: number;
    /** 条数上限；0 = 不限 */
    maxTurns: number;
    /** 连续空转轮数 */
    emptyTurns: number;
    /** 面板顶部那句话：当前在等什么 / 为什么没开口 */
    reason: string;
    /** 最近几条事件（新的在后），给看不到控制台的手机用 */
    events: string[];
};

/** 当前跑着的自动搭话把状态读取器登记在这。三个通话屏同一时刻只跑一份，单一槽位够用 */
let statusReader: (() => CallAutoChatStatus) | null = null;

/** 登记状态读取器（每次进通话 / 设置变更后重新登记） */
export function publishCallAutoChatStatus(reader: () => CallAutoChatStatus): void {
    statusReader = reader;
}

/** 注销：只有当前登记的确实是它时才清空，免把后挂载的实例顶掉 */
export function clearCallAutoChatStatusReader(reader: () => CallAutoChatStatus): void {
    if (statusReader === reader) statusReader = null;
}

/** 读当前状态；没在通话（或自动搭话没跑）时返回 null */
export function readCallAutoChatStatus(): CallAutoChatStatus | null {
    return statusReader ? statusReader() : null;
}
