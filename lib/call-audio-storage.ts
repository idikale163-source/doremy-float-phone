// lib/call-audio-storage.ts — 通话语音留档
//
// 通话里角色的每句话都是 TTS 现场合成的 Blob。以前它只活在通话屏内存里
// （audioCacheRef，上限 20 段），一挂断就没了，所以「复听」只能重新合成：
// 音色、语速、情绪每次都可能不一样，还重复消耗语音额度。
//
// 这里把合成结果落进媒体库（IndexedDB 的 Blob 存储），返回一个
// media-store:// 引用；调用方把它写进聊天消息的 mediaData.callAudioRef。
// 于是：
//   · 音频本体不占聊天记录的 JSON，也不进 AI 上下文（mediaData 不喂模型）；
//   · 通话统计 APP 从聊天历史读到引用后，用 voice.play 直接放原音
//     （宿主代播已支持 media-store:// 引用，音频不过沙盒通信桥）。
//
// 留档会占存储，所以配一张轻量索引负责回收：超过保留天数或条数上限，
// 就从最旧的开始删。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { deleteMediaRef, storeMediaBlob } from "./media-cache-storage";

const INDEX_KEY = "ai_phone_call_audio_index_v1";

/** 保留天数：更早的通话音频会被清理 */
export const CALL_AUDIO_RETENTION_DAYS = 30;
/** 最多保留的音频段数：超出后从最旧的开始删 */
export const CALL_AUDIO_MAX_CLIPS = 400;

type CallAudioEntry = {
    ref: string;
    createdAt: number;
    sessionId?: string;
    characterId?: string;
};

registerKvMigration(INDEX_KEY);

function loadIndex(): CallAudioEntry[] {
    try {
        const parsed = JSON.parse(kvGet(INDEX_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        const out: CallAudioEntry[] = [];
        for (const item of parsed) {
            if (!item || typeof item !== "object") continue;
            const record = item as Record<string, unknown>;
            const ref = typeof record.ref === "string" ? record.ref : "";
            if (!ref) continue;
            out.push({
                ref,
                createdAt: Number(record.createdAt) || 0,
                sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
                characterId: typeof record.characterId === "string" ? record.characterId : undefined,
            });
        }
        return out;
    } catch {
        return [];
    }
}

function saveIndex(entries: CallAudioEntry[]): void {
    try {
        kvSet(INDEX_KEY, JSON.stringify(entries.slice(0, CALL_AUDIO_MAX_CLIPS)));
    } catch {
        /* 索引写失败不影响播放，忽略 */
    }
}

/** 这个引用是不是通话语音留档（用来区分媒体库里其他来源的音频）。 */
export function isCallAudioRef(value: unknown): boolean {
    const ref = typeof value === "string" ? value : "";
    if (!ref) return false;
    return loadIndex().some(entry => entry.ref === ref);
}

/**
 * 落库一段通话语音，返回 media-store:// 引用。
 * 失败返回 null——调用方照常播放，只是这一句不留档。
 */
export async function persistCallAudio(
    blob: Blob,
    meta: { sessionId?: string; characterId?: string } = {},
): Promise<string | null> {
    if (!blob || !blob.size) return null;
    try {
        const ref = await storeMediaBlob(blob, blob.type || "audio/mpeg", "audio");
        saveIndex([
            { ref, createdAt: Date.now(), sessionId: meta.sessionId, characterId: meta.characterId },
            ...loadIndex(),
        ]);
        void pruneCallAudio();
        return ref;
    } catch {
        return null;
    }
}

/** 丢弃一段留档（消息被编辑 / 删除 / 重新生成后，音频与文字已经对不上了）。 */
export async function releaseCallAudioRef(ref: unknown): Promise<void> {
    const value = typeof ref === "string" ? ref : "";
    if (!value) return;
    const index = loadIndex();
    if (!index.some(entry => entry.ref === value)) return;
    saveIndex(index.filter(entry => entry.ref !== value));
    try {
        await deleteMediaRef(value);
    } catch {
        /* 已经不在了就当作已删 */
    }
}

/** 按保留策略清理旧留档，返回清掉的条数。 */
export async function pruneCallAudio(now = Date.now()): Promise<number> {
    const cutoff = now - CALL_AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const index = loadIndex().slice().sort((a, b) => b.createdAt - a.createdAt);
    const keep: CallAudioEntry[] = [];
    const drop: CallAudioEntry[] = [];
    for (const entry of index) {
        const expired = entry.createdAt > 0 && entry.createdAt < cutoff;
        if (expired || keep.length >= CALL_AUDIO_MAX_CLIPS) drop.push(entry);
        else keep.push(entry);
    }
    if (drop.length === 0) return 0;
    saveIndex(keep);
    await Promise.all(drop.map(entry => deleteMediaRef(entry.ref).catch(() => {})));
    return drop.length;
}
