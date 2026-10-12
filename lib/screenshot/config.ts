"use client";

// 截屏的配置存储。
//
// 与设备动作、系统日历同一取向：这是**写/看权限里最敏感的一类**——
// 截屏拿到的是用户整个屏幕，可能是银行页、私聊、密码框。
// 所以默认关，并且只提供「用户点一下才截一张」的路径。
//
// 走 kv-db（IndexedDB），不落服务端。图片本体另有媒体库（见 media-cache-storage），
// 这里只存配置和一小段记录索引，避免把几 MB 的 base64 塞进 KV。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { ScreenshotRecord } from "./types";

const CONFIG_KEY = "ai_phone_screenshot_config_v1";
const RECORDS_KEY = "ai_phone_screenshot_records_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(RECORDS_KEY);

/** 数字钳制：非法值退回默认，越界夹到范围内。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export type ScreenshotConfig = {
  /**
   * 总开关：是否允许截屏。默认关。
   *
   * 关掉时角色完全看不到这个能力，网页的截屏入口也应拦住。
   */
  enabled: boolean;
  /**
   * 截完是否发一条系统通知。默认开。
   *
   * 与设备动作同样的道理：这是**反馈**不是动作。截图这种「看到你屏幕」的事，
   * 用户事后必须在通知栏有据可查，否则就成了「它到底看我什么了」。
   */
  notifyOnCapture: boolean;
  /**
   * 最近记录保留多少条。默认 10。
   *
   * 作用是「让你能回头看它到底截了什么」——不是长期存档。
   * 超出后最旧的会被删（连媒体库里的图一起删），避免悄悄占满存储。
   */
  keepRecent: number;
  /**
   * 是否显示截屏悬浮球（桌面那个点一下就截的小圆点）。默认关。
   *
   * 与 enabled 分开：enabled 控制「截屏这件事允不允许」，这里控制
   * 「桌面要不要常驻一个球」。有人只想要角色查岗，不想桌面上多个东西。
   */
  ballEnabled: boolean;
  /**
   * 点悬浮球截屏后默认发给谁（角色 id）。空 = 每次都在浮层里选。
   *
   * 为什么值得有这个：点球的场景是「赶紧拍下来给你看」，多半站在外面、
   * 手上还拿着东西。每次都要在一排名字里点一下，这件事就从「顺手」
   * 变成了「操作」。固定一个人时直接跳过选择最省事；多聊时留空即可。
   */
  defaultShareCharacterId: string;
  /**
   * 悬浮球上的文字（最多 4 字符）。空串 = 只画圆点不显示字。
   *
   * 为什么让用户改：默认那个「截」字对有些人太直白（不想被人看到屏幕上
   * 有个截屏按钮），换成别的字或干脆不写都行——是用户自己的手机，
   * 该由他决定长什么样。
   */
  ballText: string;
  /** 悬浮球主色（#RRGGBB 或 #AARRGGBB）。 */
  ballColor: string;
  /** 悬浮球直径（dp），32~96。 */
  ballDiameter: number;
};

export const SCREENSHOT_DEFAULTS: ScreenshotConfig = {
  enabled: false,
  notifyOnCapture: true,
  keepRecent: 10,
  ballEnabled: false,
  // 空 = 每次让我选。默认不替用户指定收件人——猜错了等于发错人。
  defaultShareCharacterId: "",
  ballText: "截",
  // 与原生默认值保持一致（0xE6 透明度 + 蓝），否则「没改过」时
  // 设置页回显与桌面上的球颜色对不上。
  ballColor: "#E65B7CFA",
  ballDiameter: 50,
};

/** 读配置。任何字段缺失都按默认（默认 = 关）处理，绝不因为读失败而放开权限。 */
export function loadScreenshotConfig(): ScreenshotConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...SCREENSHOT_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ScreenshotConfig>;
    const keep = Number(parsed.keepRecent);
    return {
      // 必须显式 true 才算开
      enabled: parsed.enabled === true,
      // 反馈默认开：仅显式 false 才关（与开关的取向相反）
      notifyOnCapture: parsed.notifyOnCapture !== false,
      keepRecent: Number.isFinite(keep) ? Math.max(1, Math.min(50, Math.floor(keep))) : SCREENSHOT_DEFAULTS.keepRecent,
      // 必须显式 true 才算开——桌面上凭空多个球，缺省绝不能是开
      ballEnabled: parsed.ballEnabled === true,
      // 只接受非空字符串；角色被删掉时由推送清单那一层负责清掉（见 share-targets）
      defaultShareCharacterId: typeof parsed.defaultShareCharacterId === "string"
        ? parsed.defaultShareCharacterId
        : "",
      // 文字最多 4 个字符（原生也这么截），空串合法（表示不要字）
      ballText: typeof parsed.ballText === "string"
        ? parsed.ballText.slice(0, 4)
        : SCREENSHOT_DEFAULTS.ballText,
      ballColor: typeof parsed.ballColor === "string" && /^#?[0-9a-fA-F]{6,8}$/.test(parsed.ballColor)
        ? parsed.ballColor
        : SCREENSHOT_DEFAULTS.ballColor,
      ballDiameter: clampNumber(parsed.ballDiameter, 32, 96, SCREENSHOT_DEFAULTS.ballDiameter),
    };
  } catch {
    return { ...SCREENSHOT_DEFAULTS };
  }
}

export function saveScreenshotConfig(config: ScreenshotConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("screenshot-config-changed"));
  }
}

/** 读最近截屏记录（最新在前）。 */
export function loadScreenshotRecords(): ScreenshotRecord[] {
  try {
    const raw = kvGet(RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ScreenshotRecord => (
      !!item
      && typeof item === "object"
      && typeof (item as ScreenshotRecord).ref === "string"
    ));
  } catch {
    return [];
  }
}

export function saveScreenshotRecords(records: ScreenshotRecord[]): void {
  kvSet(RECORDS_KEY, JSON.stringify(records));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("screenshot-records-changed"));
  }
}
