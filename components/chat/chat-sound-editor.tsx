"use client";

// 提示音设置的共用 UI：音效种类列表 + 音频来源编辑器（文件 / URL / 试听 / 清除）。
// 两个设置页共用：全局聊天信息（全局提示音）与私聊聊天信息（角色专属提示音）。

import { useRef, useState } from "react";
import { AudioLines, MessageSquare, PhoneIncoming, PhoneOff, PhoneOutgoing, Play, Send, X, type LucideIcon } from "lucide-react";
import type { ChatSoundConfig, ChatSoundKind } from "@/lib/chat-storage";
import { saveChatAudioToIndexedDB } from "@/lib/chat-asset-storage";

export const SOUND_ITEMS: {
    kind: ChatSoundKind;
    icon: LucideIcon;
    label: string;
    desc: string;
}[] = [
    { kind: "newMessage", icon: MessageSquare, label: "新消息音效", desc: "角色发来新消息时播放" },
    { kind: "sendMessage", icon: Send, label: "发送消息音效", desc: "发出消息时播放" },
    { kind: "incomingCall", icon: PhoneIncoming, label: "来电音效", desc: "来电等待接听时循环播放" },
    { kind: "outgoingCall", icon: PhoneOutgoing, label: "致电音效", desc: "呼叫等待接通时循环播放" },
    { kind: "hangup", icon: PhoneOff, label: "挂断音效", desc: "通话结束或挂断时播放" },
];

/**
 * 音频来源编辑器：选择音频文件 / 填音频 URL / 试听 / 清除。
 * 只负责编辑传入的 config，不关心它存在全局还是会话里。
 */
export function ChatSoundSourceEditor({ config, emptyHint, canPreview, onPatch, onPreview }: {
    config: ChatSoundConfig;
    /** 没有音频时的提示文案（默认“未设置音频”；会话页全局配了音频时提示沿用全局） */
    emptyHint?: string;
    /** 试听按钮是否可用（默认按 config.value 判断；会话页全局也配了音频时允许试听） */
    canPreview?: boolean;
    onPatch: (patch: Partial<ChatSoundConfig>) => void;
    onPreview: () => void;
}) {
    const [urlDraft, setUrlDraft] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const changeFile = async (file?: File) => {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert("音频文件过大，请控制在 8MB 以内"); return; }
        try {
            const id = await saveChatAudioToIndexedDB(file);
            onPatch({ sourceType: "file", value: id });
        } catch { alert("音频文件保存失败，请换一个文件重试"); }
    };

    const applyUrl = () => {
        const url = urlDraft.trim();
        if (!url) return;
        if (!/^(https?:\/\/|data:audio)/i.test(url)) { alert("请输入 http(s) 开头的音频链接"); return; }
        onPatch({ sourceType: "url", value: url });
    };

    const hasSource = Boolean(config.value);
    const previewEnabled = canPreview === undefined ? hasSource : canPreview;
    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac"
                className="hidden"
                onChange={event => { void changeFile(event.target.files?.[0]); event.target.value = ""; }}
            />
            <div className="chat-sound-editor-row">
                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={() => fileInputRef.current?.click()}>
                    <AudioLines size={14} /> 选择音频文件
                </button>
                <span className="chat-sound-source">
                    {config.sourceType === "file" ? "已用音频文件" : config.sourceType === "url" ? "已用音频 URL" : (emptyHint || "未设置音频")}
                </span>
                <div className="chat-sound-editor-actions">
                    <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" disabled={!previewEnabled} onClick={onPreview} aria-label="试听" title="试听"><Play size={14} /></button>
                    {hasSource ? (
                        <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => onPatch({ sourceType: undefined, value: undefined })} aria-label="清除音频" title="清除音频"><X size={14} /></button>
                    ) : null}
                </div>
            </div>
            <div className="chat-sound-editor-row">
                <span className="chat-sound-or">或</span>
                <input
                    className="ui-input flex-1 h-8 ts-12"
                    placeholder="输入音频 URL（mp3 / wav 等）"
                    value={urlDraft || (config.sourceType === "url" ? config.value || "" : "")}
                    onChange={event => setUrlDraft(event.target.value)}
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <button className="ui-btn ui-btn-soft-action" onClick={applyUrl}>使用</button>
            </div>
        </>
    );
}
