"use client";

// 安卓壳推送订阅的兜底注册。
//
// 壳自身会在 PushService 里注册 shell:<账号 id> 的合成订阅，但那段代码把异常
// 全部吞掉，失败时没有任何痕迹——实测中会出现「通知栏显示已连接、订阅表却是
// 空的」，随后所有离线推送都因查不到接收方而发不出去。
//
// 网页侧在这里再注册一次：能拿到账号 id、能看到返回码，幂等且可自愈。壳原生
// 那次成功时这里只是一次覆盖写，无副作用。

import { useEffect } from "react";

import { ensureShellSubscription, isShellEnvironment } from "@/lib/push-client";
import { startNotificationReplyBridge } from "@/lib/notification-reply";
import { startUserShotBridge, syncScreenshotShareTargets } from "@/lib/screenshot";

export function ShellPushRegistrar() {
  useEffect(() => {
    if (!isShellEnvironment()) return;
    void ensureShellSubscription();
  }, []);

  // 通知栏「直接回复」的接收端。挂在这里是因为它和推送订阅同源：
  // 两者都只在安卓壳里生效，也都需要「页面一挂载就开始工作」。
  useEffect(() => startNotificationReplyBridge(), []);

  // 「截屏悬浮球」的接收端。同样必须常驻——用户点球时多半在别的 App 里，
  // 挂在设置页会漏掉绝大多数点击。
  useEffect(() => startUserShotBridge(), []);

  // 分享目标清单：点球那一刻网页可能已被系统回收，浮层没法回网页取，
  // 所以清单必须提前推给原生存着。三处触发：挂载时、配置变更时、
  // 页面回到前台时（角色可能在设置里被增删过）。
  useEffect(() => {
    if (!isShellEnvironment()) return;
    syncScreenshotShareTargets();
    const onConfig = () => syncScreenshotShareTargets();
    const onVisible = () => {
      if (document.visibilityState === "visible") syncScreenshotShareTargets();
    };
    window.addEventListener("screenshot-config-changed", onConfig);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("screenshot-config-changed", onConfig);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
