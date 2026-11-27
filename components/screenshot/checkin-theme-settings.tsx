"use client";

// 查岗 / 截屏确认浮层的配色设置。
//
// 与「通话浮窗外观」同一套交互（见 components/settings/call-overlay-settings.tsx）：
//   · 选预设 —— 一键换整套配色（6 套）；
//   · 逐项自定义 —— 想单独调某一级颜色时用它，改动叠在预设之上，
//     没动到的项仍跟随预设。
//
// 为什么这条浮层尤其需要「能自己调」：它上面显示的是**整屏画面**。
// 用户对这个框的观感直接决定他敢不敢用——一个来路不明的黑框，
// 和一块看得出是自己挑的颜色，心理上完全是两回事。
//
// 壳里由原生绘制（CheckInService + CheckInOverlayTheme），非壳环境只预览。

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import {
    CHECK_IN_OVERLAY_THEMES,
    type CheckInOverlayColors,
    loadCheckInOverlayColors,
    loadCheckInOverlayCustomColors,
    loadCheckInOverlayTheme,
    saveCheckInOverlayCustomColors,
    saveCheckInOverlayTheme,
    subscribeCheckInOverlayTheme,
    supportsCheckInTheme,
} from "@/lib/screenshot";

/** 可逐项自定义的颜色字段（不含 panelAlpha，它单独用滑杆）。 */
const COLOR_FIELDS: Array<{ key: keyof Omit<CheckInOverlayColors, "panelAlpha">; label: string; hint: string }> = [
    { key: "panel", label: "浮层底色", hint: "整块面板" },
    { key: "text", label: "正文文字", hint: "标题与说明" },
    { key: "hint", label: "占位文字", hint: "「顺便说一句」" },
    { key: "preview", label: "预览框底色", hint: "截图的垫底" },
    { key: "chip", label: "胶囊底色", hint: "收件人 / 回复框" },
    { key: "chipText", label: "胶囊文字", hint: "角色名字" },
    { key: "accent", label: "主按钮底色", hint: "「给它看」" },
    { key: "accentText", label: "主按钮文字", hint: "那两个字" },
    { key: "muted", label: "次按钮底色", hint: "「不给」" },
    { key: "mutedText", label: "次按钮文字", hint: "那两个字" },
];

/** #RRGGBB + 0~1 透明度 → rgba()；给网页预览用，原生走另一套 argb。 */
function withAlpha(hex: string, alpha: number): string {
    const clean = hex.replace(/^#/, "");
    if (clean.length !== 6) return hex;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (![r, g, b].every(Number.isFinite)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function CheckInThemeSettings() {
    const [themeKey, setThemeKey] = useState(() => loadCheckInOverlayTheme());
    const [colors, setColors] = useState<CheckInOverlayColors>(() => loadCheckInOverlayColors());
    const [custom, setCustom] = useState<Partial<CheckInOverlayColors> | null>(() => loadCheckInOverlayCustomColors());
    const [customOpen, setCustomOpen] = useState(false);

    // 别处改了配色（原生侧或另一页面）也跟着刷新
    useEffect(() => subscribeCheckInOverlayTheme(key => {
        setThemeKey(key);
        setColors(loadCheckInOverlayColors());
        setCustom(loadCheckInOverlayCustomColors());
    }), []);

    const choose = useCallback((key: string) => {
        // 换预设 = 回到该预设原样，清掉之前的逐项改动（否则会串味，用户会困惑）
        const saved = saveCheckInOverlayTheme(key);
        setThemeKey(saved);
        setCustom(null);
        setColors(loadCheckInOverlayColors());
    }, []);

    const patch = useCallback((next: Partial<CheckInOverlayColors>) => {
        // 叠加在预设之上：没动到的项仍跟随预设，不必把十来项全存一遍
        const merged = { ...(custom ?? {}), ...next };
        saveCheckInOverlayCustomColors(merged);
        setCustom(merged);
        setColors(loadCheckInOverlayColors());
    }, [custom]);

    const resetCustom = useCallback(() => {
        saveCheckInOverlayCustomColors(null);
        setCustom(null);
        setColors(loadCheckInOverlayColors());
    }, []);

    const inShell = typeof window !== "undefined" && Boolean((window as unknown as { AndroidShell?: unknown }).AndroidShell);

    return (
        <div>
            <div className="settings-menu-section-title">确认浮层外观</div>

            <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
                角色查岗、以及你点悬浮球截屏时，弹出的那个确认框长什么样。
            </div>

            {/* ── 实时预览：改一下就在这里变一下，不用真去触发一次截屏 ── */}
            <div className="menu-group" style={{ marginTop: 10, padding: 12 }}>
                <div
                    style={{
                        borderRadius: 18,
                        padding: 14,
                        background: withAlpha(colors.panel, colors.panelAlpha),
                        boxShadow: "0 10px 28px rgba(10, 13, 20, 0.18)",
                    } as CSSProperties}
                >
                    <div style={{ color: colors.text, fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>
                        TA 想看看你在干嘛…
                    </div>
                    <div
                        style={{
                            height: 84,
                            borderRadius: 12,
                            background: colors.preview,
                            display: "grid",
                            placeItems: "center",
                            color: colors.hint,
                            fontSize: 11.5,
                            marginBottom: 10,
                        }}
                    >截到的画面显示在这里</div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                        <span style={{ padding: "4px 11px", borderRadius: 999, background: colors.chip, color: colors.chipText, fontSize: 11.5 }}>角色 A</span>
                        <span style={{ padding: "4px 11px", borderRadius: 999, background: colors.accent, color: colors.accentText, fontSize: 11.5 }}>选中的这位</span>
                    </div>
                    <div style={{ borderRadius: 10, padding: "8px 10px", background: colors.chip, color: colors.hint, fontSize: 12, marginBottom: 10 }}>
                        顺便说一句（可选）
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <span style={{ padding: "7px 16px", borderRadius: 10, background: colors.muted, color: colors.mutedText, fontSize: 12.5 }}>不给</span>
                        <span style={{ padding: "7px 16px", borderRadius: 10, background: colors.accent, color: colors.accentText, fontSize: 12.5, fontWeight: 600 }}>给它看</span>
                    </div>
                </div>
            </div>

            {/* ── 预设 ── */}
            <div className="menu-group" style={{ marginTop: 10 }}>
                {/* 纵向排布：色板有 6 个圆点、横着放会把「配色预设」压成一字一行。
                    标签占一行、色板在下一行，任何屏宽都不会互相挤。 */}
                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
                    <div className="menu-label-group">
                        <span className="menu-label">配色预设</span>
                        <span className="menu-desc">选一套整套换掉</span>
                    </div>
                    <div className="menu-right" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-start" }}>
                        {CHECK_IN_OVERLAY_THEMES.map(theme => {
                            const selected = themeKey === theme.key;
                            return (
                                <button
                                    key={theme.key}
                                    type="button"
                                    aria-label={`${theme.label}配色`}
                                    title={theme.label}
                                    onClick={() => choose(theme.key)}
                                    style={{
                                        width: 34,
                                        height: 34,
                                        padding: 0,
                                        borderRadius: 999,
                                        border: selected ? "2px solid var(--c-text-title)" : "1px solid rgba(0,0,0,.14)",
                                        background: `linear-gradient(135deg, ${theme.colors.accent} 0%, ${theme.colors.accent} 48%, ${withAlpha(theme.colors.panel, 1)} 52%, ${withAlpha(theme.colors.panel, 1)} 100%)`,
                                        opacity: selected ? 1 : 0.6,
                                        cursor: "pointer",
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
                <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-label-group">
                        <span className="menu-label">{CHECK_IN_OVERLAY_THEMES.find(t => t.key === themeKey)?.label || "自定义"}</span>
                        <span className="menu-desc">{custom ? "已在此基础上逐项微调" : "当前整套跟随预设"}</span>
                    </div>
                    {custom ? (
                        <button type="button" className="ui-btn ui-btn-outline" onClick={resetCustom}>
                            还原预设
                        </button>
                    ) : null}
                </div>
            </div>

            {/* ── 通透程度 ── */}
            <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                    <div className="menu-label-group">
                        <span className="menu-label">浮层通透程度</span>
                        <span className="menu-desc">当前 {Math.round(colors.panelAlpha * 100)}%</span>
                    </div>
                    <input
                        type="range"
                        min={40}
                        max={100}
                        value={Math.round(colors.panelAlpha * 100)}
                        style={{ maxWidth: 140, width: 140 }}
                        aria-label="浮层通透程度"
                        onChange={e => patch({ panelAlpha: Number(e.target.value) / 100 })}
                    />
                </div>
            </div>

            {/* ── 逐项自定义：默认收起，避免一屏全是取色器 ── */}
            <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-label-group">
                        <span className="menu-label">逐项调色</span>
                        <span className="menu-desc">只想改某一处时用它</span>
                    </div>
                    <button type="button" className="ui-btn ui-btn-outline" onClick={() => setCustomOpen(v => !v)}>
                        {customOpen ? "收起" : "展开"}
                    </button>
                </div>

                {customOpen && COLOR_FIELDS.map(field => (
                    <div className="menu-item" key={field.key} style={{ cursor: "default" }}>
                        <div className="menu-label-group">
                            <span className="menu-label">{field.label}</span>
                            <span className="menu-desc">{field.hint}</span>
                        </div>
                        <input
                            type="color"
                            value={colors[field.key]}
                            aria-label={field.label}
                            onChange={e => patch({ [field.key]: e.target.value.toUpperCase() } as Partial<CheckInOverlayColors>)}
                            style={{ width: 44, height: 30, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
                        />
                    </div>
                ))}
            </div>

            {!inShell && (
                <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                    当前不在小手机 App 内（浏览器/PWA），保存的配色要等装到手机上才看得见；上面是等比例预览。
                </div>
            )}
            {inShell && !supportsCheckInTheme() && (
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                    当前 App 版本还不支持自定义这个浮层的配色，需要更新安卓壳；设置会先存着，更新后自动生效。
                </div>
            )}
        </div>
    );
}
