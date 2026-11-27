"use client";

// 通话字幕条目：长按弹出「重新生成 / 编辑 / 删除」，角色的话另有一个重听按钮。
//
// 原先通话字幕只是纯展示——说错了只能挂断重来，想再听一遍也没办法。这里把
// 聊天页的消息操作搬进通话，并补一个通话特有的「重听」：通话是听觉场景，
// 「刚才那句没听清」是最自然的需求，所以做成常驻小按钮一点即播；破坏性操作
// 收进长按菜单，避免误触。
//
// 长按判定与通话小窗、原生浮窗同一套（480ms + 位移阈值），切环境手感一致。
// 菜单用 portal 挂到 body：字幕区是 overflow 滚动容器，absolute 会被裁掉。

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { BilingualTextBlock } from "./message-bubble";

/** 长按判定时长，与 call-mini-window / 原生浮窗对齐 */
const LONG_PRESS_MS = 480;
/** 位移超过它就不再算长按（手指在滚字幕时不弹菜单） */
const MOVE_SLOP = 8;

const MENU_WIDTH = 170;
const MENU_ITEM: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 12px",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
};

const REPLAY_BTN: CSSProperties = {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 24,
    height: 24,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid rgba(255,255,255,0.3)",
    background: "rgba(0,0,0,0.45)",
    color: "#fff",
    cursor: "pointer",
    padding: 0,
};

const EDIT_BTN_MUTED: CSSProperties = {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.25)",
    background: "transparent",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
};

const EDIT_BTN_PRIMARY: CSSProperties = {
    padding: "6px 16px",
    borderRadius: 8,
    border: "none",
    background: "#3B82F6",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
};

/** 长按菜单项。编辑是组件内置的，不必列在这里 */
export type CallSubtitleAction = {
    key: string;
    label: string;
    /** 删除这类危险操作用红色文字 */
    danger?: boolean;
    onSelect: () => void;
};

type CallSubtitleItemProps = {
    role: "user" | "assistant";
    text: string;
    bilingualClassName?: string;
    defaultExpanded?: boolean;
    /** 重听这一句。只给角色的话传（用户自己的话没有合成语音） */
    onReplay?: () => void;
    /** 这一句正在播放：按钮高亮 */
    replaying?: boolean;
    /** 长按菜单项（重新生成 / 删除）；为空时长按只弹「编辑」 */
    actions?: CallSubtitleAction[];
    /** 编辑提交。父组件负责改写聊天记录并同步字幕文本 */
    onEditSubmit?: (next: string) => void;
};

export function CallSubtitleItem({
    role,
    text,
    bilingualClassName,
    defaultExpanded,
    onReplay,
    replaying,
    actions,
    onEditSubmit,
}: CallSubtitleItemProps) {
    const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pressStart = useRef<{ x: number; y: number } | null>(null);
    const editingRef = useRef(false);

    useEffect(() => { editingRef.current = editing; }, [editing]);

    const clearPress = useCallback(() => {
        if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
        pressStart.current = null;
    }, []);

    useEffect(() => () => clearPress(), [clearPress]);

    const canOpenMenu = !!onEditSubmit || (!!actions && actions.length > 0);

    const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (!canOpenMenu || editingRef.current) return;
        // 点在重听按钮上时不参与长按，否则按钮还没点完菜单就弹出来了
        if ((event.target as HTMLElement).closest("[data-call-subtitle-action]") ) return;
        const point = { x: event.clientX, y: event.clientY };
        pressStart.current = point;
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            setMenuAt(point);
        }, LONG_PRESS_MS);
    }, [canOpenMenu]);

    const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const start = pressStart.current;
        if (!start) return;
        if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > MOVE_SLOP) {
            clearPress();
        }
    }, [clearPress]);

    const beginEdit = useCallback(() => {
        setMenuAt(null);
        setDraft(text);
        setEditing(true);
    }, [text]);

    const submitEdit = useCallback(() => {
        const next = draft.trim();
        setEditing(false);
        if (next && next !== text) onEditSubmit?.(next);
    }, [draft, text, onEditSubmit]);

    if (editing) {
        return (
            <div className="call-subtitle" data-role={role}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                    <textarea
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={Math.min(6, Math.max(2, draft.split("\n").length))}
                        style={{
                            width: "100%",
                            resize: "vertical",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.28)",
                            background: "rgba(0,0,0,0.35)",
                            color: "#fff",
                            padding: "8px 10px",
                            fontSize: 13.5,
                            lineHeight: 1.5,
                            fontFamily: "inherit",
                        }}
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => setEditing(false)} style={EDIT_BTN_MUTED}>取消</button>
                        <button type="button" onClick={submitEdit} style={EDIT_BTN_PRIMARY}>保存</button>
                    </div>
                </div>
            </div>
        );
    }

    // 菜单落点：贴着长按处，但不能超出视口（下缘不够就往上翻）
    const vw = typeof window !== "undefined" ? window.innerWidth : 360;
    const vh = typeof window !== "undefined" ? window.innerHeight : 640;
    const menuLeft = menuAt ? Math.min(Math.max(8, menuAt.x), Math.max(8, vw - MENU_WIDTH - 8)) : 0;
    const menuTop = menuAt ? Math.min(Math.max(8, menuAt.y), Math.max(8, vh - 190)) : 0;

    return (
        <>
            <div
                className="call-subtitle"
                data-role={role}
                style={{ position: "relative", touchAction: canOpenMenu ? "pan-y" : undefined }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onContextMenu={(e) => { if (canOpenMenu) e.preventDefault(); }}
            >
                <BilingualTextBlock
                    text={text}
                    mode="plain"
                    className={bilingualClassName}
                    defaultExpanded={defaultExpanded}
                />
                {onReplay && (
                    <button
                        type="button"
                        data-call-subtitle-action=""
                        onClick={(e) => { e.stopPropagation(); onReplay(); }}
                        aria-label={replaying ? "正在重听" : "重听这一句"}
                        title={replaying ? "正在重听" : "重听这一句"}
                        style={{
                            ...REPLAY_BTN,
                            ...(replaying ? { background: "rgba(59,130,246,0.85)", borderColor: "rgba(59,130,246,0.9)" } : {}),
                        }}
                    >
                        {replaying ? (
                            /* 播放中：声波 */
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                            </svg>
                        ) : (
                            /* 待播：喇叭 + 重播箭头 */
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M19 12a7 7 0 0 0-7-7" />
                                <polyline points="19 5 19 9 15 9" />
                            </svg>
                        )}
                    </button>
                )}
            </div>

            {menuAt && typeof document !== "undefined" && createPortal(
                <div
                    data-call-subtitle-menu=""
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ position: "fixed", inset: 0, zIndex: 300 }}
                    onClick={() => setMenuAt(null)}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            position: "absolute",
                            left: menuLeft,
                            top: menuTop,
                            width: MENU_WIDTH,
                            padding: 6,
                            borderRadius: 14,
                            background: "rgba(24,24,30,0.96)",
                            backdropFilter: "blur(12px)",
                            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                            border: "1px solid rgba(255,255,255,0.1)",
                        }}
                    >
                        {onEditSubmit && (
                            <button type="button" style={MENU_ITEM} onClick={beginEdit}>编辑这一句</button>
                        )}
                        {(actions ?? []).map((action) => (
                            <button
                                key={action.key}
                                type="button"
                                style={{ ...MENU_ITEM, ...(action.danger ? { color: "#FF6B6B" } : {}) }}
                                onClick={() => { setMenuAt(null); action.onSelect(); }}
                            >
                                {action.label}
                            </button>
                        ))}
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}
