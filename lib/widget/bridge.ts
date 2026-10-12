"use client";

/**
 * 小组件 ↔ 安卓壳的桥。
 *
 * 分工：
 *   网页负责「内容和样式」——把模板渲染成完整 HTML 交给原生；
 *   原生负责「画图和贴到桌面」——离屏 WebView 画成 Bitmap，再更新 RemoteViews。
 *
 * 为什么不让网页直接渲染成 PNG 再传：
 *   WebView 的 canvas.toDataURL 拿不到跨域图片（生成的头像是 data URL 没问题，
 *   但用户模板里若引了 http 图片就会污染画布）。交给原生离屏渲染没有这个限制，
 *   而且小手机关着时原生也能自己重画（用上次缓存的 HTML）。
 *
 * 所有方法在非壳环境安全降级为 no-op / false。
 */

import { loadWidgetConfig } from "./storage";

type PhoneWidgetBridge = {
  /** 是否支持小组件（老 APK 没有） */
  isSupported?: () => boolean;
  /** 提交渲染数据：HTML + 尺寸。原生据此重画并刷新桌面 */
  update?: (html: string, widthDp: number, heightDp: number, scale: number) => boolean;
  /** 让原生立刻重画一次（用上次缓存的 HTML） */
  refresh?: () => boolean;
  /** 是否已添加小组件到桌面（未添加时引导用户去加） */
  isPlaced?: () => boolean;
  /** 跳到系统的「添加小组件」界面 */
  requestPin?: () => boolean;
  /**
   * 小组件渲染诊断（**新壳才有**，旧壳没有这个方法）。
   *
   * 回传原生侧的实际状态：收到 HTML 没、PNG 有没有落盘、最后一次渲染成败。
   * 网页侧读不到时返回 null——调用方据此说明「需要更新安卓壳才能看到这一项」，
   * 而不是把它当成「一切正常」。
   */
  diagnostics?: () => string;
};

/** 新壳回传的小组件诊断。字段含义见原生 PhoneWidgetRenderer.diagnosticsJson。 */
export type WidgetDiagnostics = {
  hasHtml: boolean;
  htmlChars: number;
  pngExists: boolean;
  pngBytes: number;
  pngAt: number;
  renderAt: number;
  renderOk: boolean;
  renderError: string;
  rendering: boolean;
  placed: boolean;
};

function getBridge(): PhoneWidgetBridge | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { PhoneWidget?: PhoneWidgetBridge }).PhoneWidget;
  return api ?? null;
}

export function hasWidgetBridge(): boolean {
  const bridge = getBridge();
  if (!bridge) return false;
  try {
    return bridge.isSupported ? bridge.isSupported() === true : true;
  } catch {
    return false;
  }
}

/**
 * 把一份渲染好的 HTML 交给原生。
 *
 * @returns 是否成功送达（非壳环境、老壳都返回 false）
 */
export function pushWidgetHtml(
  html: string,
  size: { widthDp: number; heightDp: number; scale: number },
): boolean {
  const bridge = getBridge();
  if (!bridge?.update) return false;
  try {
    return bridge.update(html, size.widthDp, size.heightDp, size.scale) === true;
  } catch {
    return false;
  }
}

/** 让原生用缓存重画（例如用户刚改了桌面主题）。 */
export function refreshWidget(): boolean {
  const bridge = getBridge();
  if (!bridge?.refresh) return false;
  try {
    return bridge.refresh() === true;
  } catch {
    return false;
  }
}

/** 小组件是否已经放在桌面上。 */
export function isWidgetPlaced(): boolean {
  const bridge = getBridge();
  if (!bridge?.isPlaced) return false;
  try {
    return bridge.isPlaced() === true;
  } catch {
    return false;
  }
}

/** 拉起系统的「添加小组件」引导。 */
export function requestPinWidget(): boolean {
  const bridge = getBridge();
  if (!bridge?.requestPin) return false;
  try {
    return bridge.requestPin() === true;
  } catch {
    return false;
  }
}

/**
 * 读原生侧的小组件诊断。旧壳没这个方法时返回 null。
 *
 * 为什么要这个：渲染失败原来是静默的，桌面只会退回应用图标，而设置页的预览
 * 又是 iframe 自己画的（走不到原生）——两边都正常，只有桌面不对，用户和我们都
 * 无从判断卡在哪一步。有了它才能把链路逐段对照着看。
 */
export function readWidgetDiagnostics(): WidgetDiagnostics | null {
  const bridge = getBridge();
  if (!bridge?.diagnostics) return null;
  try {
    const raw = bridge.diagnostics();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WidgetDiagnostics;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 把当前存储里的配置与数据推给原生。保存配置、角色改了内容之后都该调一次。
 *
 * @param html 已经渲染好的 HTML（调用方用 renderWidgetHtml 生成）
 */
export function syncWidgetToNative(html: string): boolean {
  const config = loadWidgetConfig();
  if (!config.enabled) return false;
  // 不再要求「有内容」才推送：html 已经是渲染好的成品（没内容时调用方给的是
  // 占位模板）。卡在这里会让小组件退回显示应用图标，而不是模板本身。
  return pushWidgetHtml(html, {
    widthDp: config.widthDp,
    heightDp: config.heightDp,
    scale: config.scale,
  });
}
