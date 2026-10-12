"use client";

/**
 * 桌面小组件的本地存储。
 *
 * 与便签墙（公开、走 Supabase）刻意区分：这里存的是角色私下给你的话，
 * 只在本机 IndexedDB，不上云、不进任何公开墙。
 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { WIDGET_DEFAULTS, WIDGET_LIMITS, WIDGET_UPDATED_EVENT, type WidgetConfig, type WidgetData } from "./types";

const CONFIG_KEY = "ai_phone_widget_config_v1";
const DATA_KEY = "ai_phone_widget_data_v1";

registerKvMigration(CONFIG_KEY);
registerKvMigration(DATA_KEY);

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function notifyUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WIDGET_UPDATED_EVENT));
  }
}

export function loadWidgetConfig(): WidgetConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...WIDGET_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
    return {
      enabled: parsed.enabled === true,
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      useCustomTemplate: parsed.useCustomTemplate === true,
      customTemplate: typeof parsed.customTemplate === "string" ? parsed.customTemplate.slice(0, 20000) : "",
      widthDp: clamp(parsed.widthDp, WIDGET_LIMITS.widthDp.min, WIDGET_LIMITS.widthDp.max, WIDGET_DEFAULTS.widthDp),
      heightDp: clamp(parsed.heightDp, WIDGET_LIMITS.heightDp.min, WIDGET_LIMITS.heightDp.max, WIDGET_DEFAULTS.heightDp),
      autoEnabled: parsed.autoEnabled === true,
      autoIntervalHours: clamp(parsed.autoIntervalHours, WIDGET_LIMITS.autoIntervalHours.min, WIDGET_LIMITS.autoIntervalHours.max, WIDGET_DEFAULTS.autoIntervalHours),
      useGeneratedAvatar: parsed.useGeneratedAvatar === true,
      scale: clamp(parsed.scale, WIDGET_LIMITS.scale.min, WIDGET_LIMITS.scale.max, WIDGET_DEFAULTS.scale),
    };
  } catch {
    return { ...WIDGET_DEFAULTS };
  }
}

export function saveWidgetConfig(config: WidgetConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  notifyUpdated();
}

export function loadWidgetData(): WidgetData | null {
  try {
    const raw = kvGet(DATA_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetData>;
    if (!parsed || typeof parsed.text !== "string") return null;
    return {
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      text: parsed.text.slice(0, 300),
      status: typeof parsed.status === "string" ? parsed.status.slice(0, 30) : "",
      avatar: typeof parsed.avatar === "string" ? parsed.avatar.slice(0, 400000) : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      source: parsed.source === "tool" || parsed.source === "auto" ? parsed.source : "manual",
    };
  } catch {
    return null;
  }
}

export function saveWidgetData(data: WidgetData): void {
  kvSet(DATA_KEY, JSON.stringify(data));
  notifyUpdated();
}

export function clearWidgetData(): void {
  kvSet(DATA_KEY, "");
  notifyUpdated();
}

/** 记录角色上次主动换话的时间（自动生成调度用）。 */
const AUTO_LAST_RUN_KEY = "ai_phone_widget_auto_last_run_v1";
registerKvMigration(AUTO_LAST_RUN_KEY);

export function loadWidgetAutoLastRun(): number {
  const value = Number(kvGet(AUTO_LAST_RUN_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function markWidgetAutoRun(): void {
  kvSet(AUTO_LAST_RUN_KEY, String(Date.now()));
}
