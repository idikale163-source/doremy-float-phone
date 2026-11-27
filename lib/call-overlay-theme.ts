// 通话浮窗「快捷回复条」的配色。
//
// 同一条回复条有两种渲染：
//   · 安卓壳里由原生绘制（android-shell 的 CallOverlayService.ReplyTheme）；
//   · 小手机内由网页绘制（components/chat/call-mini-window.tsx）。
// 两边共用同一份配色，用户改一次两边都变。
//
// 结构分两层：
//   · 6 套预设（key + 一组颜色）——选一套就是一键换色；
//   · 用户自定义覆盖（custom）——想单独调某一级颜色时用它，
//     没动到的项仍跟随所选预设。
// 这样「选预设」和「逐项微调」不冲突：预设当作起点，改动叠在上面。
//
// 原生侧存壳的 SharedPreferences（经 AndroidShell 下发 JSON），网页侧存 localStorage；
// 在壳内读取时以壳的记录为准，保证看到的与原生实际画出来的一致。

import { getShellOverlayThemeJson, setShellOverlayThemeJson } from "./shell-call-overlay";

/** 回复条的六级颜色。原生用 #RRGGBB 解析，故这里一律不带透明度；
 *  条身透明度单独用 barAlpha 表示（原生 Color.argb，网页 rgba）。 */
export type CallOverlayColors = {
    /** 条身底色 */
    bar: string;
    /** 条身不透明度 0~1 */
    barAlpha: number;
    /** 输入文字 */
    text: string;
    /** 占位文字 */
    hint: string;
    /** 发送键底色 */
    accent: string;
    /** 发送键文字 */
    sendText: string;
    /** 次要按钮（收起）文字色 */
    muted: string;
};

export type CallOverlayTheme = {
    key: string;
    label: string;
    colors: CallOverlayColors;
};

export const CALL_OVERLAY_THEMES: CallOverlayTheme[] = [
    {
        key: "dark", label: "暗夜",
        colors: { bar: "#1B1B22", barAlpha: 0.95, text: "#FFFFFF", hint: "#8A93A6", accent: "#3B82F6", sendText: "#FFFFFF", muted: "#C9D1E0" },
    },
    {
        key: "light", label: "浅色",
        colors: { bar: "#FFFFFF", barAlpha: 0.95, text: "#1B1B22", hint: "#8A93A6", accent: "#3B82F6", sendText: "#FFFFFF", muted: "#5A6270" },
    },
    {
        key: "ocean", label: "深海",
        colors: { bar: "#0E1A2B", barAlpha: 0.95, text: "#FFFFFF", hint: "#7E8DA6", accent: "#4C8DFF", sendText: "#FFFFFF", muted: "#9FB0C9" },
    },
    {
        key: "sakura", label: "樱粉",
        colors: { bar: "#2A1B24", barAlpha: 0.95, text: "#FFFFFF", hint: "#B08A9C", accent: "#E56B9A", sendText: "#FFFFFF", muted: "#C9A3B3" },
    },
    {
        key: "bamboo", label: "青竹",
        colors: { bar: "#152419", barAlpha: 0.95, text: "#FFFFFF", hint: "#8AA694", accent: "#30A46C", sendText: "#FFFFFF", muted: "#A3C9B3" },
    },
    {
        key: "violet", label: "夜幕",
        colors: { bar: "#1D182B", barAlpha: 0.95, text: "#FFFFFF", hint: "#938AA6", accent: "#9B6BFF", sendText: "#FFFFFF", muted: "#B3A9C9" },
    },
];

export const DEFAULT_CALL_OVERLAY_THEME = "dark";

/** 主题变更事件：已挂载的网页回复条据此即时重绘（原生侧由桥自己处理） */
export const CALL_OVERLAY_THEME_EVENT = "call-overlay-theme-changed";

export function resolveCallOverlayTheme(key: string | null | undefined): CallOverlayTheme {
    return CALL_OVERLAY_THEMES.find(item => item.key === key)
        ?? CALL_OVERLAY_THEMES.find(item => item.key === DEFAULT_CALL_OVERLAY_THEME)
        ?? CALL_OVERLAY_THEMES[0];
}

const STORAGE_KEY = "call-overlay-theme-v2";
/** 旧版只存了一个主题键（纯字符串），升级时读它做迁移 */
const LEGACY_STORAGE_KEY = "call-overlay-theme-v1";

type StoredShape = {
    key: string;
    /** 逐项覆盖；缺省表示完全跟随预设 */
    custom?: Partial<CallOverlayColors> | null;
};

/** 颜色一律规范成 #RRGGBB：原生 Color.parseColor 只认这个与 #AARRGGBB，
 *  带 alpha 的 #RRGGBBAA 会让原生解析失败并整条回落默认色。 */
function normalizeHex(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
    // #RGB 简写补全
    const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
    // 8 位（含 alpha）取前 6 位，丢掉透明度而不用错色
    const long = /^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/.exec(trimmed);
    if (long) return `#${long[1]}`.toUpperCase();
    return fallback;
}

function normalizeAlpha(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

function normalizeColors(raw: Partial<CallOverlayColors> | null | undefined, base: CallOverlayColors): CallOverlayColors {
    if (!raw || typeof raw !== "object") return { ...base };
    return {
        bar: normalizeHex(raw.bar, base.bar),
        barAlpha: normalizeAlpha(raw.barAlpha, base.barAlpha),
        text: normalizeHex(raw.text, base.text),
        hint: normalizeHex(raw.hint, base.hint),
        accent: normalizeHex(raw.accent, base.accent),
        sendText: normalizeHex(raw.sendText, base.sendText),
        muted: normalizeHex(raw.muted, base.muted),
    };
}

function readStored(): StoredShape {
    const fallback: StoredShape = { key: DEFAULT_CALL_OVERLAY_THEME, custom: null };
    if (typeof window === "undefined") return fallback;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as StoredShape;
            const theme = resolveCallOverlayTheme(parsed?.key);
            const custom = parsed?.custom ? normalizeColors(parsed.custom, theme.colors) : null;
            return { key: theme.key, custom };
        }
        // 迁移旧版：只存了键，没有自定义
        const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) return { key: resolveCallOverlayTheme(legacy).key, custom: null };
    } catch {
        /* 读不了就用默认 */
    }
    return fallback;
}

/**
 * 读当前配色：预设打底、自定义覆盖叠加。
 * 壳内优先用壳记录的那份——那是原生实际画出来的颜色，两边不一致时以它为准。
 */
export function loadCallOverlayColors(): CallOverlayColors {
    const stored = readStored();
    const theme = resolveCallOverlayTheme(stored.key);
    const custom = stored.custom;
    try {
        const fromShell = getShellOverlayThemeJson();
        if (fromShell) {
            const parsed = JSON.parse(fromShell) as StoredShape;
            const shellTheme = resolveCallOverlayTheme(parsed?.key);
            return normalizeColors(parsed?.custom, shellTheme.colors);
        }
    } catch {
        /* 桥不可用或格式不对就退回本地记录 */
    }
    return normalizeColors(custom, theme.colors);
}

/** 读当前主题键（设置页回显选中项用） */
export function loadCallOverlayTheme(): string {
    const stored = readStored();
    try {
        const fromShell = getShellOverlayThemeJson();
        if (fromShell) return resolveCallOverlayTheme((JSON.parse(fromShell) as StoredShape)?.key).key;
    } catch {
        /* 忽略 */
    }
    return stored.key;
}

/** 读当前自定义覆盖（设置页回显）；没自定义过返回 null */
export function loadCallOverlayCustomColors(): Partial<CallOverlayColors> | null {
    return readStored().custom ?? null;
}

function persist(key: string, custom: Partial<CallOverlayColors> | null): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, custom }));
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
        /* 存不下就算了，本次选择照样生效 */
    }
    // 下发原生（含已弹出的那条回复条）并广播给网页侧已挂载的回复条
    try {
        setShellOverlayThemeJson(JSON.stringify({ key, custom }));
    } catch {
        /* 非壳环境或老 APK：忽略 */
    }
    window.dispatchEvent(new CustomEvent(CALL_OVERLAY_THEME_EVENT, { detail: { key } }));
}

/** 选一套预设（清掉之前的逐项自定义，回到该预设原样） */
export function saveCallOverlayTheme(key: string): string {
    const safe = resolveCallOverlayTheme(key).key;
    persist(safe, null);
    return safe;
}

/**
 * 保存逐项自定义颜色。传 null 清空自定义、回到纯预设。
 * 只覆盖传入的项，其余仍跟随预设。
 */
export function saveCallOverlayCustomColors(custom: Partial<CallOverlayColors> | null): void {
    const key = loadCallOverlayTheme();
    const theme = resolveCallOverlayTheme(key);
    persist(key, custom ? normalizeColors(custom, theme.colors) : null);
}

/** 订阅配色变更（组件内用），返回取消订阅函数 */
export function subscribeCallOverlayTheme(handler: (key: string) => void): () => void {
    if (typeof window === "undefined") return () => { };
    const listener = (event: Event) => {
        const key = (event as CustomEvent).detail?.key;
        if (typeof key === "string") handler(key);
    };
    window.addEventListener(CALL_OVERLAY_THEME_EVENT, listener);
    return () => window.removeEventListener(CALL_OVERLAY_THEME_EVENT, listener);
}
