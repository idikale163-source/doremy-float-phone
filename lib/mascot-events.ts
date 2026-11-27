// lib/mascot-events.ts
// Unified event bus for mascot ↔ app communication.

import { setMascotContext, type MascotPageContext } from "./mascot-context";

// ── Page → Mascot: context changed ──
export function notifyMascotPageContext(ctx: MascotPageContext) {
  setMascotContext(ctx);
  window.dispatchEvent(new CustomEvent("mascot-page-context", { detail: ctx }));
}

// ── Mascot → Page: fill a field ──
export function mascotFillField(data: { field: string; value: string; _batchId?: string }) {
  window.dispatchEvent(new CustomEvent("mascot-fill-field", { detail: data }));
}

// ── Mascot → Shell: navigate ──
export function mascotNavigate(app: string, mode?: string) {
  window.dispatchEvent(new CustomEvent("mascot-navigate", { detail: { app, mode } }));
}

// ── Mascot → Desktop: widgets / DIY templates changed in kv, re-hydrate ──
export const DESKTOP_WIDGETS_CHANGED_EVENT = "mascot-widgets-changed";

export function notifyDesktopWidgetsChanged() {
  window.dispatchEvent(new CustomEvent(DESKTOP_WIDGETS_CHANGED_EVENT));
}

// ── Mascot → UI: open DIY widget preview dialog ──
export const DIY_WIDGET_PREVIEW_EVENT = "mascot-diy-widget-preview";

export type DiyWidgetPreviewRequest = {
  templateId: string;
  name: string;
  size: string;
  htmlString: string;
};

export type DiyWidgetPreviewEventDetail = {
  request: DiyWidgetPreviewRequest;
  /** 由前端处理器置 true；派发后仍为 false 说明没有挂载弹窗宿主 */
  handled: boolean;
};

export function requestDiyWidgetPreview(request: DiyWidgetPreviewRequest): boolean {
  const detail: DiyWidgetPreviewEventDetail = { request, handled: false };
  window.dispatchEvent(new CustomEvent<DiyWidgetPreviewEventDetail>(DIY_WIDGET_PREVIEW_EVENT, { detail }));
  return detail.handled;
}

// ── Mascot → UI: open online-chat status bar preview dialog ──
export const STATUS_BAR_PREVIEW_EVENT = "mascot-status-bar-preview";

export type StatusBarPreviewRequest = {
  /** 会话展示名，仅用于弹窗标题 */
  displayName: string;
  /** 输出渲染：完整 HTML（沙盒 iframe 执行） */
  renderHtml: string;
  /** 示例数据：[状态栏] 壳内原文的样例，注入 window.STATUS_RAW */
  previewRaw: string;
};

export type StatusBarPreviewEventDetail = {
  request: StatusBarPreviewRequest;
  /** 由前端处理器置 true；派发后仍为 false 说明没有挂载弹窗宿主 */
  handled: boolean;
};

export function requestStatusBarPreview(request: StatusBarPreviewRequest): boolean {
  const detail: StatusBarPreviewEventDetail = { request, handled: false };
  window.dispatchEvent(new CustomEvent<StatusBarPreviewEventDetail>(STATUS_BAR_PREVIEW_EVENT, { detail }));
  return detail.handled;
}

// ── Mascot → UI: open meeting invitation card preview dialog ──
export const MEETING_INVITE_PREVIEW_EVENT = "mascot-meeting-invite-preview";

export type MeetingInvitePreviewRequest = {
  /** 弹窗标题中的来源说明。 */
  displayName: string;
  /** 完整 HTML/CSS/JS，使用与真实邀请卡片相同的沙盒渲染器。 */
  renderHtml: string;
  /** 邀请卡片示例原文，注入 window.STATUS_RAW。 */
  previewRaw: string;
};

export type MeetingInvitePreviewEventDetail = {
  request: MeetingInvitePreviewRequest;
  handled: boolean;
};

export function requestMeetingInvitePreview(request: MeetingInvitePreviewRequest): boolean {
  const detail: MeetingInvitePreviewEventDetail = { request, handled: false };
  window.dispatchEvent(new CustomEvent<MeetingInvitePreviewEventDetail>(MEETING_INVITE_PREVIEW_EVENT, { detail }));
  return detail.handled;
}
