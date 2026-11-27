"use client";

// 设备动作的反馈：让用户知道角色刚动了他的手机。
//
// 为什么需要这个模块：
//   工具结果里的 userNotice 只会落一条 [执行动作] 消息**在聊天室里**。
//   如果用户在小手机桌面、或 App 在后台，角色把灯开了、把手机静音了，
//   他完全不知道——这就是「神戳戳」。
//
// 复用已有的通知链路而不是新造：
//   dispatchChatMessageNotice → desktop-shell 会判断「用户是不是正在看这个
//   会话」，不是就弹系统通知（壳内走原生、浏览器走 Web Notification）。
//   也就是说，反馈与「角色发消息」享受完全相同的分发与免打扰规则。
//
// 刻意不在这里判断前台/后台：那个判断在 desktop-shell 里，只有一处。
// 在这里再判一次会造成两处逻辑不一致（用户明明在聊天室里却收到通知）。

import { dispatchChatMessageNotice } from "../chat-notification-events";
import { loadDeviceActionConfig } from "./storage";

/** 动作 → 反馈文案里用的说法。 */
const ACTION_PHRASE: Record<string, string> = {
  torch: "手电筒",
  volume: "音量",
  brightness: "屏幕亮度",
  dnd: "勿扰模式",
  openApp: "应用",
};

/**
 * 通知一条设备动作反馈。
 *
 * @param sessionId 当前会话（通知点击后直达）；缺失则不发——没有会话就
 *                  没有「谁在操作」，一条无归属的通知只会让用户更困惑。
 * @param characterName 角色名，用作通知标题。
 * @param avatar 角色头像。
 * @param message 结果描述（来自 runDeviceAction 的 message）。
 * @param action 动作 id，用于挑选自然的中文说法。
 */
export function notifyDeviceAction(params: {
  sessionId?: string;
  characterName?: string;
  avatar?: string | null;
  message: string;
  action: string;
}): void {
  if (typeof window === "undefined") return;
  if (!loadDeviceActionConfig().notifyOnAction) return;
  if (!params.sessionId) return;

  const phrase = ACTION_PHRASE[params.action] || "设备";
  const who = params.characterName?.trim() || "对方";
  // 文案刻意带上「你的」：通知栏里必须一眼看出被操作的是**用户的**设备，
  // 而不是小手机里的虚拟东西。
  const body = `${who}调整了你的${phrase}：${params.message}`;

  dispatchChatMessageNotice({
    sessionId: params.sessionId,
    body,
    senderName: who,
    avatar: params.avatar ?? null,
  });
}
