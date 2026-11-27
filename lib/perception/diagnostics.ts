"use client";

// 感知系统的诊断与可视化数据源。
// 设置面板「感知 → 诊断」直接消费这里，不需要自己拼装。

import { isWithinPushQuietHours } from "../push-client";
import {
  hasPerceptionBridge,
  readHealthCapabilities,
  readHealthDiagnostics,
  readLocation,
  readLocationDiagnostics,
  readNativeCapabilities,
  readSleep,
  readUsageStats,
} from "./bridge";
import { isPerceptionRunning } from "./engine";
import { isCapabilityEnabled, loadPerceptionConfig, loadPerceptionState, loadPerceptionStatus } from "./storage";
import {
  PERCEPTION_CAPABILITY_DESC,
  PERCEPTION_CAPABILITY_LABEL,
  type PerceptionCapability,
  type PerceptionDiagnostics,
} from "./types";

/** 本机当天日期键（YYYY-MM-DD）。与引擎里同名函数保持一致，用于判断档位是不是今天的。 */
function todayKey(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 一次取全诊断状态。面板每次打开/刷新时调，不做缓存。 */
export function readPerceptionDiagnostics(): PerceptionDiagnostics {
  let accessibility = false;
  try {
    const bridge = (window as unknown as { AndroidShell?: { isAccessibilityConnected?: () => boolean } }).AndroidShell;
    accessibility = bridge?.isAccessibilityConnected?.() === true;
  } catch {
    accessibility = false;
  }

  const state = loadPerceptionState();
  const config = loadPerceptionConfig();
  const now = Date.now();
  const windowFresh = state.hourWindowStart > 0 && now - state.hourWindowStart < 60 * 60 * 1000;

  return {
    inShell: typeof window !== "undefined" && !!(window as unknown as { AndroidShell?: unknown }).AndroidShell,
    bridgeAvailable: hasPerceptionBridge(),
    running: isPerceptionRunning(),
    nativeCapabilities: readNativeCapabilities(),
    accessibility,
    lastSampleAt: state.lastSampleAt,
    lastSnapshot: state.lastSnapshot,
    status: loadPerceptionStatus(),
    appUsage: readUsageStats(12),
    // 位置读数：这一行曾在本批编辑中误删，导致面板位置信息恒为空。别删。
    location: readLocation(),
    locationDiagnostics: readLocationDiagnostics(),
    sleep: readSleep(),
    healthDiagnostics: readHealthDiagnostics(),
    hourlyUsed: windowFresh ? state.hourCount : 0,
    hourlyLimit: config.hourlyLimit,
    unmatchedSignals: state.unmatchedSignals,
    usageSignalTier: state.usageSignalDate === todayKey() ? state.usageSignalTier : {},
  };
}

/** 诊断面板里每个能力一行的展示模型。 */
export type CapabilityRow = {
  id: PerceptionCapability;
  label: string;
  desc: string;
  /** 用户是否开启了这个能力 */
  userEnabled: boolean;
  /** 壳是否真的支持（原生如实回答） */
  nativeSupported: boolean;
  /** 是否有额外前置条件没满足（如无障碍未开） */
  missingRequirement: string;
  /** 综合可用性：userEnabled && nativeSupported && 无缺失前置 */
  available: boolean;
};

/**
 * 组装「能力可用性」表。
 *
 * 这是本次审计的直接产物：三项分开显示（用户开了没 / 原生支持没 / 前置条件够没），
 * 用户一眼看出卡在哪一环，而不是面对一个没反应的开关。
 */
export function buildCapabilityRows(): CapabilityRow[] {
  const config = loadPerceptionConfig();
  const native = readNativeCapabilities();
  let accessibility = false;
  try {
    const bridge = (window as unknown as { AndroidShell?: { isAccessibilityConnected?: () => boolean } }).AndroidShell;
    accessibility = bridge?.isAccessibilityConnected?.() === true;
  } catch {
    accessibility = false;
  }

  // 睡眠的前置条件在健康桥那边（装没装 Health Connect、授没授权），
  // 不在感知桥的能力表里，所以单独读一次。
  const health = readHealthCapabilities();

  const ids: PerceptionCapability[] = [
    "battery", "network", "foregroundApp", "steps", "location", "sleep", "calendar", "contacts", "usageStats", "returnToPhone", "lifeRhythm",
  ];

  return ids.map(id => {
    const userEnabled = isCapabilityEnabled(config, id);
    // 这两个是纯网页实现（前后台计时 / 读时钟），不依赖原生桥，恒为支持。
    // 不特殊处理的话，非壳环境/老 APK 下会被 native[id]===true 判成「不支持」，
    // 而它们其实能用——比不显示更让人迷惑。
    const pureWeb: PerceptionCapability[] = ["returnToPhone", "lifeRhythm"];
    const nativeSupported = pureWeb.includes(id) ? true : native[id] === true;
    let missingRequirement = "";
    if (id === "foregroundApp" && nativeSupported && !accessibility) {
      missingRequirement = "需要开启无障碍服务";
    }
    if (id === "steps" && !nativeSupported) {
      missingRequirement = "需要重编 APK（当前壳版本未提供步数）";
    }
    // 使用统计：能力已接通，但需要特殊权限（去系统设置手动开），卡在这一环
    if (id === "usageStats" && nativeSupported && native.usageStatsGranted !== true) {
      missingRequirement = "需要「使用情况访问」权限（系统设置里手动开）";
    }
    // 定位：两层前置，且必须分开报——「权限给了但定位开关关着」是最容易
    // 被漏掉的一种（用户会以为权限都给了怎么还读不到）。
    if (id === "location" && nativeSupported) {
      if (native.locationGranted !== true) {
        missingRequirement = "需要位置权限";
      } else if (native.locationServiceOn !== true) {
        missingRequirement = "系统定位开关没开";
      }
    }
    // 睡眠：三层前置，逐个报清楚，否则用户只会看到「开了却没反应」。
    // 顺序按可操作性排：先装（没装就得去装），再授权。
    if (id === "sleep" && nativeSupported) {
      if (health.healthAvailable !== true) {
        missingRequirement = "需要先安装 Health Connect";
      } else if (health.healthGranted !== true) {
        missingRequirement = "需要授予睡眠读取权限";
      }
    }
    return {
      id,
      label: PERCEPTION_CAPABILITY_LABEL[id],
      desc: PERCEPTION_CAPABILITY_DESC[id],
      userEnabled,
      nativeSupported,
      missingRequirement,
      available: userEnabled && nativeSupported && !missingRequirement,
    };
  });
}

/** 安静时段是否正在生效（面板给一条轻提示）。 */
export function isQuietHoursActive(): boolean {
  const config = loadPerceptionConfig();
  return config.respectQuietHours && isWithinPushQuietHours(Date.now());
}
