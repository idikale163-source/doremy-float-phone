"use client";

// 设备动作设置面板：逐动作开关 + 授权引导 + 能力实测。
//
// 设计要点：
//  · 这是**写操作**，比感知（只读）更需要用户掌控，所以粒度到单个动作。
//  · 每个动作三态显示：壳支持没 / 授权了没 / 你开了没——卡在哪一环要一眼可见。
//  · 需要授权的动作（亮度、勿扰）给「去授权」按钮，直接跳系统页，
//    不给用户留「怎么授权」的猜测。
//
// 挂载方式与 PerceptionSettings 一致：直接渲染内容，不套 PageShell、不收 onBack。

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlarmClock, Globe, Lightbulb, Moon, Music, Smartphone, Sun, Timer, Volume2, Zap } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import {
  DEVICE_ACTION_DESC,
  DEVICE_ACTION_LABEL,
  hasDeviceActionBridge,
  loadDeviceActionConfig,
  openSystemSettings,
  readDeviceActionCapabilities,
  readGrantStatus,
  saveDeviceActionConfig,
  TOGGLEABLE_ACTIONS,
  type DeviceActionConfig,
  type DeviceActionId,
} from "@/lib/device-action";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";


const ACTION_ICONS: Record<string, typeof Lightbulb> = {
  torch: Lightbulb,
  volume: Volume2,
  brightness: Sun,
  dnd: Moon,
  openApp: Smartphone,
  alarm: AlarmClock,
  timer: Timer,
  media: Music,
  openUrl: Globe,
};

export function DeviceActionSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<DeviceActionConfig>(() => loadDeviceActionConfig());
  const [caps, setCaps] = useState(() => readDeviceActionCapabilities());
  const [grants, setGrants] = useState(() => readGrantStatus());

  const refresh = useCallback(() => {
    setConfig(loadDeviceActionConfig());
    setCaps(readDeviceActionCapabilities());
    setGrants(readGrantStatus());
  }, []);

  // 授权状态是「离开这个页面去系统设置改、回来才变」的，
  // 所以切回前台时刷一次，用户不必手动刷新。
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("device-action-config-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("device-action-config-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const inShell = useMemo(() => isShell(), []);
  const bridgeOk = useMemo(() => hasDeviceActionBridge(), [caps]);

  const update = useCallback((patch: Partial<DeviceActionConfig>) => {
    const next = { ...loadDeviceActionConfig(), ...patch };
    saveDeviceActionConfig(next);
    setConfig(next);
  }, []);

  const toggleAction = useCallback((id: DeviceActionId, on: boolean) => {
    const current = loadDeviceActionConfig();
    update({ actions: { ...current.actions, [id]: on } });
    if (on && caps[id] !== true) {
      onNotice?.(`当前 App 版本不支持「${DEVICE_ACTION_LABEL[id]}」，开启后角色也用不了`);
      return;
    }
    // 改系统音量/亮度/勿扰都是**持久**改动，不会自己变回来。
    // 用户开的时候明确说一句，避免出现「手机怎么静音了」的困惑。
    if (on && (id === "volume" || id === "brightness" || id === "dnd")) {
      onNotice?.(`「${DEVICE_ACTION_LABEL[id]}」的改动是持久的，角色调过之后不会自动恢复`);
    }
    // 会把用户带离小手机的三个动作，开启时把后果说清楚
    if (on && (id === "media" || id === "openUrl" || id === "openApp")) {
      onNotice?.(`开启后角色可以${DEVICE_ACTION_LABEL[id]}，你的屏幕可能会被切走`);
    }
    if (on && id === "alarm") {
      onNotice?.("角色设闹钟时会打开系统时钟界面，需要你确认才会真正生效");
    }
  }, [update, onNotice, caps]);

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">让角色替你按一下</span>
          <span className="per-state" data-tone={config.enabled && bridgeOk ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {config.enabled && bridgeOk ? "可用" : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。设备动作需要安卓壳，这里只能预览界面。
          </div>
        )}
        {inShell && !bridgeOk && (
          <div className="per-note is-warn">
            当前 App 版本还没有设备动作桥，请更新到最新版安卓壳后使用。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>默认全部关闭，需要你逐个打开</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            这里的每个动作都会<b>真的在你手机上生效</b>，不是聊天里的模拟。
            调音量、亮度、勿扰都是持久改动，角色调过之后不会自动恢复。
            刻意只做一次性、看得见的小事——不发短信、不打电话、不读通讯录、不删东西。
          </div>
        </div>
      </div>

      {/* 总开关 */}
      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        <div>
          <div className="settings-menu-section-title">总开关</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">允许角色操作我的设备</span>
                <span className="menu-desc">默认关闭。打开后仍需逐个开启下面的动作，角色才会生效</span>
              </div>
              <Toggle checked={config.enabled} onChange={(v: boolean) => {
                update({ enabled: v });
                if (v) onNotice?.("记得在下面逐个打开你允许的动作，否则角色仍然用不了");
              }} />
            </div>
          </div>
        </div>

        {/* 逐动作 */}
        <div>
          <div className="settings-menu-section-title">可以做的动作</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            {TOGGLEABLE_ACTIONS.map(id => {
              const Icon = ACTION_ICONS[id] ?? Zap;
              // 与感知相反：写操作必须显式开过才算开（缺失 = 关）
              const userEnabled = config.actions[id] === true;
              const supported = caps[id] === true;
              const granted = id === "brightness" ? grants.brightness
                : id === "dnd" ? grants.dnd
                // 媒体控制没授权也能用（盲发按键），只是没法确认生效——不拦着开，
                // 但在下面给一条「去授权」提示，否则用户会一直看到「没能确认」。
                : true;
              // media / openUrl / alarm / timer 会把用户带离小手机或改变系统响铃，
              // 开启时明确提醒一句——这几个的存在感比手电筒强得多。
              const needGrant = supported && !granted;
              return (
                <div className="per-cap" key={id} data-available={userEnabled && supported && granted ? "true" : "false"}>
                  <div className="per-cap-icon"><Icon size={17} strokeWidth={1.8} /></div>
                  <div className="per-cap-body">
                    <div className="per-cap-name">{DEVICE_ACTION_LABEL[id]}</div>
                    <div className="per-cap-desc">{DEVICE_ACTION_DESC[id]}</div>
                    <div className="per-tags">
                      <span className="per-tag" data-tone={userEnabled ? "ok" : "off"}>
                        {userEnabled ? "已开启" : "已关闭"}
                      </span>
                      <span className="per-tag" data-tone={supported ? "ok" : "off"}>
                        {supported ? "App 已支持" : "当前版本不支持"}
                      </span>
                      {needGrant && (
                        <button
                          type="button"
                          className="per-tag"
                          data-tone="warn"
                          style={{ cursor: "pointer", border: "none" }}
                          onClick={() => {
                            const ok = openSystemSettings(id === "brightness" ? "write_settings" : "dnd");
                            onNotice?.(ok ? "请在系统页面里授权，回来即可生效" : "没能打开系统设置，请手动到「设置 → 应用 → 特殊权限」里授权");
                          }}
                        >
                          去授权
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="per-cap-toggle">
                    <Toggle checked={userEnabled} onChange={(v: boolean) => toggleAction(id, v)} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            角色要做这些动作，还要单独开能力：工具箱 → 内置能力 → 「操作手机设备」。
          </div>
        </div>

        {/* 反馈 */}
        <div>
          <div className="settings-menu-section-title">反馈</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">动了我的手机就通知我</span>
                <span className="menu-desc">
                  角色调整你的设备后发一条系统通知，写明是谁、动了什么。
                  默认开启——关掉的话，你就只能靠聊天里的记录发现了。
                </span>
              </div>
              <Toggle
                checked={config.notifyOnAction !== false}
                onChange={(v: boolean) => update({ notifyOnAction: v })}
              />
            </div>
          </div>
        </div>

        {/* 能力实测 */}
        <div>
          <div className="settings-menu-section-title">本机实测</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">原生桥</span>
                <span className="menu-desc">{bridgeOk ? "App 已提供设备动作桥" : "当前 App 版本未提供，请更新安卓壳"}</span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">手电筒硬件</span>
                <span className="menu-desc">{caps.torch === true ? "这台设备有可用闪光灯" : "没检测到闪光灯"}</span>
              </div>
            </div>
            {/* 闹钟/倒计时：这两项现在真去查过能不能拉起，不再是写死的 true。 */}
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">闹钟 / 倒计时</span>
                <span className="menu-desc">
                  {caps.alarm === true && caps.timer === true
                    ? "系统里有可用的时钟应用"
                    : "系统里没有能响应闹钟/倒计时的应用（厂商可能精简了时钟）"}
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">修改系统设置权限</span>
                <span className="menu-desc">{grants.brightness ? "已授权（可调亮度）" : "未授权，调亮度会失败"}</span>
              </div>
            </div>
            {/* 自动亮度开着时，角色写的亮度会被系统很快改回去——用户看到的现象是
                「它说调好了，屏幕没变」。权限那行显示正常，问题却不在这儿，所以单独列出来。 */}
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">自动亮度</span>
                <span className="menu-desc">
                  {caps.brightnessAuto === true
                    ? "已开启。角色调的亮度会被系统盖回去，建议先关掉自动亮度"
                    : caps.brightnessAuto === false
                      ? "已关闭，角色可以接管亮度"
                      : "当前 App 版本不上报这项，需更新安卓壳"}
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">勿扰访问权限</span>
                <span className="menu-desc">{grants.dnd ? "已授权（可开关勿扰）" : "未授权，勿扰会失败"}</span>
              </div>
            </div>
            {/* 媒体会话读取：有它才能读到播放状态、确认指令是否真的生效。
                没有也能用，只是角色只能说「指令发出去了」，无法确认。 */}
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">通知使用权（媒体确认用）</span>
                <span className="menu-desc">
                  {caps.mediaSessionGranted === true
                    ? "已授权。角色控制音乐后能读回播放状态、确认是否真的生效"
                    : caps.mediaSessionGranted === false
                      ? "未授权。角色仍能控制音乐，但只能盲发指令、无法确认是否生效"
                      : "当前 App 版本不上报这项，需更新安卓壳"}
                </span>
              </div>
              {caps.mediaSessionGranted !== true && (
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  onClick={() => {
                    const ok = openSystemSettings("notification_listener");
                    onNotice?.(ok
                      ? "请在列表里找到「小手机」并允许通知使用权（它不会读你的通知内容，只为读播放状态）"
                      : "没能打开系统设置，请手动到「设置 → 通知 → 通知使用权」里授权");
                  }}
                >
                  去授权
                </button>
              )}
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">使用情况访问权限</span>
                <span className="menu-desc">
                  {grants.usageStats
                    ? "已授权（角色可读取各应用使用时长）"
                    : "未授权。这是特殊权限，只能去系统设置里手动开"}
                </span>
              </div>
              {!grants.usageStats && (
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  onClick={() => {
                    const ok = openSystemSettings("usage_stats");
                    onNotice?.(ok
                      ? "请在系统页面里找到「小手机」并允许使用情况访问"
                      : "没能打开系统设置，请手动到「设置 → 应用 → 特殊应用权限 → 使用情况访问」里授权");
                  }}
                >
                  去授权
                </button>
              )}
            </div>
          </div>
          <div className="per-actions">
            <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
