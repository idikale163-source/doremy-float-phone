"use client";

/**
 * 小手机内 APP 联动：让规则把内容写进小手机里的其它应用。
 *
 * 与「设备动作」的分工：
 *   设备动作 = 真实安卓手机上的事（手电筒、打开应用）；
 *   APP 联动 = 小手机**内部**应用里的事（朋友圈、日记）。
 * 两者都算「角色做了什么」，但一个作用于真实世界，一个作用于它自己住的这部手机。
 *
 * 为什么单独成模块：这些写入各自要遵守对应 APP 的既有约定（朋友圈要带可见人列表、
 * 日记要有 blocks），散在规则引擎里会让那边越来越难读。这里统一收口，
 * 引擎只负责调用与措辞。
 */

import { loadCharacters } from "../character-storage";
import { addMomentPost } from "../moments-storage";
import { createDiaryEntry, loadDiaryEntries, saveDiaryEntries } from "../diary-entry-storage";

/** 支持被规则写入的小手机内 APP。 */
export type BridgeAppActionId = "moment" | "diary";

export const BRIDGE_APP_ACTION_LABEL: Record<BridgeAppActionId, string> = {
  moment: "发朋友圈",
  diary: "写日记",
};

export const BRIDGE_APP_ACTION_DESC: Record<BridgeAppActionId, string> = {
  moment: "以角色身份发一条朋友圈。场景：生日、纪念日、角色想说点什么但不想直接发消息。",
  diary: "以角色身份写一篇日记。场景：角色复盘这一天、把心事写下来。",
};

export type BridgeAppActionOutcome = {
  ok: boolean;
  message?: string;
  reason?: string;
};

/**
 * 执行一次小手机内 APP 写入。
 *
 * @param action 动作标识
 * @param characterId 以哪个角色的身份；缺省取第一个角色
 * @param text 要写入的正文（已经过规则加工）
 * @param title 可选标题（日记用；朋友圈忽略）
 */
export function runBridgeAppAction(
  action: string,
  characterId: string | undefined,
  text: string,
  title?: string,
): BridgeAppActionOutcome {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, reason: "内容为空，没有可写的东西" };

  const characters = loadCharacters();
  const character = characterId
    ? characters.find(item => item.id === characterId)
    : characters[0];
  if (!character) return { ok: false, reason: "还没有创建角色，无法以角色身份写入" };

  if (action === "moment") {
    // 可见人列表给全部角色：角色发的朋友圈默认对所有同世界角色可见，
    // 与「角色自己发帖」时引擎的取法一致（那边也是全体可见）。
    const post = addMomentPost({
      authorType: "character",
      authorId: character.id,
      content: body.slice(0, 2000),
      visibility: characters.map(item => item.id),
    });
    // addMomentPost 命中内容去重时会返回 null（同一条内容 24 小时内不重复发）
    if (!post) return { ok: false, reason: "同样内容刚发过，已跳过" };
    return { ok: true, message: `${character.name} 发了一条朋友圈` };
  }

  if (action === "diary") {
    const entry = createDiaryEntry({
      characterId: character.id,
      characterName: character.name,
      title: (title ?? "").trim() || body.slice(0, 20),
      body: body.slice(0, 6000),
      blocks: [{ type: "paragraph", text: body.slice(0, 6000) }],
      trigger: "manual",
    });
    saveDiaryEntries([entry, ...loadDiaryEntries()]);
    return { ok: true, message: `${character.name} 写了一篇日记` };
  }

  return { ok: false, reason: `不认识的小手机应用动作：${action}` };
}
