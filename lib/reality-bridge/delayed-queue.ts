"use client";

/**
 * 联动的延迟执行队列。
 *
 * 规则的 delayMinutes > 0 时，命中信号不立刻执行动作，而是把「待办」存进这里，
 * 由调度器每轮检查到点后补执行。
 *
 * 为什么必须落盘（IndexedDB）而不是用 setTimeout：
 *   用户很可能在延迟期间退出小手机——纯内存定时器一关就没了，
 *   「十分钟后提醒你」会变成「永远不提醒」。落盘后 App 再打开时
 *   调度器扫一遍队列，过期的任务照样补上（这也意味着 App 关着的那段时间
 *   不算数——到点时没人跑，只能等下次打开，属于本地方案的能力边界）。
 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { BridgeItem } from "./types";

const QUEUE_KEY = "ai_phone_reality_bridge_delayed_v1";
registerKvMigration(QUEUE_KEY);

/** 队列上限：延迟是个提醒工具，不是任务调度平台，堆太多只说明没配好。 */
const QUEUE_LIMIT = 50;

/** 单次延迟上限：7 天。再长就不该用联动了。 */
export const MAX_DELAY_MINUTES = 7 * 24 * 60;

export type DelayedTask = {
  id: string;
  ruleId: string;
  /** 存规则名是为了规则被删后还能在流水里说清是哪条。 */
  ruleName: string;
  /** 原始信号（动作里 {payload}/{type} 要用）。 */
  item: BridgeItem;
  /** 已经加工好的文本（不用再加工一次，也保证延迟前后结果一致）。 */
  text: string;
  /** 到点执行的时间戳（毫秒）。 */
  dueAt: number;
  createdAt: string;
};

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function loadDelayedTasks(): DelayedTask[] {
  if (!isBrowser()) return [];
  try {
    const raw = kvGet(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return (parsed as DelayedTask[]).filter(task => (
      task
      && typeof task.id === "string"
      && typeof task.ruleId === "string"
      && typeof task.dueAt === "number"
      && task.item
      && typeof task.item.type === "string"
    ));
  } catch {
    return [];
  }
}

export function saveDelayedTasks(tasks: DelayedTask[]): void {
  if (!isBrowser()) return;
  // 按到点时间排序后落盘：调度器从头扫，遇到没到点的就能停。
  const sorted = [...tasks].sort((a, b) => a.dueAt - b.dueAt);
  kvSet(QUEUE_KEY, JSON.stringify(sorted.slice(0, QUEUE_LIMIT)));
}

/** 排一个延迟任务。 */
export function enqueueDelayedTask(input: {
  ruleId: string;
  ruleName: string;
  item: BridgeItem;
  text: string;
  delayMinutes: number;
}): DelayedTask | null {
  const minutes = Math.max(1, Math.min(MAX_DELAY_MINUTES, Math.round(input.delayMinutes)));
  const tasks = loadDelayedTasks();
  // 满员时丢最早到点的（它最可能已经过期没意义了）
  if (tasks.length >= QUEUE_LIMIT) tasks.shift();
  const task: DelayedTask = {
    id: `dly_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    item: input.item,
    text: input.text,
    dueAt: Date.now() + minutes * 60_000,
    createdAt: new Date().toISOString(),
  };
  saveDelayedTasks([...tasks, task]);
  return task;
}

export function removeDelayedTask(id: string): void {
  saveDelayedTasks(loadDelayedTasks().filter(task => task.id !== id));
}

/** 取还没到的任务数（概览页显示用）。 */
export function countPendingDelayedTasks(): number {
  const now = Date.now();
  return loadDelayedTasks().filter(task => task.dueAt > now).length;
}
