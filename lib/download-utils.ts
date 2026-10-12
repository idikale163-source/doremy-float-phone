export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

/** android-shell 壳的 WebView UA 后缀标识（见 MainActivity.kt 的 userAgentString 拼接）。 */
const FLOAT_SHELL_UA_MARK = "FloatShell/";

/** 壳暴露的原生桥（能力按需特性检测，非壳环境为 undefined）。 */
type FloatShellBridge = {
    saveBase64File?: (fileName: string, base64: string) => boolean;
    openUrl?: (url: string) => boolean;
    launchExternalApp?: (packageName: string, dataUrl: string) => boolean;
    /** 直链交给系统下载管理器（真后台）；返回是否成功入队 */
    downloadUrl?: (url: string, fileName: string) => boolean;
};

function readFloatShellBridge(): FloatShellBridge | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null;
    if (!navigator.userAgent.includes(FLOAT_SHELL_UA_MARK)) return null;
    return (window as unknown as { AndroidShell?: FloatShellBridge }).AndroidShell ?? null;
}

/** 是否运行在 android-shell 壳内（普通浏览器/iOS 均为 false）。 */
export function isFloatShell(): boolean {
    return readFloatShellBridge() !== null;
}

/**
 * 用壳的桥能力打开外部 App / URL（桌宠联动）。
 * 优先按自定义 scheme 走 ACTION_VIEW（对方声明了 intent-filter 即可，不要求正在运行），
 * 失败时退回按包名唤起。非壳环境返回 false，调用方自行兜底。
 */
export function openInFloatShell(url: string, packageName?: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge) return false;
    const direct = bridge.openUrl;
    if (direct) {
        try {
            if (direct(url)) return true;
        } catch {
            // 落到包名唤起
        }
    }
    if (packageName && bridge.launchExternalApp) {
        try {
            return bridge.launchExternalApp(packageName, url);
        } catch {
            return false;
        }
    }
    return false;
}

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        const canNativeShare = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function"
            && navigator.canShare({ files: [file] });
        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // Any other failure (webview without real file-share support, lost user
                // activation, etc.) is surfaced to the caller on iOS instead of opening
                // the blob URL, which can navigate away from the app.
            }
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        throw new Error("当前浏览器没有成功打开系统分享，请在 Safari 中重试，或导出轻量备份后再试。");
    }

    // 壳环境：blob: + a[download] 在 WebView 里不会落盘（DownloadManager 取不到内存地址），
    // 必须把内容 base64 交给壳从 MediaStore 写进公共「下载」目录。落盘失败再退回浏览器做法。
    const shell = readFloatShellBridge();
    if (shell?.saveBase64File) {
        try {
            const base64 = await blobToBase64(blob);
            if (shell.saveBase64File(filename, base64)) {
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            }
        } catch {
            // 交给下面的浏览器兜底路径
        }
    }

    anchorDownload();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Blob → 纯 base64（去掉 data URL 前缀），供壳的 saveBase64File 使用。 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取文件内容失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 把 http(s) 直链交给壳的系统下载管理器（DownloadManager）：系统托管，
 * 切后台、锁屏、退出 App 都会继续下载，完成后通知栏提示。
 * 非壳环境、非直链、或入队失败时返回 false，由调用方走原有兜底路径。
 */
export function downloadUrlInFloatShell(url: string, filename: string): boolean {
    const bridge = readFloatShellBridge();
    if (!bridge?.downloadUrl) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        return bridge.downloadUrl(url, filename);
    } catch {
        return false;
    }
}

/** 把站内相对地址补成绝对地址（壳的原生下载器拿不到页面 base，必须给完整 URL）。 */
function toAbsoluteUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
        return new URL(url, window.location.href).href;
    } catch {
        return url;
    }
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    // 直链优先走壳的原生下载：页面里的 fetch→blob 一旦进后台就被暂停，
    // 交给系统下载器才能真正「离开界面继续下」。
    if (downloadUrlInFloatShell(toAbsoluteUrl(url), filename)) return;

    let blob: Blob | null = null;

    try {
        const res = await fetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (!blob && /^https?:\/\//.test(url)) {
        try {
            const res = await fetch("/api/tool-proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, method: "GET" }),
            });
            if (res.ok) blob = await res.blob();
        } catch { /* proxy also failed */ }
    }

    if (blob) {
        await downloadFile(blob, filename);
    } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}
