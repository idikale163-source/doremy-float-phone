"use client";

// 私聊聊天信息 → 角色专属提示音。
// 每种音效三档：跟随全局（默认）/ 专属（该角色用自己的音频）/ 关闭（该角色不播）。
// 解析规则见 lib/chat-storage.ts 的 resolveChatSoundConfig：
// 会话里显式设置的字段覆盖全局，其余（音频来源、子开关）继承全局。

import { useState, type CSSProperties } from "react";
import { BellRing } from "lucide-react";
import {
    loadChatAppSettings,
    type ChatSession,
    type ChatSoundConfig,
    type ChatSoundKind,
    type ChatSoundsConfig,
} from "@/lib/chat-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { previewChatSound } from "@/lib/chat-sound";
import { Toggle } from "@/components/ui/form";
import { ChatSoundSourceEditor, SOUND_ITEMS } from "./chat-sound-editor";

type SoundMode = "inherit" | "custom" | "off";

function soundModeOf(config?: ChatSoundConfig): SoundMode {
    if (config?.enabled === true) return "custom";
    if (config?.enabled === false) return "off";
    return "inherit";
}

const MODE_OPTIONS: [SoundMode, string][] = [
    ["inherit", "全局"],
    ["custom", "专属"],
    ["off", "关闭"],
];

export function SessionChatSoundsSection({ session, accent, onUpdate }: {
    session: ChatSession;
    /** 图标圆片颜色，与聊天信息页其它行保持一致 */
    accent: string;
    onUpdate: (updates: Partial<ChatSession>) => void;
}) {
    const [sounds, setSounds] = useState<ChatSoundsConfig>(() => session.sounds || {});
    const globalSounds = loadChatAppSettings().globalChatSounds || {};

    const changeSound = (kind: ChatSoundKind, patch: Partial<ChatSoundConfig>) => {
        setSounds(current => {
            const next: ChatSoundsConfig = { ...current, [kind]: { ...current[kind], ...patch } };
            onUpdate({ sounds: next });
            return next;
        });
    };

    const setMode = (kind: ChatSoundKind, mode: SoundMode) => {
        if (mode === "inherit") {
            // 跟随全局：删掉本会话对该种音效的全部覆盖
            setSounds(current => {
                const next: ChatSoundsConfig = { ...current };
                delete next[kind];
                onUpdate({ sounds: next });
                return next;
            });
            return;
        }
        // 关闭只改开关，保留已配的音频；切回专属时还能接着用
        changeSound(kind, { enabled: mode === "custom" });
    };

    const clearSubToggle = (kind: ChatSoundKind, key: "muteActiveChat" | "notifyOncePerBurst") => {
        setSounds(current => {
            const own: ChatSoundConfig = { ...(current[kind] || {}) };
            delete own[key];
            const next: ChatSoundsConfig = { ...current, [kind]: own };
            onUpdate({ sounds: next });
            return next;
        });
    };

    // 新消息音效“测试弹窗”：用当前角色会话模拟一条真实新消息——
    // 播放该角色生效的音效（专属优先全局）+ 弹桌面通知横幅。
    const testNewMessageNotice = () => {
        void previewChatSound("newMessage", session);
        dispatchChatMessageNotice({
            sessionId: session.id,
            body: "【提示音测试】模拟收到一条新消息",
            isTest: true,
        });
    };

    return (
        <div className="menu-group">
            {SOUND_ITEMS.map(({ kind, icon: Icon, label, desc }) => {
                const own: ChatSoundConfig = sounds[kind] || {};
                const globalConfig: ChatSoundConfig = globalSounds[kind] || {};
                const mode = soundModeOf(sounds[kind]);
                const globalOn = globalConfig.enabled === true && Boolean(globalConfig.value);
                return (
                    <div key={kind} className="chat-sound-block">
                        <div className="menu-item">
                            <span className="chat-info-icon" style={{ "--icon-color": accent } as CSSProperties}>
                                <Icon size={22} strokeWidth={1.75} />
                            </span>
                            <div className="menu-label-group">
                                <span className="menu-label">{label}</span>
                                <span className="menu-desc">
                                    {mode === "inherit"
                                        ? `跟随全局${globalOn ? "（全局已开）" : "（全局未开）"}`
                                        : mode === "off"
                                            ? "该角色不播放此音效"
                                            : desc}
                                </span>
                            </div>
                            <div className="menu-right">
                                <div className="chat-sound-mode" role="group" aria-label={`${label}模式`}>
                                    {MODE_OPTIONS.map(([value, text]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            className={mode === value ? "is-active" : ""}
                                            onClick={() => setMode(kind, value)}
                                        >
                                            {text}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                        {mode === "custom" ? (
                            <div className="chat-sound-editor chat-sound-editor-session">
                                <ChatSoundSourceEditor
                                    config={own}
                                    emptyHint={globalConfig.value ? "未单独设置，将用全局音频" : "未设置音频"}
                                    canPreview={Boolean(own.value || globalConfig.value)}
                                    onPatch={patch => changeSound(kind, patch)}
                                    onPreview={() => void previewChatSound(kind, session)}
                                />
                                {kind === "newMessage" ? (
                                    <>
                                        <div className="chat-sound-subtoggles">
                                            <SubToggle
                                                label="实时聊天不通知"
                                                desc="正打开该聊天时，角色新消息不播放音效"
                                                checked={own.muteActiveChat ?? globalConfig.muteActiveChat ?? false}
                                                explicit={own.muteActiveChat !== undefined}
                                                onChange={checked => changeSound(kind, { muteActiveChat: checked })}
                                                onReset={() => clearSubToggle(kind, "muteActiveChat")}
                                            />
                                            <SubToggle
                                                label="多条消息只通知1次"
                                                desc="同一角色连续多条消息只在第一条时播放"
                                                checked={own.notifyOncePerBurst ?? globalConfig.notifyOncePerBurst ?? false}
                                                explicit={own.notifyOncePerBurst !== undefined}
                                                onChange={checked => changeSound(kind, { notifyOncePerBurst: checked })}
                                                onReset={() => clearSubToggle(kind, "notifyOncePerBurst")}
                                            />
                                        </div>
                                        {own.value || globalConfig.value ? (
                                            <div className="chat-sound-editor-row chat-sound-test-row">
                                                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={testNewMessageNotice}>
                                                    <BellRing size={14} /> 测试弹窗
                                                </button>
                                                <span className="chat-sound-source">模拟该角色发来一条新消息：弹通知横幅并播放音效</span>
                                            </div>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

/** 新消息音效子开关：未单独设置时显示继承的全局值，可一键恢复跟随全局 */
function SubToggle({ label, desc, checked, explicit, onChange, onReset }: {
    label: string;
    desc: string;
    checked: boolean;
    explicit: boolean;
    onChange: (checked: boolean) => void;
    onReset: () => void;
}) {
    return (
        <div className="chat-sound-subtoggle">
            <div className="menu-label-group">
                <span className="menu-label">{label}</span>
                <span className="menu-desc">{desc}{explicit ? "" : "（跟随全局）"}</span>
            </div>
            <div className="menu-right gap-2">
                {explicit ? (
                    <button type="button" className="chat-sound-subreset" onClick={onReset}>跟随全局</button>
                ) : null}
                <Toggle checked={checked} onChange={onChange} />
            </div>
        </div>
    );
}
