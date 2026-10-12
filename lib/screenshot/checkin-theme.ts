// 查岗 / 截屏确认浮层的配色。
//
// 与「通话浮窗外观」同一套做法（见 lib/call-overlay-theme.ts）：
//   · 6 套预设 —— 一键换整套配色；
//   · 逐项自定义 —— 想单独调某一级颜色时用它，改动叠在预设之上，
//     没动到的项仍跟随预设。
//
// 为什么与通话浮窗分开、不共用一份配色：两者是同时可能出现的东西
// （通话进行中角色照样会查岗），共用一份就会出现「改这个把那个也改了」
// 的互相干扰。而且这条浮层比通话那条更需要用户掌控——它上面显示的是
// 整屏画面。配色能自己调，用户至少能让它长得像自己的东西，
// 而不是一个来路不明的黑框。
//
// 落盘分两处：
//   · 网页 localStorage —— 设置页回显、浏览器里的预览；
//   · 壳的 SharedPreferences —— 原生实际绘制用的那份，经 AndroidShell 下发。
// 壳内读取时以壳的记录为准，保证「设置里看到的」与「原生画出来的」一致。

/** 与壳通信的方法（老 APK 没有，逐项 optional）。 */
type CheckInThemeBridgeLike = {
  getCheckInTheme?: () => string;
  setCheckInTheme?: (json: string) => void;
};

function bridge(): CheckInThemeBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: CheckInThemeBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 浮层的十一级颜色。原生用 Color.parseColor 解析，故这里一律不带透明度；
 *  浮层整体的通透程度单独用 panelAlpha 表示。 */
export type CheckInOverlayColors = {
  /** 浮层主底色 */
  panel: string;
  /** 主底色不透明度 0~1 */
  panelAlpha: number;
  /** 标题与正文文字 */
  text: string;
  /** 占位文字（「顺便说一句（可选）」） */
  hint: string;
  /** 预览框底色 */
  preview: string;
  /** 收件人胶囊 / 回复框底色 */
  chip: string;
  /** 胶囊里的名字 */
  chipText: string;
  /** 主按钮（给它看 / 发给它）底色 */
  accent: string;
  /** 主按钮文字 */
  accentText: string;
  /** 次要按钮（不给 / 算了）底色 */
  muted: string;
  /** 次要按钮文字 */
  mutedText: string;
};

export type CheckInOverlayTheme = {
  key: string;
  label: string;
  colors: CheckInOverlayColors;
};

/**
 * 预设配色。
 *
 * 「暗夜」刻意与原生原来的硬编码色完全一致（0xF21B1B22 底 / 白字 /
 * 蓝主按钮）——这样没进过设置页的用户看到的还是原来那条浮层，
 * 不会有「更新完怎么变样了」的错愕。
 */
export const CHECK_IN_OVERLAY_THEMES: CheckInOverlayTheme[] = [
  {
    key: "dark", label: "暗夜",
    colors: {
      panel: "#1B1B22", panelAlpha: 0.95, text: "#FFFFFF", hint: "#8A93A6",
      preview: "#2A2A33", chip: "#2A2A33", chipText: "#C9D1E0",
      accent: "#5B7CFA", accentText: "#FFFFFF", muted: "#33333D", mutedText: "#C9D1E0",
    },
  },
  {
    key: "light", label: "浅色",
    colors: {
      panel: "#FFFFFF", panelAlpha: 0.96, text: "#1B1B22", hint: "#8A93A6",
      preview: "#F0F0F4", chip: "#F0F0F4", chipText: "#3A3A44",
      accent: "#3B82F6", accentText: "#FFFFFF", muted: "#E6E6EC", mutedText: "#5A6270",
    },
  },
  {
    key: "ocean", label: "深海",
    colors: {
      panel: "#0E1A2B", panelAlpha: 0.95, text: "#FFFFFF", hint: "#7E8DA6",
      preview: "#16263C", chip: "#16263C", chipText: "#C3D2E6",
      accent: "#4C8DFF", accentText: "#FFFFFF", muted: "#1E3048", mutedText: "#9FB0C9",
    },
  },
  {
    key: "sakura", label: "樱粉",
    colors: {
      panel: "#2A1B24", panelAlpha: 0.95, text: "#FFFFFF", hint: "#B08A9C",
      preview: "#3A2733", chip: "#3A2733", chipText: "#E0C3CF",
      accent: "#E56B9A", accentText: "#FFFFFF", muted: "#452F3C", mutedText: "#C9A3B3",
    },
  },
  {
    key: "bamboo", label: "青竹",
    colors: {
      panel: "#152419", panelAlpha: 0.95, text: "#FFFFFF", hint: "#8AA694",
      preview: "#1E3324", chip: "#1E3324", chipText: "#C0DCC8",
      accent: "#30A46C", accentText: "#FFFFFF", muted: "#27402F", mutedText: "#A3C9B3",
    },
  },
  {
    key: "violet", label: "夜幕",
    colors: {
      panel: "#1D182B", panelAlpha: 0.95, text: "#FFFFFF", hint: "#938AA6",
      preview: "#2A2440", chip: "#2A2440", chipText: "#CFC6E0",
      accent: "#9B6BFF", accentText: "#FFFFFF", muted: "#352D4D", mutedText: "#B3A9C9",
    },
  },
];

export const DEFAULT_CHECK_IN_OVERLAY_THEME = "dark";

/** 主题变更事件：设置页里的预览据此即时重绘。 */
export const CHECK_IN_OVERLAY_THEME_EVENT = "check-in-overlay-theme-changed";

export function resolveCheckInOverlayTheme(key: string | null | undefined): CheckInOverlayTheme {
  return CHECK_IN_OVERLAY_THEMES.find(item => item.key === key)
    ?? CHECK_IN_OVERLAY_THEMES.find(item => item.key === DEFAULT_CHECK_IN_OVERLAY_THEME)
    ?? CHECK_IN_OVERLAY_THEMES[0];
}

const STORAGE_KEY = "check-in-overlay-theme-v1";

type StoredShape = {
  key: string;
  /** 逐项覆盖；缺省表示完全跟随预设 */
  custom?: Partial<CheckInOverlayColors> | null;
};

/** 颜色一律规范成 #RRGGBB：原生 Color.parseColor 只认这个与 #AARRGGBB，
 *  带 alpha 的 #RRGGBBAA 会让原生解析失败并整条回落默认色。 */
function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  const long = /^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/.exec(trimmed);
  if (long) return `#${long[1]}`.toUpperCase();
  return fallback;
}

function normalizeAlpha(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeColors(raw: Partial<CheckInOverlayColors> | null | undefined, base: CheckInOverlayColors): CheckInOverlayColors {
  if (!raw || typeof raw !== "object") return { ...base };
  return {
    panel: normalizeHex(raw.panel, base.panel),
    panelAlpha: normalizeAlpha(raw.panelAlpha, base.panelAlpha),
    text: normalizeHex(raw.text, base.text),
    hint: normalizeHex(raw.hint, base.hint),
    preview: normalizeHex(raw.preview, base.preview),
    chip: normalizeHex(raw.chip, base.chip),
    chipText: normalizeHex(raw.chipText, base.chipText),
    accent: normalizeHex(raw.accent, base.accent),
    accentText: normalizeHex(raw.accentText, base.accentText),
    muted: normalizeHex(raw.muted, base.muted),
    mutedText: normalizeHex(raw.mutedText, base.mutedText),
  };
}

function readStored(): StoredShape {
  const fallback: StoredShape = { key: DEFAULT_CHECK_IN_OVERLAY_THEME, custom: null };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as StoredShape;
    const theme = resolveCheckInOverlayTheme(parsed?.key);
    const custom = parsed?.custom ? normalizeColors(parsed.custom, theme.colors) : null;
    return { key: theme.key, custom };
  } catch {
    return fallback;
  }
}

/**
 * 读当前配色：预设打底、自定义覆盖叠加。
 * 壳内优先用壳记录的那份——那是原生实际画出来的颜色，两边不一致时以它为准。
 */
export function loadCheckInOverlayColors(): CheckInOverlayColors {
  const stored = readStored();
  const theme = resolveCheckInOverlayTheme(stored.key);
  try {
    const fromShell = bridge()?.getCheckInTheme?.();
    if (fromShell) {
      const parsed = JSON.parse(fromShell) as StoredShape;
      const shellTheme = resolveCheckInOverlayTheme(parsed?.key);
      return normalizeColors(parsed?.custom, shellTheme.colors);
    }
  } catch {
    /* 桥不可用或格式不对就退回本地记录 */
  }
  return normalizeColors(stored.custom, theme.colors);
}

/** 读当前主题键（设置页回显选中项用）。 */
export function loadCheckInOverlayTheme(): string {
  const stored = readStored();
  try {
    const fromShell = bridge()?.getCheckInTheme?.();
    if (fromShell) return resolveCheckInOverlayTheme((JSON.parse(fromShell) as StoredShape)?.key).key;
  } catch {
    /* 忽略 */
  }
  return stored.key;
}

/** 读当前自定义覆盖（设置页回显）；没自定义过返回 null。 */
export function loadCheckInOverlayCustomColors(): Partial<CheckInOverlayColors> | null {
  return readStored().custom ?? null;
}

function persist(key: string, custom: Partial<CheckInOverlayColors> | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, custom }));
  } catch {
    /* 存不下就算了，本次选择照样生效 */
  }
  // 下发原生（已弹出的浮层会即时重绘）并广播给网页侧已挂载的预览
  try {
    bridge()?.setCheckInTheme?.(JSON.stringify({ key, custom }));
  } catch {
    /* 非壳环境或老 APK：忽略 */
  }
  window.dispatchEvent(new CustomEvent(CHECK_IN_OVERLAY_THEME_EVENT, { detail: { key } }));
}

/** 选一套预设（清掉之前的逐项自定义，回到该预设原样）。 */
export function saveCheckInOverlayTheme(key: string): string {
  const safe = resolveCheckInOverlayTheme(key).key;
  persist(safe, null);
  return safe;
}

/**
 * 保存逐项自定义颜色。传 null 清空自定义、回到纯预设。
 * 只覆盖传入的项，其余仍跟随预设。
 */
export function saveCheckInOverlayCustomColors(custom: Partial<CheckInOverlayColors> | null): void {
  const key = loadCheckInOverlayTheme();
  const theme = resolveCheckInOverlayTheme(key);
  persist(key, custom ? normalizeColors(custom, theme.colors) : null);
}

/** 订阅配色变更，返回取消订阅函数。 */
export function subscribeCheckInOverlayTheme(handler: (key: string) => void): () => void {
  if (typeof window === "undefined") return () => { };
  const listener = (event: Event) => {
    const key = (event as CustomEvent).detail?.key;
    if (typeof key === "string") handler(key);
  };
  window.addEventListener(CHECK_IN_OVERLAY_THEME_EVENT, listener);
  return () => window.removeEventListener(CHECK_IN_OVERLAY_THEME_EVENT, listener);
}

/** 壳是否支持自定义查岗浮层配色（老 APK 没有）。 */
export function supportsCheckInTheme(): boolean {
  return typeof bridge()?.setCheckInTheme === "function";
}
