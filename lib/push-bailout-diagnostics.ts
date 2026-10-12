// lib/push-bailout-diagnostics.ts
//
// 离线预约诊断：把「为什么没挂上服务端任务」直接问出来。
//
// 背景：refreshScheduledBailouts() 会遍历定时唤醒 / 冷场重连 / 经期关怀逐个挂单，
// 但 arm* 函数返回的失败原因（BailoutArmResult.reason）在那一层被 void 丢掉了，
// 于是「push_jobs 里一条新记录都没有」这种症状无法定位——到底是没走到、
// 被安静时段拦了、找不到会话、还是 POST 被服务端拒了，全都看不见。
//
// 这里逐个重跑一遍并把每一步的结论摊开，供界面上的「诊断」按钮直接显示。
// 副作用与正常刷新一致（成功即幂等覆盖同一 triggerKey 的预约），只多出诊断文本。

import { loadIdleReconnectRules } from "./idle-reconnect-storage";
import {
    armIdleReconnectBailout,
    armPeriodCareBailouts,
    armTimedWakeBailout,
} from "./push-bailout-client";
import { hasAccountPushSubscription, isShellEnvironment, loadPushQuietHours } from "./push-client";
import { isPersonalPushCloudActive } from "./personal-push-cloud";
import { loadTimedWakeSchedules } from "./timed-wake-storage";

function stamp(): string {
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}

/**
 * 逐项重跑离线预约并汇总结果。返回可直接显示的纯文本。
 * 任何一步失败都会带上 arm* 给出的具体原因，而不是笼统的「未成功」。
 */
export async function diagnoseScheduledBailouts(): Promise<string> {
    const lines: string[] = [];
    lines.push(`[${stamp()}] 离线预约诊断`);
    lines.push(`环境：${isShellEnvironment() ? "安卓壳（走站点任务接口）" : "浏览器"}`);
    lines.push(`个人云：${isPersonalPushCloudActive() ? "已激活" : "未激活"}`);
    lines.push(`安静时段设置：${loadPushQuietHours() || "（未设置）"}`);

    let subscribed = false;
    try {
        subscribed = await hasAccountPushSubscription();
    } catch (error) {
        lines.push(`订阅门控：查询抛错 ${error instanceof Error ? error.message : String(error)}`);
    }
    lines.push(`订阅门控：${subscribed ? "通过" : "未通过（后两项会因此直接跳过）"}`);

    // ── 定时唤醒（「稍后主动联系」） ──
    const schedules = loadTimedWakeSchedules();
    lines.push("");
    lines.push(`定时唤醒排期：${schedules.length} 条`);
    for (const schedule of schedules) {
        try {
            const result = await armTimedWakeBailout(schedule);
            lines.push(result.ok
                ? ` ✓ ${schedule.id} 已挂上服务端预约`
                : ` ✗ ${schedule.id} 未挂上：${result.reason}`);
        } catch (error) {
            lines.push(` ✗ ${schedule.id} 抛出异常：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // ── 冷场重连（「长时间没消息时」） ──
    const rules = loadIdleReconnectRules();
    lines.push("");
    lines.push(`冷场重连规则：${rules.length} 条`);
    for (const rule of rules) {
        try {
            const result = await armIdleReconnectBailout(rule);
            lines.push(result.ok
                ? ` ✓ ${rule.id} 已挂上服务端预约`
                : ` ✗ ${rule.id} 未挂上：${result.reason}`);
        } catch (error) {
            lines.push(` ✗ ${rule.id} 抛出异常：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // ── 经期关怀（静默，无逐条返回） ──
    lines.push("");
    try {
        await armPeriodCareBailouts();
        lines.push("经期关怀：已尝试（无输出即未启用或无匹配角色）");
    } catch (error) {
        lines.push(`经期关怀：抛出异常 ${error instanceof Error ? error.message : String(error)}`);
    }

    lines.push("");
    lines.push("若这里显示「已挂上」但 push_jobs 仍无新记录，说明问题在服务端落库或扫描。");
    return lines.join("\n");
}
