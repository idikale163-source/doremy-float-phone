"use client";

// 排期管理面板：列出服务端还在排队/执行中的主动消息，让用户看清「哪些角色排了什么」
// 并逐条删掉，或按角色整体停掉。
//
// 为什么要有它：「清空存量预约」是一个看不见内部的按钮——用户既不知道删掉了什么，
// 也无法判断「删完还会不会再冒出来」。而最难查的一类任务（服务端 idleRepeat 自己
// 续排的 `+` 后缀链）只在服务端存在，本地翻遍设置都找不到。这里把服务端的任务
// 直接摊开，就能回答「到底是谁在发」。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Loader2, RefreshCw, Trash2 } from "lucide-react";

import {
    deleteScheduledJob,
    fetchScheduledJobs,
    stopCharacterScheduledActivity,
} from "@/lib/push-bailout-client";
import { isPersonalPushCloudActive } from "@/lib/personal-push-cloud";
import { describeScheduledJobs, type ScheduledJobRow } from "@/lib/push-schedule-view";

/** 触发时刻：绝对时间 + 相对剩余，两者都要——前者用来对表，后者用来判断急不急。 */
function fmtWhen(atMs: number): string {
    if (!atMs) return "时间未知";
    const d = new Date(atMs);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const clock = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const diffMin = Math.round((atMs - Date.now()) / 60000);
    if (diffMin <= 0) return `${clock} · 已到点（正在执行）`;
    if (diffMin < 60) return `${clock} · 约 ${diffMin} 分钟后`;
    return `${clock} · 约 ${Math.round(diffMin / 60)} 小时后`;
}

export function PushSchedulePanel() {
    const [rows, setRows] = useState<ScheduledJobRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [note, setNote] = useState("");
    const [busyKey, setBusyKey] = useState("");
    // 个人云是否在本机启用。刻意自己再查一次而不是由父组件传入：父组件用的是
    // 挂载时算好的快照，而用户完全可能「先打开这个页面、再去上面部署」，
    // 那一刻父组件的值还是旧的，面板就会一直显示「未启用」。
    const [cloudActive, setCloudActive] = useState(true);

    const reload = useCallback(async () => {
        setLoading(true);
        setError("");
        setCloudActive(isPersonalPushCloudActive());
        try {
            const result = await fetchScheduledJobs();
            if (!result.ok) {
                setRows([]);
                setError(result.error || "读取失败。");
            } else {
                setRows(describeScheduledJobs(result.jobs ?? []));
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void reload(); }, [reload]);

    /** 按角色分组：归属不明的（系统任务、已删规则的残留）单独一组放最后。 */
    const groups = useMemo(() => {
        const map = new Map<string, { key: string; characterId: string; name: string; rows: ScheduledJobRow[] }>();
        for (const row of rows) {
            const key = row.characterId ? `c:${row.characterId}` : "unowned";
            let group = map.get(key);
            if (!group) {
                group = {
                    key,
                    characterId: row.characterId,
                    name: row.characterId ? (row.characterName || "未命名角色") : "未归属 / 系统任务",
                    rows: [],
                };
                map.set(key, group);
            }
            group.rows.push(row);
        }
        return [...map.values()];
    }, [rows]);

    const removeOne = async (row: ScheduledJobRow) => {
        setBusyKey(row.triggerKey);
        setNote("");
        try {
            const result = await deleteScheduledJob(row.triggerKey);
            setNote(result.ok
                ? `已删除：${row.characterName || "系统任务"} · ${row.label}`
                : `删除失败：${result.error || "未知原因"}`);
            await reload();
        } finally {
            setBusyKey("");
        }
    };

    const stopCharacter = async (characterId: string, name: string) => {
        setBusyKey(`char:${characterId}`);
        setNote("");
        try {
            const result = await stopCharacterScheduledActivity(characterId);
            setNote(result.ok
                ? `已停止「${name}」的主动消息：撤下服务端排期${result.localCleared > 0 ? `，并关闭 ${result.localCleared} 条本地排期/规则` : ""}。`
                : `停止失败：${result.error || "未知原因"}`);
            await reload();
        } finally {
            setBusyKey("");
        }
    };

    return (
        <div className="flex flex-col gap-3 rounded-[16px] bg-black/[0.03] p-3.5">
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                    <span className="menu-label">主动消息排期</span>
                    <span className="menu-desc !mt-0">
                        服务端还有哪些角色排了消息。删掉某条即撤销那一次；想彻底不再收到，按角色整体停掉。
                    </span>
                </div>
                <button
                    type="button"
                    className="ui-btn ui-btn-outline shrink-0"
                    onClick={() => void reload()}
                    disabled={loading}
                >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} strokeWidth={2} />}
                    刷新
                </button>
            </div>

            {!cloudActive && (
                <div className="rounded-[12px] bg-amber-500/10 px-3 py-2 text-[calc(12px*var(--app-text-scale,1))] leading-relaxed text-amber-700">
                    离线推送还没在本机启用，所以这里读不到任何排期。
                    先在上面完成「离线推送」的部署；如果是换了设备，用下面的
                    「已经部署过？换了设备只需重新连接」接上即可。
                </div>
            )}

            {error && (
                <div className="rounded-[12px] bg-amber-500/10 px-3 py-2 text-[calc(12px*var(--app-text-scale,1))] leading-relaxed text-amber-700">
                    读取失败：{error}
                    <br />
                    若提示「缺少预约键」或接口不存在，说明你的个人云上的离线推送函数还是旧版，
                    到上方重新部署一次即可。
                </div>
            )}

            {!error && rows.length === 0 && !loading && (
                <div className="text-[calc(12px*var(--app-text-scale,1))] text-gray-400">
                    当前没有任何排在服务端的主动消息。
                </div>
            )}

            {groups.map(group => (
                <div key={group.key} className="flex flex-col gap-2 rounded-[12px] bg-white/70 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="menu-label min-w-0 truncate">{group.name}</span>
                        {group.characterId && (
                            <button
                                type="button"
                                className="ui-btn ui-btn-soft-danger shrink-0"
                                onClick={() => void stopCharacter(group.characterId, group.name)}
                                disabled={busyKey === `char:${group.characterId}`}
                            >
                                {busyKey === `char:${group.characterId}`
                                    ? <Loader2 size={14} className="animate-spin" />
                                    : <Trash2 size={14} strokeWidth={2} />}
                                全部停止
                            </button>
                        )}
                    </div>
                    {group.rows.map(row => (
                        <div key={row.triggerKey} className="flex items-start justify-between gap-2 border-t border-black/5 pt-2">
                            <div className="flex min-w-0 flex-col">
                                <span className="text-[calc(13px*var(--app-text-scale,1))] font-semibold text-gray-800">
                                    {row.label}
                                </span>
                                <span className="flex items-center gap-1 text-[calc(11px*var(--app-text-scale,1))] text-gray-500">
                                    <Clock size={11} strokeWidth={2} />
                                    {fmtWhen(row.executeAtMs)}
                                    {row.status === "running" && " · 执行中"}
                                </span>
                            </div>
                            {!row.system && (
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-soft-danger shrink-0"
                                    onClick={() => void removeOne(row)}
                                    disabled={busyKey === row.triggerKey}
                                >
                                    {busyKey === row.triggerKey
                                        ? <Loader2 size={14} className="animate-spin" />
                                        : <Trash2 size={14} strokeWidth={2} />}
                                    删除
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            ))}

            {note && (
                <div className="text-[calc(12px*var(--app-text-scale,1))] leading-relaxed text-gray-600">{note}</div>
            )}

            <div className="text-[calc(11px*var(--app-text-scale,1))] leading-relaxed text-gray-400">
                两点必须知道：①「追问」由角色的焦虑值自动排期，删掉后只要焦虑值仍越过阈值，
                下一次回复就又挂上一条——想根治要去追问设置里调高阈值或换字段名。
                ② 删掉某条不会关闭对应功能，只撤销这一次；「全部停止」会连本地规则/排期一起关掉。
            </div>
        </div>
    );
}
