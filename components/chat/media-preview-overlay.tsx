"use client";

import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { downloadFile } from "@/lib/download-utils";
import { isMediaStoreRef, loadMediaBlob } from "@/lib/media-cache-storage";

/** 从 data:image/...;base64,xxx 解析出 Mime 与字节 */
function dataUrlToBlob(dataUrl: string): Blob | null {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma); // 去掉开头的 "data:"
    const payload = dataUrl.slice(comma + 1);
    const mime = (meta.split(";")[0] || "application/octet-stream").trim() || "application/octet-stream";
    try {
        if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
        return null;
    }
}

/**
 * 把预览里的图片地址解析成可落盘的真实字节。
 *
 * 聊天里的 AI 生图、语音等存的是 media-store:// 引用，也有内联 data: 地址；
 * 直接丢给 downloadUrl 会先 fetch → 失败 → 退回 window.open，
 * 在安卓壳里对 blob/data 地址发 ACTION_VIEW 什么都不会发生（"点了没反应"）。
 * 所以这里先把已知的特殊地址解析成 Blob，其余（http(s) 直链）才交给 downloadUrl。
 */
async function resolvePreviewBlob(url: string): Promise<Blob | null> {
    if (url.startsWith("data:")) return dataUrlToBlob(url);
    if (isMediaStoreRef(url)) {
        const found = await loadMediaBlob(url).catch(() => null);
        return found ? found.blob : null;
    }
    return null;
}

const ACTION_BUTTON_STYLE: CSSProperties = {
    color: "#fff",
    fontSize: "calc(14px*var(--app-text-scale,1))",
    opacity: 0.85,
    border: "none",
    cursor: "pointer",
    padding: "8px 20px",
    borderRadius: 20,
    background: "rgba(255,255,255,0.15)",
    backdropFilter: "blur(8px)",
};

/**
 * 全屏媒体预览层：图片（或未生成时的文字描述）+ 下方操作按钮排。
 * 聊天、朋友圈、小卷共用——聊天流里不放常驻小按钮，保存/重新生成都收在这里。
 */
export function MediaPreviewOverlay({
    imageUrl,
    description,
    saveFilename,
    onRegenerate,
    regenerating,
    onClose,
}: {
    imageUrl?: string | null;
    description?: string;
    saveFilename?: string;
    onRegenerate?: () => void;
    regenerating?: boolean;
    onClose: () => void;
}) {
    // 保存要重新拉一次图片，慢网络下会卡一下——按钮上给个状态
    const [saving, setSaving] = useState(false);
    if (typeof document === "undefined") return null;
    return createPortal(
        <div
            style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}
            onClick={onClose}
        >
            {imageUrl ? (
                <img src={imageUrl} alt="" style={{ maxWidth: "90vw", maxHeight: "75vh", objectFit: "contain" }} />
            ) : description ? (
                <div
                    style={{ color: "#fff", opacity: 0.9, maxWidth: "min(85vw, 420px)", maxHeight: "60vh", overflowY: "auto", fontSize: "calc(14px*var(--app-text-scale,1))", lineHeight: 1.8, fontStyle: "italic", whiteSpace: "pre-wrap" }}
                    onClick={e => e.stopPropagation()}
                >
                    {description}
                </div>
            ) : null}
            <div style={{ display: "flex", gap: 12 }} onClick={e => e.stopPropagation()}>
                {imageUrl && saveFilename && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        disabled={saving}
                        onClick={async e => {
                            e.stopPropagation();
                            e.preventDefault();
                            setSaving(true);
                            try {
                                // media-store:// / data: 先解析成真实字节再落盘；
                                // 其余（http(s) 直链）沿用 downloadUrl。
                                const blob = await resolvePreviewBlob(imageUrl);
                                if (blob) {
                                    await downloadFile(blob, saveFilename);
                                } else {
                                    const { downloadUrl } = await import("@/lib/download-utils");
                                    await downloadUrl(imageUrl, saveFilename);
                                }
                            } finally {
                                setSaving(false);
                            }
                        }}
                        style={ACTION_BUTTON_STYLE}
                    >
                        {saving ? "保存中…" : "保存图片"}
                    </button>
                )}
                {onRegenerate && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        disabled={regenerating}
                        onClick={e => {
                            e.stopPropagation();
                            onRegenerate();
                        }}
                        style={ACTION_BUTTON_STYLE}
                    >
                        {regenerating ? "生成中..." : "重新生成"}
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
}
