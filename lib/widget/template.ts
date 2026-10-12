"use client";

/**
 * 小组件模板：把数据填进用户写的 HTML/CSS，交给原生离屏渲染成图。
 *
 * 为什么开放「整段 HTML+CSS」而不是给几个开关：
 *   给开关永远不够用——总有人想要渐变、想要斜着放、想要不同的字体组合。
 *   而渲染本来就经过 WebView，CSS 能做的都能做，没理由拦着。
 *   所以内置模板只是**起点示例**，用户想改哪就改哪。
 *
 * 安全：渲染发生在原生离屏 WebView 里，加载的是本地字符串（loadDataWithBaseURL），
 * 不联网、不执行脚本（javaScriptEnabled=false）。模板里的 <script> 不会运行。
 */

import type { WidgetData } from "./types";

/** 模板可用的占位符（写文档时同步更新这里）。 */
export const WIDGET_PLACEHOLDERS = [
  { token: "{{text}}", desc: "那句话本身" },
  { token: "{{status}}", desc: "状态标签，如「在想你」；没有时整个元素建议隐藏" },
  { token: "{{signature}}", desc: "落款（角色名）" },
  { token: "{{avatar}}", desc: "头像地址（data URL）；没图时是空串" },
  { token: "{{avatarFallback}}", desc: "头像降级色（#RRGGBB），可直接当背景色用" },
  { token: "{{initial}}", desc: "角色名首字，做文字头像用" },
  { token: "{{time}}", desc: "更新时间，如「今天 14:30」" },
  { token: "{{charName}}", desc: "角色名（同 signature，语义更明确）" },
  { token: "{{userName}}", desc: "你的名字" },
  { token: "{{hasStatus}}", desc: "有状态时是 1，否则 0（配合 CSS 用）" },
  { token: "{{hasAvatar}}", desc: "有头像时是 1，否则 0" },
] as const;

/**
 * 内置模板。
 *
 * 排版意图：头像在左上，话是主角（字号最大），状态是一个小胶囊，落款压右下。
 * 用 CSS 变量集中管配色，方便用户直接改一处换整张的色调。
 */
export const DEFAULT_WIDGET_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* ── 配色：改这几行就能换整张卡片的调子 ── */
  :root {
    --bg: #ffffff;
    --bg-accent: #f4f1ff;
    --ink: #1a1a20;
    --sub: #8a8a95;
    --accent: #7a5af8;
    --radius: 22px;
    --pad: 16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; }
  body {
    font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    background: transparent;
    display: flex;
  }
  .card {
    flex: 1;
    position: relative;
    overflow: hidden;
    border-radius: var(--radius);
    padding: var(--pad);
    background:
      radial-gradient(120% 90% at 100% 0%, var(--bg-accent), transparent 60%),
      var(--bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 38px; height: 38px;
    flex: 0 0 auto;
    border-radius: 50%;
    overflow: hidden;
    background: var(--avatar-fallback, var(--accent));
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 16px; font-weight: 700;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sig { font-size: 12px; font-weight: 700; color: var(--ink); }
  .time { font-size: 10px; color: var(--sub); }
  .status {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: 10.5px;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 999px;
    color: var(--accent);
    background: var(--bg-accent);
  }
  .text {
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink);
    font-weight: 500;
    /* 最多三行，超出打点，避免把卡片撑爆 */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div class="avatar" style="--avatar-fallback: {{avatarFallback}}">
        {{avatarInner}}
      </div>
      <div class="who">
        <div class="sig">{{signature}}</div>
        <div class="time">{{time}}</div>
      </div>
      {{statusChip}}
    </div>
    <div class="text">{{text}}</div>
  </div>
</body>
</html>`;

/** HTML 转义：数据来自角色/用户，进 HTML 前必须转义，否则一个 < 就把结构冲坏。 */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 由角色名稳定地推一个颜色，让每个角色的降级头像有区分度。 */
export function fallbackColorFor(name: string): string {
  const palette = [
    "#7A5AF8", "#4C86F5", "#2FA46A", "#E8A33D", "#E86A8D", "#5FBFD9", "#B47AD6", "#D9744E",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

/** 时间说成人话：今天只给时分，昨天前天点名，更早给日期。 */
function describeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays === 2) return `前天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 把数据套进模板，产出可直接交给 WebView 的完整 HTML。
 *
 * @param template 用户模板；空串时用内置模板
 * @param data 要显示的内容
 * @param charName 角色名（落款）
 * @param userName 用户名
 */
export function renderWidgetHtml(
  template: string,
  data: WidgetData,
  charName: string,
  userName: string,
): string {
  const name = charName || "角色";
  const hasAvatar = Boolean(data.avatar);
  const hasStatus = Boolean(data.status && data.status.trim());
  const avatarFallback = fallbackColorFor(name);
  const initial = esc(name.trim().slice(0, 1) || "?");

  // 头像块：有图放图，没图用「降级色 + 首字」。拼成一段供 {{avatarInner}} 用。
  const avatarInner = hasAvatar
    ? `<img src="${esc(data.avatar)}" alt="">`
    : initial;
  const statusChip = hasStatus
    ? `<div class="status">${esc(data.status)}</div>`
    : "";

  const base = template.trim() || DEFAULT_WIDGET_TEMPLATE;
  return base
    .replace(/\{\{text\}\}/g, esc(data.text))
    .replace(/\{\{status\}\}/g, esc(data.status))
    .replace(/\{\{statusChip\}\}/g, statusChip)
    .replace(/\{\{avatarInner\}\}/g, avatarInner)
    .replace(/\{\{signature\}\}/g, esc(name))
    .replace(/\{\{charName\}\}/g, esc(name))
    .replace(/\{\{userName\}\}/g, esc(userName))
    .replace(/\{\{avatar\}\}/g, esc(data.avatar))
    .replace(/\{\{avatarFallback\}\}/g, avatarFallback)
    .replace(/\{\{initial\}\}/g, initial)
    .replace(/\{\{time\}\}/g, esc(describeTime(data.updatedAt)))
    .replace(/\{\{hasStatus\}\}/g, hasStatus ? "1" : "0")
    .replace(/\{\{hasAvatar\}\}/g, hasAvatar ? "1" : "0");
}
