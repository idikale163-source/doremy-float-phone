// lib/shell-detect.ts
//
// 「是否运行在安卓壳（FloatShell App）的 WebView 里」——单独成模块，
// 避免循环依赖：push-client 已经依赖 personal-push-cloud，若后者反过来
// 从 push-client 取这个判断就会形成环（实际表现为运行时
// ReferenceError: isShellEnvironment is not defined）。

export function isShellEnvironment(): boolean {
    return typeof navigator !== "undefined" && navigator.userAgent.includes("FloatShell/");
}

/**
 * 现实桥该走哪一套。
 *
 * 为什么需要这个判断——现实桥底下是**两套完全不同的东西**：
 *   · 安卓本机桥：壳直接读手机状态、直接做事，不经云端、数据不出设备；
 *   · iPhone 快捷指令路线：靠快捷指令上传/下载，必须配 Supabase。
 * 两者的配置步骤、要装的东西、要给的权限没有一处相同，
 * 混在一个入口里讲，用户只会照着不属于自己手机的那套白忙一场。
 *
 * 判定的不是「你在用什么浏览器」，而是「你这台设备上，哪套真的能用」——
 * 用它来决定默认落在哪个分区、导航里出现哪一组、以及哪一屏该提醒不适用。
 */
export type BridgePlatformKind = "android-shell" | "android-browser" | "ios" | "desktop";

export type BridgePlatformInfo = {
    kind: BridgePlatformKind;
    /** 这台设备上「你的那套」；null = 都不是（电脑浏览器） */
    home: "android" | "ios" | null;
    /** 给人看的设备名 */
    label: string;
    /** 安卓本机桥：ready 现在就能用 / after-install 装壳后可用 / not-applicable 用不了 */
    androidBridge: "ready" | "after-install" | "not-applicable";
    /** iPhone 快捷指令路线：ready 可用 / not-applicable 用不了 */
    iosBridge: "ready" | "not-applicable";
};

export function describeBridgePlatform(): BridgePlatformInfo {
    if (typeof navigator === "undefined") {
        return {
            kind: "desktop", home: null, label: "未知设备",
            androidBridge: "not-applicable", iosBridge: "not-applicable",
        };
    }
    if (isShellEnvironment()) {
        return {
            kind: "android-shell", home: "android", label: "安卓 · 小手机 App",
            androidBridge: "ready", iosBridge: "not-applicable",
        };
    }
    const ua = navigator.userAgent;
    // iPadOS 13+ 桌面模式 UA 伪装成 Mac，但 Mac 没有多点触控
    const isIOS = /iPhone|iPad|iPod/i.test(ua)
        || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
    if (isIOS) {
        return {
            kind: "ios", home: "ios", label: "iPhone / iPad",
            androidBridge: "not-applicable", iosBridge: "ready",
        };
    }
    if (/Android/i.test(ua)) {
        return {
            kind: "android-browser", home: "android", label: "安卓 · 浏览器",
            androidBridge: "after-install", iosBridge: "not-applicable",
        };
    }
    return {
        kind: "desktop", home: null, label: "电脑浏览器",
        androidBridge: "not-applicable", iosBridge: "not-applicable",
    };
}
