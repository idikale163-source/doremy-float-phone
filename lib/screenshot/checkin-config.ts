"use client";

// 查岗配置：**每个角色各自一套**（开关、间隔、每日上限）。
//
// 为什么按角色而不是全局：查岗是「角色想看看你在干嘛」，这件事的合适程度
// 完全取决于你们的关系——黏人的那位可能想半小时看一次，正经的那位一天一次
// 都嫌多。一个全局开关管不住这种差异，只能逼用户二选一（要么全开要么全关）。
//
// 默认值（用户拍板）：间隔 30~90 分钟、每天最多 3 次、**默认关闭**。
// 关着的时候角色完全不知道有这个能力，也不会弹任何浮层。
//
// 存两份：配置（用户设的）+ 运行态（上次什么时候触发、今天触发了几次）。
// 分开存是为了让「重置运行态」不必碰用户的设置。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_check_in_config_v1";
const RUNTIME_KEY = "ai_phone_check_in_runtime_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(RUNTIME_KEY);

/** 单个角色的查岗设置。 */
export type CheckInCharacterConfig = {
  enabled: boolean;
  /** 触发间隔下限（分钟） */
  minMinutes: number;
  /** 触发间隔上限（分钟）；等于 minMinutes 即固定间隔 */
  maxMinutes: number;
  /** 每天最多查岗几次 */
  dailyLimit: number;
};

/** 运行态：决定「这次该不该触发」。 */
export type CheckInRuntime = {
  /** 上次触发时刻（毫秒）；0 = 从未触发 */
  lastFiredAt: number;
  /** 计数所属的日期（YYYY-MM-DD）；跨天就重置计数 */
  dayKey: string;
  /** 当天已触发次数 */
  countToday: number;
};

export const CHECK_IN_DEFAULTS: CheckInCharacterConfig = {
  enabled: false,
  minMinutes: 30,
  maxMinutes: 90,
  dailyLimit: 3,
};

/** 间隔允许范围（分钟）：太短会变成监视，太长就失去「陪着你」的味道。 */
export const CHECK_IN_MIN_INTERVAL = 5;
export const CHECK_IN_MAX_INTERVAL = 720;
/** 每日上限允许范围（次）。 */
export const CHECK_IN_MAX_DAILY = 20;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function normalizeCharacter(raw: unknown): CheckInCharacterConfig {
  if (!raw || typeof raw !== "object") return { ...CHECK_IN_DEFAULTS };
  const source = raw as Partial<CheckInCharacterConfig>;
  const minMinutes = clampNumber(
    source.minMinutes,
    CHECK_IN_MIN_INTERVAL,
    CHECK_IN_MAX_INTERVAL,
    CHECK_IN_DEFAULTS.minMinutes,
  );
  const maxMinutes = clampNumber(
    source.maxMinutes,
    minMinutes,
    CHECK_IN_MAX_INTERVAL,
    Math.max(minMinutes, CHECK_IN_DEFAULTS.maxMinutes),
  );
  return {
    // 必须显式 true 才算开——查岗是「角色主动看你屏幕」，缺省绝不能是开
    enabled: source.enabled === true,
    minMinutes,
    maxMinutes,
    dailyLimit: clampNumber(
      source.dailyLimit,
      1,
      CHECK_IN_MAX_DAILY,
      CHECK_IN_DEFAULTS.dailyLimit,
    ),
  };
}

export type CheckInConfigMap = Record<string, CheckInCharacterConfig>;

/** 读全部角色的查岗配置（含默认值补全）。 */
export function loadCheckInConfig(): CheckInConfigMap {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: CheckInConfigMap = {};
    for (const [characterId, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[characterId] = normalizeCharacter(value);
    }
    return out;
  } catch {
    return {};
  }
}

/** 读某个角色的配置（没设过就是默认值，也就是关闭）。 */
export function loadCharacterCheckIn(characterId: string): CheckInCharacterConfig {
  return loadCheckInConfig()[characterId] ?? { ...CHECK_IN_DEFAULTS };
}

/** 写某个角色的配置。 */
export function saveCharacterCheckIn(characterId: string, patch: Partial<CheckInCharacterConfig>): CheckInCharacterConfig {
  const all = loadCheckInConfig();
  const next = normalizeCharacter({ ...(all[characterId] ?? CHECK_IN_DEFAULTS), ...patch });
  all[characterId] = next;
  kvSet(CONFIG_KEY, JSON.stringify(all));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("check-in-config-changed"));
  }
  return next;
}

/** 有没有任何一个角色开着查岗（决定要不要预热原生服务）。 */
export function hasAnyCheckInEnabled(): boolean {
  return Object.values(loadCheckInConfig()).some(item => item.enabled);
}

/** 关掉所有角色的查岗（设置页的「全部关闭」）。 */
export function disableAllCheckIn(): void {
  const all = loadCheckInConfig();
  for (const key of Object.keys(all)) {
    all[key] = { ...all[key], enabled: false };
  }
  kvSet(CONFIG_KEY, JSON.stringify(all));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("check-in-config-changed"));
  }
}

// ── 运行态 ──

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function loadCheckInRuntime(): Record<string, CheckInRuntime> {
  try {
    const raw = kvGet(RUNTIME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CheckInRuntime>) : {};
  } catch {
    return {};
  }
}

function saveCheckInRuntime(runtime: Record<string, CheckInRuntime>): void {
  kvSet(RUNTIME_KEY, JSON.stringify(runtime));
}

/** 取某个角色的运行态；跨天自动把当日计数归零（不写盘，读的时候就归零）。 */
export function readCharacterRuntime(characterId: string): CheckInRuntime {
  const entry = loadCheckInRuntime()[characterId];
  const day = todayKey();
  if (!entry || entry.dayKey !== day) {
    return { lastFiredAt: entry?.lastFiredAt ?? 0, dayKey: day, countToday: 0 };
  }
  return entry;
}

/** 记一次触发（更新上次时间与当日计数）。 */
export function markCheckInFired(characterId: string): void {
  const runtime = loadCheckInRuntime();
  const current = readCharacterRuntime(characterId);
  runtime[characterId] = {
    lastFiredAt: Date.now(),
    dayKey: current.dayKey,
    countToday: current.countToday + 1,
  };
  saveCheckInRuntime(runtime);
}

/** 清空某个角色的运行态（用户手动重置节奏用）。 */
export function resetCheckInRuntime(characterId: string): void {
  const runtime = loadCheckInRuntime();
  delete runtime[characterId];
  saveCheckInRuntime(runtime);
}

/**
 * 一个角色的查岗调度快照，给设置页的「链路诊断」读。
 *
 * 为什么需要它：查岗不触发时，用户能看到的只有「没弹」这一个事实，
 * 而真实原因可能是「没开」「今天次数用完了」「距上次还不够久」
 * 「服务没起来」「权限没给」——五六种情况长得一模一样。
 * 把配置与运行态一起摊开，用户一眼就能看出卡在哪一环。
 */
export type CheckInScheduleSnapshot = {
  enabled: boolean;
  minMinutes: number;
  maxMinutes: number;
  dailyLimit: number;
  /** 上次触发时刻（毫秒）；0 = 从未触发 */
  lastFiredAt: number;
  /** 距上次触发过了多少分钟；从未触发时为 -1 */
  minutesSinceLast: number;
  /** 今天已触发次数（跨天已归零） */
  countToday: number;
  /** 今天是否已达上限 */
  dailyReached: boolean;
  /** 现在这一刻是否已到点（与引擎用的是同一个判定） */
  due: boolean;
};

export function readCheckInScheduleSnapshot(
  characterId: string,
  config: CheckInCharacterConfig,
): CheckInScheduleSnapshot {
  const runtime = readCharacterRuntime(characterId);
  const minutesSinceLast = runtime.lastFiredAt > 0
    ? Math.floor((Date.now() - runtime.lastFiredAt) / 60_000)
    : -1;
  return {
    enabled: config.enabled,
    minMinutes: config.minMinutes,
    maxMinutes: config.maxMinutes,
    dailyLimit: config.dailyLimit,
    lastFiredAt: runtime.lastFiredAt,
    minutesSinceLast,
    countToday: runtime.countToday,
    dailyReached: runtime.countToday >= config.dailyLimit,
    due: shouldFireCheckIn(characterId, config),
  };
}

/** 在 [minMinutes, maxMinutes] 之间随机取一个等待分钟数。 */
export function randomCheckInDelayMinutes(config: CheckInCharacterConfig): number {
  const min = Math.max(CHECK_IN_MIN_INTERVAL, config.minMinutes);
  const max = Math.max(min, config.maxMinutes);
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

/**
 * 现在这个角色该不该触发查岗。
 *
 * 三个条件缺一不可：开着、今天没超上限、距上次触发够久了。
 * 「够久」用随机间隔——固定节拍像定时器，真人是忽快忽慢的。
 */
export function shouldFireCheckIn(
  characterId: string,
  config: CheckInCharacterConfig,
  now = Date.now(),
): boolean {
  if (!config.enabled) return false;
  const runtime = readCharacterRuntime(characterId);
  if (runtime.countToday >= config.dailyLimit) return false;
  if (runtime.lastFiredAt <= 0) return true;
  const elapsedMinutes = (now - runtime.lastFiredAt) / 60_000;
  const threshold = randomCheckInDelayMinutes(config);
  return elapsedMinutes >= threshold;
}
