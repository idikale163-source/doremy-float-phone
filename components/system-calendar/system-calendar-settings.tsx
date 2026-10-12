"use client";

// 系统日历设置面板：读 / 写两个独立开关 + 授权引导。
//
// 设计要点（与设备动作面板同一思路，但这里读和写必须分开）：
//  · 用户可能只想让角色「知道我的安排」，但不接受「往我日历里写东西」。
//    一个总开关会把这两种意图绑死，等于剥夺选择。所以读/写各一个开关、
//    各自申请权限、各自显示授权状态。
//  · 只读摘要、只新增不修改——这两条边界写在界面上，用户才知道给了什么权限。
//
// 挂载方式与 PerceptionSettings 一致：直接渲染内容，不套 PageShell、不收 onBack。

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarDays, Plus, ShieldCheck } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import {
  hasCalendarBridge,
  hasCalendarReadPermission,
  hasCalendarWritePermission,
  readSystemCalendarCapabilities,
  requestCalendarPermission,
} from "@/lib/system-calendar";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";
import {
  loadSystemCalendarConfig,
  saveSystemCalendarConfig,
  type SystemCalendarConfig,
} from "@/lib/system-calendar/config";

export function SystemCalendarSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<SystemCalendarConfig>(() => loadSystemCalendarConfig());
  const [caps, setCaps] = useState(() => readSystemCalendarCapabilities());

  const refresh = useCallback(() => {
    setConfig(loadSystemCalendarConfig());
    setCaps(readSystemCalendarCapabilities());
  }, []);

  // 授权状态是「去系统设置改完、回来才变」的，切回前台时刷一次
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("system-calendar-config-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("system-calendar-config-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const inShell = useMemo(() => isShell(), []);
  const bridgeOk = useMemo(() => hasCalendarBridge(), []);
  const canRead = hasCalendarReadPermission();
  const canWrite = hasCalendarWritePermission();

  const update = useCallback((patch: Partial<SystemCalendarConfig>) => {
    const next = { ...loadSystemCalendarConfig(), ...patch };
    saveSystemCalendarConfig(next);
    setConfig(next);
  }, []);

  const toggleRead = useCallback((on: boolean) => {
    update({ readEnabled: on });
    if (!on) return;
    if (!bridgeOk) {
      onNotice?.("当前 App 版本不支持读日历，请更新安卓壳");
      return;
    }
    if (!canRead) {
      const immediate = requestCalendarPermission(true, false);
      onNotice?.(immediate ? "读日历已就绪" : "请在系统弹窗里允许访问日历，允许后即可读取");
    }
  }, [update, onNotice, bridgeOk, canRead]);

  const toggleWrite = useCallback((on: boolean) => {
    update({ writeEnabled: on });
    if (!on) return;
    if (!bridgeOk) {
      onNotice?.("当前 App 版本不支持写日历，请更新安卓壳");
      return;
    }
    if (!canWrite) {
      const immediate = requestCalendarPermission(false, true);
      onNotice?.(immediate ? "写日历已就绪" : "请在系统弹窗里允许修改日历，允许后角色才能写入");
      return;
    }
    if (caps.hasWritableCalendar === false) {
      onNotice?.("这台设备上没有可写入的日历账户，写进去会失败");
    }
  }, [update, onNotice, bridgeOk, canWrite, caps]);

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">让角色知道你的日程</span>
          <span className="per-state" data-tone={bridgeOk ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {bridgeOk ? "已接通" : "需更新壳"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。系统日历需要安卓壳，这里只能预览界面。
          </div>
        )}
        {inShell && !bridgeOk && (
          <div className="per-note is-warn">
            当前 App 版本还没有日历桥，请更新到最新版安卓壳后使用。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>读和写是分开的，默认都关</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            读：角色能看到你系统日历里的安排（只读标题、时间、地点）。
            <br />
            写：角色能往你日历里加纪念日，到点系统提醒你。
            <b>只能新增，不能改动或删除你已有的任何安排。</b>
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 读 */}
        <div>
          <div className="settings-menu-section-title">读取日程</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <CalendarDays size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">让角色看到我的日程</span>
                <span className="menu-desc">
                  {canRead
                    ? "已授权。角色聊天时可以查你近期有什么安排"
                    : "未授权。打开后会申请日历读取权限"}
                </span>
              </div>
              <Toggle checked={config.readEnabled} onChange={toggleRead} />
            </div>
          </div>
        </div>

        {/* 写 */}
        <div>
          <div className="settings-menu-section-title">写入日程</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <Plus size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">允许角色记重要的日子</span>
                <span className="menu-desc">
                  {canWrite
                    ? "已授权。角色能把纪念日写进你的系统日历"
                    : "未授权。打开后会申请日历修改权限"}
                </span>
              </div>
              <Toggle checked={config.writeEnabled} onChange={toggleWrite} />
            </div>
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            角色写入的日程会带「[小手机·角色写入]」标记，你在日历里一眼能看出是它加的。
          </div>
        </div>

        {/* 能力实测 */}
        <div>
          <div className="settings-menu-section-title">本机实测</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <ShieldCheck size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">日历桥</span>
                <span className="menu-desc">{bridgeOk ? "App 已提供日历桥" : "当前 App 版本未提供，请更新安卓壳"}</span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <CalendarCheck size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">可写入的日历账户</span>
                <span className="menu-desc">
                  {caps.hasWritableCalendar === true
                    ? "有可写入的日历，角色能记事"
                    : caps.hasWritableCalendar === false
                      ? "没有可写入的日历账户，写入会失败"
                      : "需要先授予写权限才能检测"}
                </span>
              </div>
            </div>
          </div>
          <div className="per-actions">
            <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}>
              重新检测
            </button>
          </div>
        </div>

        <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
          角色要用这些，还要单独开能力：工具箱 → 内置能力 → 「系统日历」。
        </div>
      </div>
    </div>
  );
}
