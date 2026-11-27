"use client";

// 感知设置面板：能力开关 + 阈值调节 + 诊断。
//
// 设计要点：
//  · 每个能力同时显示三重状态（用户开关 / 原生支持 / 前置条件），
//    用户一眼看出卡在哪一环，而不是对着没反应的开关猜。
//  · 所有数值改动即时保存并重启引擎（采样间隔变了要重建定时器）。
//  · 诊断区展示运行态、原生能力表、最近取值、信号流水，
//    并支持一键清空——感知数据只留本机，用户随时可清。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, BarChart3, Battery, Calendar, Cloud,
  Footprints, MapPin, Moon, Plus, RefreshCw, ShieldCheck, Smartphone, Sunrise, Trash2, Users, Wifi,
} from "lucide-react";

import { Toggle } from "@/components/ui/form";
import {
  buildCapabilityRows,
  clearPerceptionLog,
  isQuietHoursActive,
  loadPerceptionConfig,
  loadPerceptionLog,
  readPerceptionDiagnostics,
  restartPerception,
  resetPerceptionState,
  savePerceptionConfig,
  type PerceptionCapability,
  type PerceptionConfig,
  type PerceptionLogEntry,
} from "@/lib/perception";
import { clearCloudStatus } from "@/lib/perception/cloud-sync";
import {
  hasHealthPermission,
  hasLocationPermission,
  hasStepPermission,
  readHealthCapabilities,
  readLocationCapabilities,
  requestHealthPermission,
  requestLocationPermission,
  requestStepPermission,
} from "@/lib/perception/bridge";
import { describeStatus, filterStatusBySwitches } from "@/lib/perception/describe";

const CAP_ICONS: Record<PerceptionCapability, typeof Battery> = {
  battery: Battery,
  network: Wifi,
  foregroundApp: Smartphone,
  location: MapPin,
  sleep: Moon,
  calendar: Calendar,
  contacts: Users,
  usageStats: BarChart3,
  steps: Footprints,
  returnToPhone: Activity,
  lifeRhythm: Sunrise,
  // deviceAction 不出现在能力列表里（没有开关），但 Record 要求每个能力都有条目。
  // 缺了它 TS 会报缺键，运行时若真被渲染出来则会是 undefined 图标直接崩。
  deviceAction: Smartphone,
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 挂载方式与 CallOverlaySettings 一致：直接渲染内容，由设置页的 page-body 负责
// 标题栏与滚动。所以这里不套 PageShell、不收 onBack。
export function PerceptionSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<PerceptionConfig>(() => loadPerceptionConfig());
  const [log, setLog] = useState<PerceptionLogEntry[]>(() => loadPerceptionLog());
  const [diag, setDiag] = useState(() => readPerceptionDiagnostics());
  const [tab, setTab] = useState<"cap" | "diag">("cap");

  const refresh = useCallback(() => {
    setConfig(loadPerceptionConfig());
    setLog(loadPerceptionLog());
    setDiag(readPerceptionDiagnostics());
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("perception-config-changed", onChange);
    window.addEventListener("perception-log-changed", onChange);
    return () => {
      window.removeEventListener("perception-config-changed", onChange);
      window.removeEventListener("perception-log-changed", onChange);
    };
  }, [refresh]);

  // 诊断是「实时」的：打开诊断页时每秒刷新一次状态读数
  useEffect(() => {
    if (tab !== "diag") return;
    const timer = window.setInterval(() => setDiag(readPerceptionDiagnostics()), 1000);
    return () => window.clearInterval(timer);
  }, [tab]);

  const rows = useMemo(() => buildCapabilityRows(), [config, diag]);
  const quiet = useMemo(() => isQuietHoursActive(), [config, diag]);

  const update = useCallback((patch: Partial<PerceptionConfig>) => {
    const next = { ...loadPerceptionConfig(), ...patch };
    savePerceptionConfig(next);
    setConfig(next);
    // 采样间隔 / 总开关变化会影响定时器，重建一次
    void restartPerception();
  }, []);

  // 阈值表只影响判定，不影响采样定时器，所以不重启引擎（否则每敲一个字
  // 都要清一次定时器重建，纯属浪费）。
  const updateOverrides = useCallback((next: PerceptionConfig["appUsageSignalOverrides"]) => {
    const config = { ...loadPerceptionConfig(), appUsageSignalOverrides: next };
    savePerceptionConfig(config);
    setConfig(config);
  }, []);

  const toggleCapability = useCallback((id: PerceptionCapability, on: boolean) => {
    const current = loadPerceptionConfig();
    update({ capabilities: { ...current.capabilities, [id]: on } });
    // 开启一个原生还不支持的能力时明确说一句，避免用户开了却发现永远没反应
    if (on) {
      const row = buildCapabilityRows().find(item => item.id === id);
      if (row && !row.nativeSupported) {
        onNotice?.(`当前 App 版本还不支持「${row.label}」，开启后也不会产生信号`);
      } else if (row?.missingRequirement) {
        onNotice?.(row.missingRequirement);
      }
      // 步数要单独的运行时权限：在用户明确打开它的这一刻申请，而不是启动时一股脑要，
      // 那时用户不知道权限干什么用，拒绝率很高。
      if (id === "steps" && row?.nativeSupported && !hasStepPermission()) {
        const immediate = requestStepPermission();
        onNotice?.(immediate ? "步数已可用" : "请在系统弹窗里允许「身体活动」权限，允许后步数才会生效");
      }
      // 定位同理：在用户明确打开它的这一刻申请。这里只申请前台权限，
      // 刻意不碰后台定位——采样只发生在 App 活着的时候，没必要多要一档。
      if (id === "location" && row?.nativeSupported && !hasLocationPermission()) {
        const immediate = requestLocationPermission();
        onNotice?.(immediate
          ? "位置已可用"
          : "请在系统弹窗里允许位置权限，允许后位置才会生效");
      } else if (id === "location" && readLocationCapabilities().locationServiceOn === false) {
        // 权限有、开关没开：明确说这一句，否则用户会对着「已开启」的开关
        // 等一个永远不来的信号。
        onNotice?.("定位权限已有，但系统的定位开关没开——在快捷开关里打开即可");
      }
      // 睡眠走 Health Connect：先看装没装，再看授没授权。
      // 两层都要说清楚——「开了没反应」绝大多数卡在这里。
      if (id === "sleep" && row?.nativeSupported) {
        const caps = readHealthCapabilities();
        if (caps.healthAvailable !== true) {
          onNotice?.("这台手机还没装 Health Connect（或需要更新）。装好并同步一次数据，睡眠才读得到");
        } else if (!hasHealthPermission()) {
          const immediate = requestHealthPermission();
          onNotice?.(immediate
            ? "睡眠读取已可用"
            : "请在 Health Connect 里允许「睡眠」读取，允许后睡眠才会生效");
        }
      }
    }
  }, [update, onNotice]);

  const handleClear = useCallback(() => {
    clearPerceptionLog();
    resetPerceptionState();
    refresh();
  }, [refresh]);

  const matchedCount = log.filter(item => !item.skipped).length;
  const skippedCount = log.length - matchedCount;

  return (
    <div className="per-shell">
        <div className="per-hero">
          <div className="per-hero-head">
            <span className="per-hero-title">让角色感知你的手机</span>
            <span className="per-state" data-tone={diag.running ? "on" : ""}>
              <i className="per-dot is-pulse" />
              {diag.running ? "运行中" : "已停止"}
            </span>
          </div>

          {!diag.inShell && (
            <div className="per-note is-warn">
              当前不在小手机 App 内（浏览器/PWA）。感知需要安卓壳的原生能力，这里只能预览界面。
            </div>
          )}
          {diag.inShell && !diag.bridgeAvailable && (
            <div className="per-note is-warn">
              当前 App 版本还没有感知桥，请更新到最新版安卓壳后使用。
            </div>
          )}
          {quiet && (
            <div className="per-note">
              现在处于推送安静时段，感知信号会暂存不投递，时段结束后不会补发。
            </div>
          )}

          <div className="per-metrics">
            <div className="per-metric">
              <div className="per-metric-value">{diag.hourlyUsed}<span style={{ fontSize: "0.6em", opacity: 0.5 }}>/{diag.hourlyLimit}</span></div>
              <div className="per-metric-label">本小时信号</div>
            </div>
            <div className="per-metric">
              <div className="per-metric-value">{matchedCount}</div>
              <div className="per-metric-label">已投递</div>
            </div>
            <div className="per-metric">
              <div className="per-metric-value">{skippedCount}</div>
              <div className="per-metric-label">被拦截</div>
            </div>
          </div>

          <div className="per-note">
            感知数据只保存在这台手机上。只有你在「现实桥」里为它配了规则，它才会写进聊天、记忆或通知。
          </div>
        </div>

        {/* 标签切换 */}
        <div className="menu-group" style={{ margin: "12px var(--ui-padding, 16px) 0" }}>
          <div style={{ display: "flex" }}>
            <button
              type="button"
              className="menu-item"
              style={{ justifyContent: "center", fontWeight: tab === "cap" ? 700 : 400, flex: 1 }}
              onClick={() => setTab("cap")}
            >
              <span className="menu-label" style={{ textAlign: "center", color: tab === "cap" ? "var(--c-text-title)" : "var(--c-text)" }}>能力</span>
            </button>
            <button
              type="button"
              className="menu-item"
              style={{ justifyContent: "center", fontWeight: tab === "diag" ? 700 : 400, flex: 1 }}
              onClick={() => setTab("diag")}
            >
              <span className="menu-label" style={{ textAlign: "center", color: tab === "diag" ? "var(--c-text-title)" : "var(--c-text)" }}>诊断与记录</span>
            </button>
          </div>
        </div>

        <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
          {tab === "cap" ? (
            <>
              {/* 总开关 */}
              <div>
                <div className="settings-menu-section-title">总开关</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-label-group">
                      <span className="menu-label">启用感知</span>
                      <span className="menu-desc">关闭后引擎停止采样，不再产生任何信号</span>
                    </div>
                    <Toggle checked={config.enabled} onChange={(v: boolean) => update({ enabled: v })} />
                  </div>
                </div>
              </div>

              {/* 能力列表 */}
              <div>
                <div className="settings-menu-section-title">感知能力</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  {rows.map(row => {
                    const Icon = CAP_ICONS[row.id];
                    return (
                      <div className="per-cap" key={row.id} data-available={row.available ? "true" : "false"}>
                        <div className="per-cap-icon"><Icon size={17} strokeWidth={1.8} /></div>
                        <div className="per-cap-body">
                          <div className="per-cap-name">{row.label}</div>
                          <div className="per-cap-desc">{row.desc}</div>
                          <div className="per-tags">
                            <span className="per-tag" data-tone={row.userEnabled ? "ok" : "off"}>
                              {row.userEnabled ? "已开启" : "已关闭"}
                            </span>
                            <span className="per-tag" data-tone={row.nativeSupported ? "ok" : "off"}>
                              {row.nativeSupported ? "App 已支持" : "当前版本不支持"}
                            </span>
                            {row.missingRequirement && (
                              <span className="per-tag" data-tone="warn">
                                <AlertCircle size={10} strokeWidth={2.4} /> {row.missingRequirement}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="per-cap-toggle">
                          <Toggle
                            checked={row.userEnabled}
                            onChange={(v: boolean) => toggleCapability(row.id, v)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 阈值 */}
              <div>
                <div className="settings-menu-section-title">上报规则</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">采样间隔</div>
                      <div className="per-field-hint">多久检查一次手机状态，单位秒</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={20}
                      max={600}
                      value={config.sampleSeconds}
                      onChange={e => update({ sampleSeconds: Number(e.target.value) || 60 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">电量变动步长</div>
                      <div className="per-field-hint">电量每掉多少个百分点才提醒一次</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={1}
                      max={50}
                      value={config.batteryStepPercent}
                      onChange={e => update({ batteryStepPercent: Number(e.target.value) || 5 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">应用停留时长</div>
                      <div className="per-field-hint">同一应用连续用满多少分钟才算一次事件</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={2}
                      max={180}
                      value={config.appDwellMinutes}
                      onChange={e => update({ appDwellMinutes: Number(e.target.value) || 20 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">应用累计用太久</div>
                      <div className="per-field-hint">
                        某个应用今天累计用满多少分钟，报一条「应用用太久」（中途切走也照样累加）。
                        0 = 这类信号全关。与上面「应用停留时长」的区别：那个看连续停留，一旦切走就归零
                      </div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={720}
                      value={config.appUsageSignalMinutes}
                      onChange={e => update({ appUsageSignalMinutes: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">每小时上限</div>
                      <div className="per-field-hint">保护你的 API 额度：超过这个数就不再投递</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={1}
                      max={60}
                      value={config.hourlyLimit}
                      onChange={e => update({ hourlyLimit: Number(e.target.value) || 12 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">电量偏低阈值</div>
                      <div className="per-field-hint">电量跌到这个百分比以下，事件名就是「电量偏低」（现实桥按它匹配）</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={1}
                      max={99}
                      value={config.batteryLowPercent}
                      onChange={e => update({ batteryLowPercent: Number(e.target.value) || 20 })}
                    />
                  </div>
                  <div className="per-field" style={{ alignItems: "center" }}>
                    <div className="per-field-body">
                      <div className="per-field-label">遵守安静时段</div>
                      <div className="per-field-hint">复用「离线推送」里设置的安静时段，夜里不打扰</div>
                    </div>
                    <Toggle
                      checked={config.respectQuietHours}
                      onChange={(v: boolean) => update({ respectQuietHours: v })}
                    />
                  </div>

                  <div className="per-field" style={{ alignItems: "flex-start" }}>
                    <div className="per-field-body">
                      <div className="per-field-label">单应用阈值</div>
                      <div className="per-field-hint">
                        给特定应用单独设值，按显示名或包名「包含」匹配（不区分大小写）。
                        没命中的用上面的全局值；填 0 = 这个应用永不报。
                        例如抖音 20、游戏 0（打游戏不打扰）
                      </div>
                      {config.appUsageSignalOverrides.map((rule, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
                          <input
                            className="per-field-input"
                            style={{ flex: 1, minWidth: 0 }}
                            placeholder="应用名，如 抖音"
                            value={rule.pattern}
                            onChange={e => updateOverrides(config.appUsageSignalOverrides.map((r, i) =>
                              i === idx ? { ...r, pattern: e.target.value } : r))}
                          />
                          <input
                            className="per-field-input"
                            style={{ width: 72 }}
                            type="number"
                            min={0}
                            max={720}
                            value={rule.minutes}
                            onChange={e => updateOverrides(config.appUsageSignalOverrides.map((r, i) =>
                              i === idx ? { ...r, minutes: Math.max(0, Number(e.target.value) || 0) } : r))}
                          />
                          <button
                            type="button"
                            className="ui-btn ui-btn-soft-danger"
                            onClick={() => updateOverrides(config.appUsageSignalOverrides.filter((_, i) => i !== idx))}
                          >
                            <Trash2 size={14} strokeWidth={2} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="ui-btn ui-btn-outline"
                        style={{ marginTop: 8 }}
                        onClick={() => updateOverrides([...config.appUsageSignalOverrides, { pattern: "", minutes: 30 }])}
                      >
                        <Plus size={14} strokeWidth={2} /> 添加应用
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                想让它变成真正的互动？去「现实桥」新建规则，匹配类型填上面的事件名
                （如「电量偏低」「充电开始」「长时间使用」「应用用太久」「深夜还醒着」「很久没聊天」「久坐不动」），
                就能让它写进聊天、记忆或通知。
              </div>

              {/* 回到手机 */}
              <div>
                <div className="settings-menu-section-title">回到手机</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="per-field" style={{ alignItems: "center" }}>
                    <div className="per-field-body">
                      <div className="per-field-label">离开后回来说一声</div>
                      <div className="per-field-hint">你离开小手机一段时间再打开时，产生一条「回到手机」信号</div>
                    </div>
                    <Toggle
                      checked={config.returnSignalEnabled}
                      onChange={(v: boolean) => update({ returnSignalEnabled: v })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">离开多久才算</div>
                      <div className="per-field-hint">低于这个时长不算「离开过」，防止切一下别的 App 回来就触发；单位分钟</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={1}
                      max={720}
                      value={config.returnAwayMinutes}
                      onChange={e => update({ returnAwayMinutes: Number(e.target.value) || 5 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">触发间隔</div>
                      <div className="per-field-hint">两次信号之间至少隔多久，防止反复切前后台刷屏；单位分钟，0 = 不限制</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={720}
                      value={config.returnCooldownMinutes}
                      onChange={e => update({ returnCooldownMinutes: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                  这只是产生一个信号，不依赖安卓壳。是否让角色开口、说什么，由「现实桥」里的规则决定。
                </div>
              </div>

              {/* 作息与习惯 */}
              <div>
                <div className="settings-menu-section-title">作息与习惯</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">几点前算深夜</div>
                      <div className="per-field-hint">
                        零点到这个点之间还醒着，产生一条「深夜还醒着」（每天最多一条）；0 = 关。
                        这段时间正好落在推送安静时段里，开着「遵守安静时段」时它会被拦下
                      </div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={12}
                      value={config.lateNightUntilHour}
                      onChange={e => update({ lateNightUntilHour: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">多久没说话算久</div>
                      <div className="per-field-hint">
                        你和角色任一方隔多久没发消息，产生一条「很久没聊天」（每天最多一条）；
                        单位小时，0 = 关
                      </div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={336}
                      value={config.noTalkHours}
                      onChange={e => update({ noTalkHours: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">多久不动算久坐</div>
                      <div className="per-field-hint">
                        步数多久没涨就算「久坐不动」（走两步就重新计时，每段只报一次）；
                        单位分钟，0 = 关。需要步数权限
                      </div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={720}
                      value={config.sitStillMinutes}
                      onChange={e => update({ sitStillMinutes: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                  「今天第一次打开」不用设置：当天第一次进小手机就会产生一条。
                  以上四条都是纯网页实现，不依赖安卓壳，也不需要额外权限。
                </div>
              </div>

              {/* 角色怎么看到 */}
              <div>
                <div className="settings-menu-section-title">角色怎么看到这些</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="per-field" style={{ alignItems: "center" }}>
                    <div className="per-field-body">
                      <div className="per-field-label">聊天时附带当前状态</div>
                      <div className="per-field-hint">每轮对话悄悄告诉角色此刻的电量、网络与在用什么应用。更自然，但每轮会多占一点 token</div>
                    </div>
                    <Toggle
                      checked={config.injectStatus}
                      onChange={(v: boolean) => update({ injectStatus: v })}
                    />
                  </div>
                  <div className="per-field">
                    <div className="per-field-body">
                      <div className="per-field-label">主动查看的间隔</div>
                      <div className="per-field-hint">角色两次「看手机」之间至少隔多久，防止连查；单位分钟，0 = 不限制</div>
                    </div>
                    <input
                      className="per-field-input"
                      type="number"
                      min={0}
                      max={720}
                      value={config.queryCooldownMinutes}
                      onChange={e => update({ queryCooldownMinutes: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                  角色想主动查手机，还要单独开能力：工具箱 → 内置能力 → 「查看手机状态」。
                </div>
              </div>

              {/* 云端同步 */}
              <div>
                <div className="settings-menu-section-title">离线时也能知道</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="per-field" style={{ alignItems: "center" }}>
                    <div className="per-field-body">
                      <div className="per-field-label">同步状态到我的云端</div>
                      <div className="per-field-hint">角色离线生成消息时看不到你的手机，开启后它能看到你离开前的状态</div>
                    </div>
                    <Toggle
                      checked={config.cloudSyncEnabled}
                      onChange={(v: boolean) => update({ cloudSyncEnabled: v })}
                    />
                  </div>
                </div>
                {config.cloudSyncEnabled && (
                  <div className="per-note is-warn" style={{ margin: "8px var(--ui-padding, 16px) 0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                      <Cloud size={13} strokeWidth={2.2} /> 开启前请知悉
                    </div>
                    <div style={{ marginTop: 6, lineHeight: 1.65 }}>
                      只上传一行汇总（电量、网络、正在用的应用名、步数），不上传采样流与完整应用列表；
                      应用只传显示名、不传包名；存进你自己配置的云端，不经第三方；超过 6 小时自动视为过期。
                    </div>
                    <div style={{ marginTop: 6 }}>
                      关闭开关即停止上传；已上传的内容可用下方按钮删掉。
                    </div>
                  </div>
                )}
                <div className="per-actions" style={{ justifyContent: "flex-start" }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    onClick={async () => {
                      const ok = await clearCloudStatus();
                      onNotice?.(ok ? "已清除云端感知数据" : "没有可清除的数据，或云端未配置");
                    }}
                  >
                    <Trash2 size={14} strokeWidth={2} /> 清除云端数据
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* 运行态 */}
              <div>
                <div className="settings-menu-section-title">运行状态</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                      <Activity size={17} strokeWidth={1.8} />
                    </div>
                    <div className="menu-label-group">
                      <span className="menu-label">引擎</span>
                      <span className="menu-desc">
                        {diag.running ? "正在按设定的间隔采样" : "未运行"}
                      </span>
                    </div>
                    <span className="per-state" data-tone={diag.running ? "on" : ""}>
                      <i className="per-dot" />{diag.running ? "运行" : "停止"}
                    </span>
                  </div>
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                      <ShieldCheck size={17} strokeWidth={1.8} />
                    </div>
                    <div className="menu-label-group">
                      <span className="menu-label">原生桥</span>
                      <span className="menu-desc">
                        {diag.bridgeAvailable ? "App 已提供感知桥" : "当前 App 版本未提供，请更新安卓壳"}
                      </span>
                    </div>
                  </div>
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                      <Smartphone size={17} strokeWidth={1.8} />
                    </div>
                    <div className="menu-label-group">
                      <span className="menu-label">无障碍服务</span>
                      <span className="menu-desc">
                        {diag.accessibility ? "已开启（前台应用感知可用）" : "未开启，前台应用感知无法工作"}
                      </span>
                    </div>
                  </div>
                  {diag.unmatchedSignals > 0 && (
                    <div className="menu-item" style={{ cursor: "default" }}>
                      <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-warn, #ff9f0a) 14%, transparent)" }}>
                        <AlertCircle size={17} strokeWidth={1.8} />
                      </div>
                      <div className="menu-label-group">
                        <span className="menu-label">有信号但没有规则</span>
                        <span className="menu-desc">
                          已产生 {diag.unmatchedSignals} 条信号，但没有命中任何现实桥规则，所以只存档了。
                          去「现实桥」建一条规则就能用上。
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 角色视角 */}
              <div>
                <div className="settings-menu-section-title">角色会看到什么</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                    <div className="menu-label-group">
                      <span className="menu-label">按你当前的开关过滤后</span>
                      <span className="menu-desc">这段文字就是角色主动查手机时会读到的内容</span>
                      <div className="per-raw" style={{ margin: "8px 0 0" }}>
                        {describeStatus(filterStatusBySwitches(diag.status, config)) || "（还没有可读信息）"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 应用累计使用：验证「应用用太久」到底跑没跑 */}
              <div>
                <div className="settings-menu-section-title">应用累计使用</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  {diag.appUsage.length === 0 ? (
                    <div className="per-empty">
                      读不到今天的应用使用时长。需要「使用情况访问」权限（系统设置里手动开），
                      并确认「使用统计」能力是打开的。
                    </div>
                  ) : (
                    diag.appUsage.slice(0, 6).map(entry => {
                      const name = (entry.label || entry.package).toLowerCase();
                      const hit = config.appUsageSignalOverrides.find(
                        rule => rule.pattern.trim() && name.includes(rule.pattern.trim().toLowerCase()),
                      );
                      const threshold = hit ? hit.minutes : config.appUsageSignalMinutes;
                      const tier = diag.usageSignalTier[entry.package] ?? 0;
                      return (
                        <div className="menu-item" key={entry.package} style={{ cursor: "default" }}>
                          <div className="menu-label-group">
                            <span className="menu-label">{entry.label || entry.package}</span>
                            <span className="menu-desc">
                              今天 {entry.minutes} 分钟 · {threshold <= 0
                                ? "已排除，不报"
                                : `阈值 ${threshold} 分钟，已报 ${tier} 次`}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 最近取值 */}
              <div>
                <div className="settings-menu-section-title">最近一次取值</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                    <div className="menu-label-group">
                      <span className="menu-label">
                        {diag.lastSampleAt ? fmtTime(diag.lastSampleAt) : "还没采样过"}
                      </span>
                      <span className="menu-desc">原始快照，故障排查用</span>
                      <div className="per-raw" style={{ margin: "8px 0 0" }}>
                        {diag.lastSnapshot || "（空）"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 流水 */}
              <div>
                <div className="settings-menu-section-title">信号记录</div>
                <div className="menu-group" style={{ marginTop: 10, paddingBottom: 4 }}>
                  {log.length === 0 ? (
                    <div className="per-empty">
                      还没有产生过信号。
                      <br />
                      等电量变化、网络切换，或某个应用用满 {config.appDwellMinutes} 分钟，就会出现记录。
                    </div>
                  ) : (
                    <div className="per-log">
                      {log.map(item => (
                        <div className="per-log-item" key={item.id} data-skipped={item.skipped ? "true" : "false"}>
                          <div className="per-log-head">
                            <span className="per-log-type">{item.type}</span>
                            <span className="per-log-time">{fmtTime(item.at)}</span>
                          </div>
                          {item.payload && <div className="per-log-payload">{item.payload}</div>}
                          <div className="per-log-outcome">
                            {item.skipped
                              ? <span className="per-log-skipped">已拦截 · {item.skipped}</span>
                              : item.outcome}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="per-actions">
                  <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}>
                    <RefreshCw size={14} strokeWidth={2} /> 刷新
                  </button>
                  <button type="button" className="ui-btn ui-btn-soft-danger" onClick={handleClear} disabled={log.length === 0}>
                    <Trash2 size={14} strokeWidth={2} /> 清空记录
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
    </div>
  );
}
