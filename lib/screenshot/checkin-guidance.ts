"use client";

// 定时查岗的「反应指导语」：查岗到点触发后，额外交给角色的那段话。
//
// 为什么需要它：定时查岗给角色的只有一条方括号系统事件——「你把屏幕给它看了」
// 「你没有给它看」「你没有回应」「没能截到屏幕」。至于它该怎么反应（要不要损你
// 一句、被拒了该不该装没事），原先完全交给人设和预设自由发挥。想定得更具体，
// 就得有地方写这句话。
//
// 边界：
//  · 只作用于**定时查岗**这一条链路。角色自己在聊天里要求看屏幕（工具箱里的
//    「请求看屏幕」）走的是工具返回值那条路，不读这里。
//  · 这段话只进「这一次回应」的请求，不写进聊天记录——否则后面每一轮都会
//    重新看到它，变成反复念叨。
//  · 留空 = 不加任何话，维持「完全交给角色自己判断」的原样。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const GUIDANCE_KEY = "ai_phone_checkin_guidance_v1";
registerKvMigration(GUIDANCE_KEY);

export const CHECKIN_GUIDANCE_CHANGED_EVENT = "check-in-guidance-changed";

export type CheckInGuidance = {
  /** 用户把屏幕给它看了 */
  accepted: string;
  /** 用户点了「不给看」 */
  declined: string;
  /** 浮层一直没等到用户回应 */
  timeout: string;
  /** 截屏失败等其它原因（权限、保存失败……） */
  failed: string;
};

/** 四栏默认都留空：不改变原有表现，填了才生效。 */
export const DEFAULT_CHECKIN_GUIDANCE: CheckInGuidance = {
  accepted: "",
  declined: "",
  timeout: "",
  failed: "",
};

function normalizeGuidance(raw: unknown): CheckInGuidance {
  const source = (raw && typeof raw === "object") ? raw as Partial<CheckInGuidance> : {};
  const pick = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    accepted: pick(source.accepted),
    declined: pick(source.declined),
    timeout: pick(source.timeout),
    failed: pick(source.failed),
  };
}

export function loadCheckInGuidance(): CheckInGuidance {
  try {
    const raw = kvGet(GUIDANCE_KEY);
    if (!raw) return { ...DEFAULT_CHECKIN_GUIDANCE };
    return normalizeGuidance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CHECKIN_GUIDANCE };
  }
}

export function saveCheckInGuidance(patch: Partial<CheckInGuidance>): CheckInGuidance {
  const next = normalizeGuidance({ ...loadCheckInGuidance(), ...patch });
  kvSet(GUIDANCE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHECKIN_GUIDANCE_CHANGED_EVENT));
  }
  return next;
}

/**
 * 取某一类结果对应的指导语，并把角色名占位符换掉。
 *
 * 支持两种写法：{name} 和 {角色名}——用户不会记得我们内部用哪个，两种都认。
 * 留空时返回空串，调用方据此决定「不加任何话」。
 */
export function resolveCheckInGuidance(kind: keyof CheckInGuidance, characterName: string): string {
  const text = loadCheckInGuidance()[kind].trim();
  if (!text) return "";
  const name = characterName?.trim() || "TA";
  return text.split("{name}").join(name).split("{角色名}").join(name);
}
