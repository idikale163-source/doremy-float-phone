"use client";

// 分享目标：用户主动截屏（悬浮球）时「发给谁」的候选清单。
//
// 为什么要提前推给原生，而不是浮层弹出时现取：
//   查岗是网页自己发起的（它必然活着），点球不是——那一刻网页很可能
//   已被系统回收。若让浮层回网页取清单，多半取不到，用户点开只看到
//   一个空清单。所以清单在「打开悬浮球开关 / 角色有变动 / 页面回到前台」
//   这几个时刻推给原生存好，浮层直接读本地的。
//
// 为什么只传 id 与名字、不传头像：这是 @JavascriptInterface 的同步字符串
// 参数，头像 base64 动辄几百 KB 到几 MB，塞进去有撑爆桥的风险；浮层里
// 用名字已经足够认出是谁。
//
// 隐私相关：清单只包含用户自己创建的角色名，不含聊天内容、不含任何
// 屏幕信息；它只是一份「收件人候选」。

import { loadCharacters } from "../character-storage";
import { loadScreenshotConfig } from "./config";
import { pushScreenshotShareTargets, supportsShareTargets } from "./checkin";
import type { ScreenshotShareTarget } from "./types";

/** 清单上限：浮层里是一排小胶囊，再多也没法点。 */
export const SHARE_TARGET_LIMIT = 30;

/** 从角色库构建可分享清单（只取有名字的，最多前 N 个）。 */
export function buildShareTargets(): ScreenshotShareTarget[] {
  try {
    return loadCharacters()
      .filter(character => !!character?.id && !!character.name?.trim())
      .slice(0, SHARE_TARGET_LIMIT)
      .map(character => ({ id: character.id, name: character.name.trim() }));
  } catch {
    return [];
  }
}

/**
 * 把清单与默认角色推给原生。
 *
 * 返回 false 表示壳没有这个接口（老 APK）——此时用户主动截屏仍按
 * 「最近聊过的私聊会话」发送，与加选择之前的行为一致，不是错误。
 */
export function syncScreenshotShareTargets(): boolean {
  if (!supportsShareTargets()) return false;
  const config = loadScreenshotConfig();
  const targets = buildShareTargets();
  // 默认角色可能已经被删了：就地清掉，免得浮层锁死在一个不存在的目标上，
  // 用户点了「发给它」却怎么都发不出去，还找不到原因。
  const defaultId = targets.some(item => item.id === config.defaultShareCharacterId)
    ? config.defaultShareCharacterId
    : "";
  return pushScreenshotShareTargets(targets, defaultId);
}

/** 某个角色当前是不是默认收件人（设置页高亮用）。 */
export function isDefaultShareTarget(characterId: string): boolean {
  return loadScreenshotConfig().defaultShareCharacterId === characterId;
}
