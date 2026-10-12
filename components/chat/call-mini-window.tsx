"use client";

// 通话悬浮小窗：可拖动、可缩放，点一下回到全屏通话。
//
// 原先三个通话屏各自渲染一个位置写死的小窗（.call-mini-window）：固定在角落、
// 尺寸固定，挡着别的界面时只能忍着。这里统一成一个组件——按住拖动移动，
// 右下角拖拽缩放，位置与尺寸记在本地，下一次通话还是这个样子。
//
// 只负责「显示」：通话本身（识别 / 播放 / 计时）在各通话屏里继续跑，
// 这里是回到全屏的入口，不碰任何通话逻辑。
//
// 三种手势（与安卓壳原生浮窗对齐，切换环境时手感一致）：
//   · 轻点 → 回全屏通话；
//   · 拖动 → 挪位置（右下角拖拽缩放）；
//   · 长按 → 就地弹出快捷回复条，不跳回通话界面。
// 长按弹回复这一点原先只有桌面原生浮窗有，手机里的小窗没有，于是长按
// 被当成「没有位移的轻点」直接跳回通话页——本文件补齐。
//
// 用 portal 挂到 body：手机壳内部有 overflow / transform 布局，
// 直接挂在里面时 fixed 定位可能被裁剪或算错参照点。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { loadCallOverlayColors, subscribeCallOverlayTheme } from "@/lib/call-overlay-theme";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";

type CallMiniWindowProps = {
    /** 小窗背景图（角色头像 / 通话背景），没有就用纯色底 */
    imageUrl?: string | null;
    title: string;
    /** 底部信息行，自上而下逐行显示（如时长、通话类型）。
     *  拆成数组而不是拼成一句：窗口可以缩到 88px 宽，拼成一句必被截断，
     *  拆行后每行各自省略，信息不会丢。 */
    meta?: string[];
    ariaLabel: string;
    /** 点一下小窗（没有拖动）时回到全屏通话 */
    onRestore?: () => void;
    /** 排队待发的消息条数。>0 时小窗上挂一个小角标——用户从这条回复条
     *  发了话、角色正在说，消息会排到它说完再发，得让人看得见没丢。 */
    pendingCount?: number;
    /** 长按小窗弹出的快捷回复：与通话界面里的输入走同一条通路。
     *  返回 false 表示没被受理（如排队已满），此时保留输入内容不丢；
     *  不传则不弹输入条（长按等同轻点，保持旧行为）。 */
    onReply?: (text: string) => boolean | void;
};

const MIN_W = 88;
const MIN_H = 120;
const MAX_W = 320;
const MAX_H = 460;
const DEFAULT_W = 108;
const DEFAULT_H = 150;
/** 距屏幕边缘留白 */
const EDGE = 14;
/** 拖动判定阈值：位移超过它才算拖动，否则算点击 */
const DRAG_SLOP = 5;
/** 长按判定：按住这么久且没位移 = 弹快捷回复条（与原生浮窗的 480ms 对齐） */
const LONG_PRESS_MS = 480;
const STORAGE_KEY = "call-mini-window-geometry-v1";

type Geometry = { x: number; y: number; w: number; h: number };

/** #RRGGBB + 透明度 → rgba()。主题里颜色一律不带 alpha（原生 Color.parseColor
 *  只认 #RRGGBB，带 alpha 的 #RRGGBBAA 会让它整条回落默认色），透明度单独存。 */
function hexToRgba(hex: string, alpha: number): string {
    const value = hex.replace("#", "");
    if (value.length !== 6) return hex;
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function viewport() {
    if (typeof window === "undefined") return { w: 390, h: 844 };
    return { w: window.innerWidth, h: window.innerHeight };
}

function clampGeometry(input: Geometry): Geometry {
    const vp = viewport();
    const maxW = Math.min(MAX_W, Math.max(MIN_W, vp.w - EDGE * 2));
    const maxH = Math.min(MAX_H, Math.max(MIN_H, vp.h - EDGE * 2));
    const w = Math.min(Math.max(input.w, MIN_W), maxW);
    const h = Math.min(Math.max(input.h, MIN_H), maxH);
    const maxX = Math.max(EDGE, vp.w - w - EDGE);
    const maxY = Math.max(EDGE, vp.h - h - EDGE);
    const x = Math.min(Math.max(input.x, EDGE), maxX);
    const y = Math.min(Math.max(input.y, EDGE), maxY);
    return { x, y, w, h };
}

/** 默认位置：右侧靠下，避开大多数 App 的底部操作栏 */
function defaultGeometry(): Geometry {
    const vp = viewport();
    return clampGeometry({
        w: DEFAULT_W,
        h: DEFAULT_H,
        x: vp.w - DEFAULT_W - EDGE,
        y: vp.h - DEFAULT_H - 150,
    });
}

function readStoredGeometry(): Geometry | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Geometry>;
        if (typeof parsed.x !== "number" || typeof parsed.y !== "number"
            || typeof parsed.w !== "number" || typeof parsed.h !== "number") {
            return null;
        }
        if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)
            || !Number.isFinite(parsed.w) || !Number.isFinite(parsed.h)) {
            return null;
        }
        return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
    } catch {
        return null;
    }
}

export function CallMiniWindow({ imageUrl, title, meta, ariaLabel, onRestore, onReply, pendingCount = 0 }: CallMiniWindowProps) {
    const [geo, setGeo] = useState<Geometry>(() => defaultGeometry());
    const [mounted, setMounted] = useState(false);
    // 长按弹出的快捷回复条。原生浮窗那边是另开一个独立窗口，网页里没有窗口
    // 概念，就把一条 fixed 输入条挂在小窗旁边，发完自动收起。
    const [showReply, setShowReply] = useState(false);
    const [replyText, setReplyText] = useState("");
    // 回复条配色：与壳里那条原生回复条共用同一份配色（含逐项自定义），改一次两边都变
    const [colors, setColors] = useState(() => loadCallOverlayColors());
    useEffect(() => subscribeCallOverlayTheme(() => setColors(loadCallOverlayColors())), []);
    // 键盘高度（供贴底输入条避让；小窗本体不需要，它是 fixed 定位）
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const replyInputRef = useRef<HTMLInputElement | null>(null);
    const longPressRef = useRef<number | null>(null);
    // 长按是否已触发：抬手时不能再当成「轻点回全屏」，
    // 否则长按弹输入条的同时会顺带跳回通话界面。
    const longPressFiredRef = useRef(false);
    const geoRef = useRef(geo);
    const dragRef = useRef<{ id: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const resizeRef = useRef<{ id: number; startX: number; startY: number; originW: number; originH: number; moved: boolean } | null>(null);

    useEffect(() => { geoRef.current = geo; }, [geo]);
    useEffect(() => { setMounted(true); }, []);

    // 首次挂载：用记住的位置尺寸；没有（或越界）则回落默认位
    useEffect(() => {
        const stored = readStoredGeometry();
        if (stored) setGeo(clampGeometry(stored));
    }, []);

    // 旋转 / 键盘弹出导致视口变化时，把小窗拉回可见范围
    useEffect(() => {
        const onResize = () => setGeo(prev => clampGeometry(prev));
        window.addEventListener("resize", onResize);
        window.addEventListener("orientationchange", onResize);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("orientationchange", onResize);
        };
    }, []);

    // 记位置（拖动/缩放停下来再写，省得每帧都碰 localStorage）
    useEffect(() => {
        const id = window.setTimeout(() => {
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(geo));
            } catch {
                /* 隐私模式写不了就算了，不影响这次拖动 */
            }
        }, 260);
        return () => window.clearTimeout(id);
    }, [geo]);

    const clearLongPress = useCallback(() => {
        if (longPressRef.current !== null) {
            window.clearTimeout(longPressRef.current);
            longPressRef.current = null;
        }
    }, []);

    // 组件卸载时清掉挂起的长按定时器，免得在已卸载的组件上 setState
    useEffect(() => clearLongPress, [clearLongPress]);

    const handleDragDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // 右下角缩放柄自己处理指针，不参与拖动
        if ((event.target as HTMLElement).closest("[data-call-mini-resize]")) return;
        // 回复条内部的指针（选中文字、点按钮）不参与拖动
        if ((event.target as HTMLElement).closest("[data-call-mini-reply]")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: geoRef.current.x,
            originY: geoRef.current.y,
            moved: false,
        };
        // 长按用延时任务判定，而不是抬手时看按住时长：
        // 按住约半秒就立刻弹出输入条，不用等手指抬起（与原生浮窗一致）。
        longPressFiredRef.current = false;
        if (onReply) {
            longPressRef.current = window.setTimeout(() => {
                longPressRef.current = null;
                longPressFiredRef.current = true;
                dragRef.current = null;
                setShowReply(true);
            }, LONG_PRESS_MS);
        }
    }, [onReply]);

    const handleDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) {
            drag.moved = true;
            // 一旦移动就取消长按：拖动时不该弹出输入条
            clearLongPress();
        }
        if (!drag.moved) return;
        setGeo(prev => clampGeometry({ ...prev, x: drag.originX + dx, y: drag.originY + dy }));
    }, [clearLongPress]);

    const handleDragUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        clearLongPress();
        // 长按已经弹了输入条：这一下不算点击，别把通话界面又拉回来
        if (longPressFiredRef.current) return;
        // 没移动 = 点击：回全屏。拖动过就不触发，免得手一抖就跳回通话界面
        if (!drag.moved) onRestore?.();
    }, [clearLongPress, onRestore]);

    const handleResizeDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        clearLongPress();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originW: geoRef.current.w,
            originH: geoRef.current.h,
            moved: false,
        };
    }, []);

    const handleResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.id !== event.pointerId) return;
        const dx = event.clientX - resize.startX;
        const dy = event.clientY - resize.startY;
        if (!resize.moved && Math.abs(dx) + Math.abs(dy) > 2) resize.moved = true;
        setGeo(prev => clampGeometry({ ...prev, w: resize.originW + dx, h: resize.originH + dy }));
    }, []);

    const handleResizeUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.id !== event.pointerId) return;
        resizeRef.current = null;
    }, []);

    // 输入条弹出后自动聚焦（移动端键盘随之而来）
    useEffect(() => {
        if (!showReply) return;
        const id = window.setTimeout(() => replyInputRef.current?.focus(), 30);
        return () => window.clearTimeout(id);
    }, [showReply]);

    const submitReply = useCallback(() => {
        const text = replyText.trim();
        if (!text) return;
        // 与通话界面里手动输入完全同一条通路：会落聊天记录、触发角色回复与 TTS。
        // 受理不了（排队已满）时保留内容并留在输入条上，别让用户以为发出去了。
        const accepted = onReply?.(text);
        if (accepted === false) return;
        setShowReply(false);
        setReplyText("");
    }, [onReply, replyText]);

    if (!mounted) return null;

    const node = (
        <div
            className="call-mini-window"
            style={{
                position: "fixed",
                left: geo.x,
                top: geo.y,
                right: "auto",
                bottom: "auto",
                width: geo.w,
                height: geo.h,
                margin: 0,
                padding: 0,
                border: "none",
                borderRadius: 16,
                overflow: "hidden",
                boxSizing: "border-box",
                zIndex: 9000,
                touchAction: "none",
                cursor: "grab",
                background: "#1b1b22",
                backgroundSize: "cover",
                backgroundPosition: "center",
                boxShadow: "0 10px 30px rgba(0,0,0,0.42)",
                ...(imageUrl ? { backgroundImage: `url(${imageUrl})` } : {}),
            }}
            onPointerDown={handleDragDown}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragUp}
            onPointerCancel={handleDragUp}
            role="button"
            tabIndex={0}
            aria-label={ariaLabel}
            title="拖动可移动 · 右下角可缩放 · 点一下回到通话"
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRestore?.();
                }
            }}
        >
            <span
                className="call-mini-window-overlay"
                style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.05) 30%, rgba(0,0,0,0.62) 100%)", pointerEvents: "none" }}
            />
            {/* 底部信息栈：名字 + 逐行 meta，从下往上贴着窗口底部排。
                左右留 10px，避免最下面那行跑到右下角缩放柄底下。 */}
            <div
                style={{
                    position: "absolute", left: 0, right: 0, bottom: 0,
                    display: "flex", flexDirection: "column", alignItems: "center",
                    gap: 1, padding: "0 10px 7px", pointerEvents: "none",
                }}
            >
                <span
                    className="call-mini-window-name"
                    style={{ maxWidth: "100%", fontSize: 12, fontWeight: 600, lineHeight: 1.25, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                    {title}
                </span>
                {(meta ?? []).map((line, index) => (
                    <span
                        key={`${index}-${line}`}
                        style={{ maxWidth: "100%", fontSize: 10.5, lineHeight: 1.25, color: "rgba(255,255,255,0.88)", textShadow: "0 1px 4px rgba(0,0,0,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    >
                        {line}
                    </span>
                ))}
            </div>
            {/* 待发送角标：有排队消息时显示，点开小窗可按提示查看 */}
            {pendingCount > 0 && (
                <span
                    style={{
                        position: "absolute", top: 4, left: 4, zIndex: 4,
                        padding: "2px 7px", borderRadius: 999,
                        background: "rgba(20,20,26,0.82)", backdropFilter: "blur(6px)",
                        color: "#fff", fontSize: 10, lineHeight: 1.4,
                        whiteSpace: "nowrap", pointerEvents: "none",
                    }}
                >
                    待发 {pendingCount}
                </span>
            )}
            {/* 右下角缩放柄：拖它改小窗大小 */}
            <span
                data-call-mini-resize=""
                onPointerDown={handleResizeDown}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeUp}
                onPointerCancel={handleResizeUp}
                style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "flex-end",
                    padding: 4,
                    cursor: "nwse-resize",
                    touchAction: "none",
                    zIndex: 3,
                    color: "rgba(255,255,255,0.9)",
                }}
                aria-hidden
            >
                <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M11 4L4 11" />
                    <path d="M11 8L8 11" />
                </svg>
            </span>
        </div>
    );

    // 长按弹出的快捷回复条：贴页面底部，跟着键盘一起顶上来。
    //
    // 原先是挂在小窗旁边（正上方或正下方），结果小窗就在那一带时输入条会
    // 直接盖住小窗——小窗是通话的唯一入口，被盖住就点不到了。改成通栏贴底：
    // 它只占屏幕最下面一条，小窗一般悬在中上或右侧，两者不再打架。
    //
    // 键盘避让交给 --call-keyboard-offset（useCallKeyboardOffsetStyle 实测写入）：
    // Android 壳里键盘由原生容器内边距让位、WebView 本身变矮，iOS 走
    // visualViewport 实测，两条路在这个变量上统一。
    const replyNode = showReply ? (
        <div
            data-call-mini-reply=""
            style={{
                ...keyboardOffsetStyle,
                position: "fixed",
                left: 8,
                right: 8,
                bottom: "calc(8px + var(--call-keyboard-offset, 0px))",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 12,
                // 条身透明度单独一项：主题里存 #RRGGBB + barAlpha，这里拼成 rgba，
                // 与原生 Color.argb 出来的结果一致
                background: hexToRgba(colors.bar, colors.barAlpha),
                boxShadow: "0 8px 24px rgba(0,0,0,0.42)",
                zIndex: 9001,
                touchAction: "manipulation",
            }}
        >
            <input
                ref={replyInputRef}
                value={replyText}
                onChange={(event) => setReplyText(event.target.value)}
                onKeyDown={(event) => {
                    // 回车发送，与通话界面输入框一致；Esc 收起
                    if (event.key === "Enter") { event.preventDefault(); submitReply(); }
                    if (event.key === "Escape") { event.preventDefault(); setShowReply(false); setReplyText(""); }
                }}
                placeholder="说点什么…"
                aria-label="快捷回复"
                style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: colors.text,
                    fontSize: 13,
                    padding: "4px 2px",
                }}
            />
            <button
                type="button"
                onClick={submitReply}
                disabled={!replyText.trim()}
                aria-label="发送"
                style={{
                    flexShrink: 0,
                    border: "none",
                    borderRadius: 8,
                    padding: "5px 11px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: colors.sendText,
                    background: replyText.trim() ? colors.accent : "rgba(128,128,128,0.28)",
                    cursor: replyText.trim() ? "pointer" : "default",
                }}
            >
                发送
            </button>
            {/* 只有「发送」和「收起」。
                原先还有个「回到通话」——想回全屏直接轻点小窗即可，一条窄条上
                挤三个按钮反而容易点错，故去掉。 */}
            <button
                type="button"
                onClick={() => { setShowReply(false); setReplyText(""); }}
                aria-label="收起"
                title="收起"
                style={{
                    flexShrink: 0,
                    border: "none",
                    background: "transparent",
                    color: colors.muted,
                    fontSize: 12.5,
                    padding: "5px 4px",
                    cursor: "pointer",
                }}
            >
                收起
            </button>
        </div>
    ) : null;

    return createPortal(<>{node}{replyNode}</>, document.body);
}
