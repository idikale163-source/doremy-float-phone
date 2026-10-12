"use client";

// 设备状态 → 人话。
//
// 三个消费方（聊天注入 / 角色主动查询 / 云端快照）必须用同一份文案，
// 否则角色在不同场景下对同一份数据会有不同理解，用户也难对照排查。
// 所以格式化只做一遍，放在这里。

import type { PerceptionConfig, PerceptionStatusSnapshot } from "./types";
import { isCapabilityEnabled, loadPerceptionConfig, loadPerceptionStatus } from "./storage";

/** 距某个时刻过去了多久，用人话讲。 */
export function formatSince(at: string): string {
  if (!at) return "";
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 把「最近一觉」说成人话。
 *
 * 说「昨晚睡了 7 小时 20 分钟」这种顺口的句子，不写「睡眠时长：440min」。
 * 分辨昨晚还是今天小睡，只看入睡时刻是不是在今天零点之前——
 * 这个量级够用，精确到几点几分入睡没必要（那属于作息细节）。
 */
function describeSleep(sleep: PerceptionStatusSnapshot["sleep"]): string {
  if (!sleep || sleep.minutes <= 0) return "";
  // 少于 30 分钟的多半是设备误记（手环压到、午间打盹没记全），提了是噪声
  if (sleep.minutes < 30) return "";
  const hours = Math.floor(sleep.minutes / 60);
  const mins = sleep.minutes % 60;
  const duration = hours > 0
    ? (mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`)
    : `${mins} 分钟`;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const isNight = sleep.startAt > 0 && sleep.startAt < startOfToday.getTime();
  return isNight ? `昨晚睡了 ${duration}` : `今天睡了 ${duration}`;
}

/** 把网络类型说成人话。 */
function describeNetwork(type: string, metered: boolean): string {
  if (!type || type === "none") return "";
  if (type === "wifi") return "连着 WiFi";
  if (type === "cellular") return metered ? "在用移动网络" : "在用移动网络（不计费）";
  return `网络：${type}`;
}

/**
 * 把「今天用得最久的几个应用」说成人话。
 *
 * 三条取舍：
 *  · 只说前 3 个——全列出来会变成屏幕使用报告；
 *  · 少于 10 分钟的不提——那种多半是系统组件，提了是噪声；
 *  · 说成「今天在微信 43 分钟」这种顺口的话，
 *    不写「应用使用时长统计：微信 43min」这种报表腔。
 */
function describeTopUsage(appUsage: PerceptionStatusSnapshot["appUsage"]): string {
  if (!appUsage || appUsage.length === 0) return "";
  const top = appUsage.filter(item => item.minutes >= 10).slice(0, 3);
  if (top.length === 0) return "";
  const text = top
    .map(item => `${item.label || item.package} ${item.minutes} 分钟`)
    .join("、");
  return `今天在 ${text}`;
}

/**
 * 生成一段设备状态速写。
 *
 * 原则：有则说、无则不说。读不到的项直接省略，绝不写「未知」——
 * 角色会把「未知」当成一句可供评论的信息，反而变成噪音。
 */
export function describeStatus(status: PerceptionStatusSnapshot): string {
  const parts: string[] = [];

  if (status.batteryPercent >= 0) {
    parts.push(status.charging
      ? `电量 ${status.batteryPercent}%（充电中）`
      : `电量 ${status.batteryPercent}%`);
  }

  const net = describeNetwork(status.networkType, status.metered);
  if (net) parts.push(net);

  if (status.foregroundApp) {
    parts.push(status.foregroundMinutes >= 1
      ? `正在用${status.foregroundApp}（已 ${status.foregroundMinutes} 分钟）`
      : `正在用${status.foregroundApp}`);
  }

  if (status.steps >= 0) parts.push(`今天走了 ${status.steps} 步`);

  // 睡眠：只说时长，不说分期、不说几点睡的（那会暴露作息细节）。
  const slept = describeSleep(status.sleep);
  if (slept) parts.push(slept);

  // 使用统计：只说前三个用得最久的，且只在超过一定时长时提。
  // 一次把十几项全念出来，角色会变成一块屏幕使用报告，而不是「瞥了一眼」。
  const usage = describeTopUsage(status.appUsage);
  if (usage) parts.push(usage);

  if (parts.length === 0) return "";
  const age = formatSince(status.at);
  return parts.join("，") + (age ? `（数据来自${age}）` : "");
}

/**
 * 按用户的逐能力开关过滤状态。
 *
 * 关键：用户关掉「位置」不只是不想收到通知，也是不想让角色看见。
 * 所以**每一条**读状态的路径都必须过这道过滤，把关闭项清空，而不是
 * 原样返回——否则开关就形同虚设。目前有三条：聊天注入、角色主动查询、
 * 云端同步（含离线快照的本机注入）。
 */
export function filterStatusBySwitches(
  status: PerceptionStatusSnapshot,
  config: PerceptionConfig,
): PerceptionStatusSnapshot {
  const out: PerceptionStatusSnapshot = { ...status };
  if (!isCapabilityEnabled(config, "battery")) {
    out.batteryPercent = -1;
    out.charging = false;
  }
  if (!isCapabilityEnabled(config, "network")) {
    out.networkType = "";
    out.metered = false;
  }
  if (!isCapabilityEnabled(config, "foregroundApp")) {
    out.foregroundApp = "";
    out.foregroundMinutes = 0;
  }
  if (!isCapabilityEnabled(config, "steps")) {
    out.steps = -1;
  }
  if (!isCapabilityEnabled(config, "usageStats")) {
    out.appUsage = [];
  }
  if (!isCapabilityEnabled(config, "location")) {
    out.location = null;
  }
  if (!isCapabilityEnabled(config, "sleep")) {
    out.sleep = null;
  }
  return out;
}

/**
 * 在线聊天时的状态注入文案。
 *
 * 默认关（injectStatus=false）：每轮都塞几十字会持续吃 token，
 * 用户明确要了才开。关着或没数据时返回空串，调用方无需分支。
 */
export function maybeBuildStatusInjection(): string {
  const config = loadPerceptionConfig();
  if (!config.enabled || !config.injectStatus) return "";
  const status = filterStatusBySwitches(loadPerceptionStatus(), config);
  return buildStatusInjection(status);
}

/**
 * 按关注点取一部分状态。
 *
 * 角色可能只想确认一件事（比如「TA 睡了吗」只关心是不是深夜还在用手机），
 * 这时不该把全部信息丢回去——多出来的部分它会忍不住逐项评论，反而像个仪表盘。
 * focus 为空或认不出时返回完整状态。
 */
export function describeStatusByFocus(status: PerceptionStatusSnapshot, focus?: string): string {
  const key = (focus || "").trim().toLowerCase();
  if (!key) return describeStatus(status);

  const parts: string[] = [];
  if (key === "battery" || key === "电量") {
    if (status.batteryPercent >= 0) {
      parts.push(status.charging ? `电量 ${status.batteryPercent}%（充电中）` : `电量 ${status.batteryPercent}%`);
    }
  } else if (key === "network" || key === "网络") {
    const net = describeNetwork(status.networkType, status.metered);
    if (net) parts.push(net);
  } else if (key === "app" || key === "应用") {
    if (status.foregroundApp) {
      parts.push(status.foregroundMinutes >= 1
        ? `正在用${status.foregroundApp}（已 ${status.foregroundMinutes} 分钟）`
        : `正在用${status.foregroundApp}`);
    }
  } else if (key === "steps" || key === "步数") {
    if (status.steps >= 0) parts.push(`今天走了 ${status.steps} 步`);
  } else if (key === "sleep" || key === "睡眠" || key === "睡") {
    const slept = describeSleep(status.sleep);
    if (slept) parts.push(slept);
  } else if (key === "usage" || key === "usageStats" || key === "使用时长" || key === "屏幕使用时间") {
    const usage = describeTopUsage(status.appUsage);
    if (usage) parts.push(usage);
  } else if (key === "location" || key === "位置" || key === "地点") {
    if (status.location?.place) parts.push(`现在在${status.location.place}附近`);
  } else {
    return describeStatus(status);
  }

  if (parts.length === 0) return "";
  const age = formatSince(status.at);
  return parts.join("，") + (age ? `（数据来自${age}）` : "");
}

/**
 * 聊天上下文的注入文案。刻意用括号 + 「你注意到」的口吻，
 * 让角色把状态当成背景感知而不是一条要回应的消息。
 * 数据过旧（超过 30 分钟）时不注入，宁可不说也不要让角色说错。
 */
export function buildStatusInjection(status: PerceptionStatusSnapshot): string {
  const ms = Date.now() - new Date(status.at).getTime();
  if (!status.at || !Number.isFinite(ms) || ms > 30 * 60 * 1000) return "";
  const text = describeStatus(status);
  if (!text) return "";

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `（此刻是 ${hh}:${mm}。你顺手注意到对方手机的状态：${text}。`
    + "这是背景信息，不用刻意提起，也别逐项复述；只在自然的时候顺口带一句。）";
}
