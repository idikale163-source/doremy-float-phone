"use client";

// 感知配置与流水的本地存储。
// 与其余模块一致走 kv-db（IndexedDB），不落服务端——感知数据只留在本机。

import { kvGet, kvRemove, kvSet, registerKvMigration } from "../kv-db";
import {
  PERCEPTION_DEFAULTS,
  PERCEPTION_LIMITS,
  type AppUsageOverride,
  type PerceptionCapability,
  type PerceptionConfig,
  type PerceptionLogEntry,
  type PerceptionStatusSnapshot,
} from "./types";

const CONFIG_KEY = "ai_phone_perception_config_v1";
const LOG_KEY = "ai_phone_perception_log_v1";
const STATE_KEY = "ai_phone_perception_state_v1";
const STATUS_KEY = "ai_phone_perception_status_v1";

registerKvMigration(CONFIG_KEY);
registerKvMigration(LOG_KEY);
registerKvMigration(STATE_KEY);
registerKvMigration(STATUS_KEY);

const LOG_LIMIT = 60;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 清洗单应用阈值表。
 *
 * 存储里的东西可能被手改、也可能来自旧版本，所以逐条验形状：
 * 名字去空白、空名字丢掉，分钟钳到合法区间。宁可少几条条目，
 * 也不能让引擎读到 NaN——那会让阈值比较永远为假或永远为真。
 */
function sanitizeOverrides(raw: unknown): AppUsageOverride[] {
  if (!Array.isArray(raw)) return [];
  const list: AppUsageOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const pattern = String((item as AppUsageOverride).pattern ?? "").trim();
    if (!pattern) continue;
    list.push({
      pattern: pattern.slice(0, 30),
      minutes: clamp(
        (item as AppUsageOverride).minutes,
        0,
        PERCEPTION_LIMITS.appUsageSignalMinutes.max,
        0,
      ),
    });
  }
  return list;
}

/** 读配置。逐项做范围钳制，避免手改存储写出离谱的值。 */
export function loadPerceptionConfig(): PerceptionConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...PERCEPTION_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PerceptionConfig>;
    return {
      enabled: parsed.enabled !== false,
      capabilities: (parsed.capabilities && typeof parsed.capabilities === "object") ? parsed.capabilities : {},
      sampleSeconds: clamp(parsed.sampleSeconds, PERCEPTION_LIMITS.sampleSeconds.min, PERCEPTION_LIMITS.sampleSeconds.max, PERCEPTION_DEFAULTS.sampleSeconds),
      batteryStepPercent: clamp(parsed.batteryStepPercent, PERCEPTION_LIMITS.batteryStepPercent.min, PERCEPTION_LIMITS.batteryStepPercent.max, PERCEPTION_DEFAULTS.batteryStepPercent),
      appDwellMinutes: clamp(parsed.appDwellMinutes, PERCEPTION_LIMITS.appDwellMinutes.min, PERCEPTION_LIMITS.appDwellMinutes.max, PERCEPTION_DEFAULTS.appDwellMinutes),
      // 缺了它会是 undefined，而 checkAppUsageSignal 里 `undefined <= 0` 为 false、
      // 除法又得到 NaN——一路绕过所有闸门变成每轮都报。这里必须兜住。
      appUsageSignalMinutes: clamp(parsed.appUsageSignalMinutes, PERCEPTION_LIMITS.appUsageSignalMinutes.min, PERCEPTION_LIMITS.appUsageSignalMinutes.max, PERCEPTION_DEFAULTS.appUsageSignalMinutes),
      appUsageSignalOverrides: sanitizeOverrides(parsed.appUsageSignalOverrides),
      hourlyLimit: clamp(parsed.hourlyLimit, PERCEPTION_LIMITS.hourlyLimit.min, PERCEPTION_LIMITS.hourlyLimit.max, PERCEPTION_DEFAULTS.hourlyLimit),
      respectQuietHours: parsed.respectQuietHours !== false,
      batteryLowPercent: clamp(parsed.batteryLowPercent, PERCEPTION_LIMITS.batteryLowPercent.min, PERCEPTION_LIMITS.batteryLowPercent.max, PERCEPTION_DEFAULTS.batteryLowPercent),
      returnSignalEnabled: parsed.returnSignalEnabled !== false,
      returnAwayMinutes: clamp(parsed.returnAwayMinutes, PERCEPTION_LIMITS.returnAwayMinutes.min, PERCEPTION_LIMITS.returnAwayMinutes.max, PERCEPTION_DEFAULTS.returnAwayMinutes),
      returnCooldownMinutes: clamp(parsed.returnCooldownMinutes, PERCEPTION_LIMITS.returnCooldownMinutes.min, PERCEPTION_LIMITS.returnCooldownMinutes.max, PERCEPTION_DEFAULTS.returnCooldownMinutes),
      lateNightUntilHour: clamp(parsed.lateNightUntilHour, PERCEPTION_LIMITS.lateNightUntilHour.min, PERCEPTION_LIMITS.lateNightUntilHour.max, PERCEPTION_DEFAULTS.lateNightUntilHour),
      noTalkHours: clamp(parsed.noTalkHours, PERCEPTION_LIMITS.noTalkHours.min, PERCEPTION_LIMITS.noTalkHours.max, PERCEPTION_DEFAULTS.noTalkHours),
      sitStillMinutes: clamp(parsed.sitStillMinutes, PERCEPTION_LIMITS.sitStillMinutes.min, PERCEPTION_LIMITS.sitStillMinutes.max, PERCEPTION_DEFAULTS.sitStillMinutes),
      injectStatus: parsed.injectStatus === true,
      queryCooldownMinutes: clamp(parsed.queryCooldownMinutes, PERCEPTION_LIMITS.queryCooldownMinutes.min, PERCEPTION_LIMITS.queryCooldownMinutes.max, PERCEPTION_DEFAULTS.queryCooldownMinutes),
      cloudSyncEnabled: parsed.cloudSyncEnabled === true,
    };
  } catch {
    return { ...PERCEPTION_DEFAULTS };
  }
}

export function savePerceptionConfig(config: PerceptionConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-config-changed"));
  }
}

/** 某个能力是否开启（缺省视为开启）。 */
export function isCapabilityEnabled(config: PerceptionConfig, capability: PerceptionCapability): boolean {
  return config.capabilities[capability] !== false;
}

// ── 流水 ──

export function loadPerceptionLog(): PerceptionLogEntry[] {
  try {
    const raw = kvGet(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PerceptionLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** 追加一条流水，超限丢最旧的。 */
export function appendPerceptionLog(entry: PerceptionLogEntry): void {
  const list = loadPerceptionLog();
  list.unshift(entry);
  if (list.length > LOG_LIMIT) list.length = LOG_LIMIT;
  kvSet(LOG_KEY, JSON.stringify(list));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-log-changed"));
  }
}

export function clearPerceptionLog(): void {
  kvRemove(LOG_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("perception-log-changed"));
  }
}

// ── 运行态（采样基准 + 限流窗口）──
// 与其他模块一致：持久化，重载后不丢，避免刷新页面就把限流计数清零。

export type PerceptionRuntimeState = {
  /** 上次电量（用于阈值比较） */
  lastBatteryPercent: number;
  /** 上次充电状态 */
  lastCharging: boolean;
  /** 上次网络类型 */
  lastNetworkType: string;
  /** 当前停留的应用包名与起始时间 */
  dwellPackage: string;
  dwellSince: number;
  /** 已上报过停留的应用包名（同一段停留只报一次） */
  dwellReported: string;
  /** 本小时信号窗口：起始毫秒 + 条数 */
  hourWindowStart: number;
  hourCount: number;
  /** 最近采样时间 */
  lastSampleAt: string;
  /** 最近一次取值快照原文 */
  lastSnapshot: string;
  /** 无匹配规则的信号计数 */
  unmatchedSignals: number;
  /** 进入后台（离开小手机）的时刻；0 = 当前在前台 */
  awaySince: number;
  /** 上次发「回到手机」信号的时刻，用于回归冷却 */
  lastReturnSignalAt: number;
  /** 每个角色上次调用「查看TA的手机」的时刻：characterId → 毫秒 */
  lastQueryAt: Record<string, number>;
  /** 上次已知位置的坐标（用来判断「是不是换了个地方」）；null = 还没读到过 */
  lastLat: number;
  lastLon: number;
  /** 上次位置的地名（供「离开某地」文案用；空串 = 当时也没拿到名字） */
  lastPlace: string;
  /** 上次已上报过的醒来时刻（毫秒）；同一次醒来只报一次 */
  lastSleepEndAt: number;
  /**
   * 「某个应用今天用太久」已报到第几档：包名 → 档位。
   *
   * 为什么要记档位：累计时长每分钟都在涨，不能每轮采样都报一次。
   * 按「累计每超过阈值一次报一条」算（阈值 60 → 60 分钟报一条、120 再报一条），
   * 档位记在这里，避免同一档反复报。
   */
  usageSignalTier: Record<string, number>;
  /** 上面那份档位记录属于哪一天（YYYY-MM-DD）。跨天清零，昨天的档位不能当今天的基准。 */
  usageSignalDate: string;
  /**
   * 「每天最多报一次」的信号记在这里：信号标识 → 日期（YYYY-MM-DD）。
   * 深夜还醒着 / 今天第一次打开 / 很久没聊天 共用这一张表。
   * 跨天不用清——旧日期自然不等于今天，判断自动失效。
   */
  dailySignalDate: Record<string, string>;
  /** 「久坐不动」的起算时刻；步数一变（起身走动）就重置。 */
  sitSince: number;
  /** 起算时的步数基准。步数跟它不一样 = 走过了，重新起算。 */
  sitSteps: number;
  /** 本段久坐是否已上报。起身走动后重置，所以每段只报一次。 */
  sitReported: boolean;
};

const EMPTY_STATE: PerceptionRuntimeState = {
  usageSignalTier: {},
  usageSignalDate: "",
  dailySignalDate: {},
  sitSince: 0,
  sitSteps: -1,
  sitReported: false,
  lastBatteryPercent: -1,
  lastCharging: false,
  lastNetworkType: "",
  dwellPackage: "",
  dwellSince: 0,
  dwellReported: "",
  hourWindowStart: 0,
  hourCount: 0,
  lastSampleAt: "",
  lastSnapshot: "",
  unmatchedSignals: 0,
  awaySince: 0,
  lastReturnSignalAt: 0,
  lastQueryAt: {},
  lastLat: Number.NaN,
  lastLon: Number.NaN,
  lastPlace: "",
  lastSleepEndAt: 0,
};

export function loadPerceptionState(): PerceptionRuntimeState {
  try {
    const raw = kvGet(STATE_KEY);
    if (!raw) return { ...EMPTY_STATE, usageSignalTier: {}, dailySignalDate: {} };
    const parsed = JSON.parse(raw) as Partial<PerceptionRuntimeState>;
    return {
      ...EMPTY_STATE,
      ...parsed,
      // 这两张表是对象，而 EMPTY_STATE 是模块级单例：直接沿用它的引用，
      // 引擎往「今天已报」表里写一笔就会污染这个共享对象，之后每个从空状态
      // 起家的副本都带着别人的记录。每次复制一份，代价可以忽略。
      usageSignalTier: { ...(parsed.usageSignalTier ?? {}) },
      dailySignalDate: { ...(parsed.dailySignalDate ?? {}) },
    };
  } catch {
    return { ...EMPTY_STATE, usageSignalTier: {}, dailySignalDate: {} };
  }
}

export function savePerceptionState(state: PerceptionRuntimeState): void {
  kvSet(STATE_KEY, JSON.stringify(state));
}

/** 重置运行态（清空流水时一并调用，让引擎从干净状态重新开始）。 */
export function resetPerceptionState(): void {
  kvSet(STATE_KEY, JSON.stringify(EMPTY_STATE));
  kvRemove(STATUS_KEY);
}

// ── 设备状态缓存 ──
// 引擎每次采样后把「人类可读的当前状态」存这里。三个消费者：
//   ① 聊天时按需注入给角色（injectStatus）
//   ② 角色主动调用「查看TA的手机」
//   ③ 云端同步（cloudSyncEnabled，默认关）
// 与运行态分开存：运行态是引擎自己的基准，这里是给外部读的成品，随时可清。

const EMPTY_STATUS: PerceptionStatusSnapshot = {
  at: "",
  batteryPercent: -1,
  charging: false,
  networkType: "",
  metered: false,
  foregroundApp: "",
  foregroundMinutes: 0,
  steps: -1,
  // 旧缓存没有位置字段，合并后必须是 null 而不是 undefined：
  // 描述函数会判空，undefined 会一路漏到界面文案里。
  location: null,
  sleep: null,
  // 旧缓存里没有这个字段（这次才加），合并后必须还是个数组——
  // 否则 describeTopUsage 遍历时会在 undefined 上炸。
  appUsage: [],
};

/** 读最近一次采样的设备状态。从未采样过时 at 为空串。 */
export function loadPerceptionStatus(): PerceptionStatusSnapshot {
  try {
    const raw = kvGet(STATUS_KEY);
    if (!raw) return { ...EMPTY_STATUS };
    const parsed = JSON.parse(raw) as Partial<PerceptionStatusSnapshot>;
    return { ...EMPTY_STATUS, ...parsed };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

/** 写入设备状态缓存（引擎采样时调用）。 */
export function savePerceptionStatus(status: PerceptionStatusSnapshot): void {
  kvSet(STATUS_KEY, JSON.stringify(status));
}
