"use client";

// 感知快照的云端同步（默认关闭）。
//
// 为什么需要它：离线推送时角色是在云端被唤醒生成的，而感知数据在手机上，
// 云端读不到。开启后把「聚合后的状态」同步上去，角色离线醒来时能知道
// 用户离开前最后的处境（电量、网络、在用什么应用、走了多少步）。
//
// 隐私边界（刻意如此设计，改代码前先读）：
//   1. 只传聚合快照，不传原始采样流、不传应用全列表；
//   2. 前台应用只传显示名，不传包名；
//   3. 复用用户自建的云通道（自部署 Supabase），不经第三方；
//   4. 默认关闭，开关与「传了什么」都可在现实桥面板里查看；
//   5. 一键可清。

import { bridgeConnection } from "../reality-bridge/storage";
import { putObject, removeObject } from "../cloud-backup/storage-client";
import { loadPerceptionConfig, loadPerceptionStatus } from "./storage";
import { describeStatus, filterStatusBySwitches } from "./describe";

/** 云端快照的存储路径（与快捷指令的 bridge-state 同目录，便于统一清理）。 */
export const PERCEPTION_CLOUD_PATH = "bridge-state/perception.json";

/** 云端存的最小载荷。字段少是刻意的——多一个字段就多一份泄漏面。 */
export type PerceptionCloudPayload = {
  /** 写入时刻 */
  at: string;
  /** 已格式化的一行状态速写（云端直接注入，不需要理解结构） */
  summary: string;
  /** 电量百分比，-1 = 未知 */
  batteryPercent: number;
  charging: boolean;
  /** 当前前台应用显示名 */
  foregroundApp: string;
  /** 当天步数，-1 = 未知 */
  steps: number;
};

/** 构造要上传的载荷。未采样过时返回 null。 */
export function buildCloudPayload(): PerceptionCloudPayload | null {
  const status = loadPerceptionStatus();
  if (!status.at) return null;
  // 必须过开关过滤。云端同步是状态快照的第三条消费路径（另外两条是
  // 聊天注入与角色主动查询），漏掉它就等于「关了位置/睡眠开关，
  // 这两个字段仍会被写进 summary 传到云端」——开关就形同虚设了。
  const summary = describeStatus(filterStatusBySwitches(status, loadPerceptionConfig()));
  if (!summary) return null;
  return {
    at: status.at,
    summary,
    batteryPercent: status.batteryPercent,
    charging: status.charging,
    foregroundApp: status.foregroundApp,
    steps: status.steps,
  };
}

/**
 * 把当前快照推到云端。
 *
 * 未开启、未配置云端、无数据时静默跳过（返回 false）。
 * 刻意不抛错：感知是后台能力，同步失败不该影响聊天。
 */
export async function syncPerceptionToCloud(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!loadPerceptionConfig().cloudSyncEnabled) return false;
  const { config, ready } = bridgeConnection();
  if (!ready) return false;
  const payload = buildCloudPayload();
  if (!payload) return false;
  try {
    await putObject(config, PERCEPTION_CLOUD_PATH, JSON.stringify(payload), "application/json");
    return true;
  } catch (err) {
    console.warn("[感知] 云端同步失败", err);
    return false;
  }
}

/**
 * 取一段「离线时可用」的本机状态描述。
 *
 * 用于本机在离线快照组装时补一句背景。数据过旧（> 6 小时）时不返回——
 * 宁可不说，也不让角色拿一份半天前的电量当真。
 */
export function readLocalStatusForOffline(): string {
  const status = loadPerceptionStatus();
  if (!status.at) return "";
  const ms = Date.now() - new Date(status.at).getTime();
  if (!Number.isFinite(ms) || ms > 6 * 60 * 60 * 1000) return "";
  // 与云端同步同理：这段文字会进离线快照，也必须尊重用户的关闭开关。
  const summary = describeStatus(filterStatusBySwitches(status, loadPerceptionConfig()));
  if (!summary) return "";
  return `你上次留意到 TA 手机的状态：${summary}。`;
}

/** 清除云端快照（用户点「清除云端感知数据」时调用）。 */
export async function clearCloudStatus(): Promise<boolean> {
  const { config, ready } = bridgeConnection();
  if (!ready) return false;
  try {
    await removeObject(config, PERCEPTION_CLOUD_PATH);
    return true;
  } catch (err) {
    console.warn("[感知] 清除云端快照失败", err);
    return false;
  }
}
