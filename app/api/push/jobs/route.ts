import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { encryptPushJobPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

const MAX_PAYLOAD_BYTES = 900_000;
const ALLOWED_KINDS = new Set(["followup", "reply_bailout", "timed_task", "shortcut_resume"]);
// 官方站点的共享推送额度已停用；但自部署用户用的是自己的 Supabase，
// 没有理由连自己也不能用。此前写死 true，导致自部署站点上「创建离线任务」
// 必然返回 503、任务永远进不了 push_jobs，主动消息功能整体失效。
const SHARED_PUSH_DISABLED = process.env.NEXT_PUBLIC_SELF_HOSTED_MODE !== "true";

function sharedPushDisabledResponse() {
  return NextResponse.json({ ok: false, error: "本站共享离线推送已停用，请部署个人 Supabase。" }, { status: 503 });
}

export async function POST(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    const supabase = getSupabaseServerConfig();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    const kind = cleanAccountText(body.kind, 40);
    const executeAtRaw = cleanAccountText(body.executeAt, 60);
    const executeAt = executeAtRaw ? new Date(executeAtRaw) : null;
    if (!triggerKey || !kind || !ALLOWED_KINDS.has(kind) || !executeAt || Number.isNaN(executeAt.getTime())) {
      return NextResponse.json({ ok: false, error: "预约参数不完整。" }, { status: 400 });
    }
    if (!body.payload || typeof body.payload !== "object") {
      return NextResponse.json({ ok: false, error: "缺少 payload。" }, { status: 400 });
    }
    const plainJson = JSON.stringify(body.payload);
    if (plainJson.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: "快照过大，已跳过兜底预约。" }, { status: 413 });
    }

    // 同一个触发键重挂即覆盖：先删后插，保持幂等。
    const filter = `user_id=eq.${encodeSupabaseFilter(account.id)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`;
    await supabaseRestFetch(`push_jobs?${filter}`, { method: "DELETE" });

    const insert = await supabaseRestFetch("push_jobs", {
      method: "POST",
      body: JSON.stringify([{
        id: `job_${crypto.randomUUID()}`,
        user_id: account.id,
        trigger_key: triggerKey,
        kind,
        execute_at: executeAt.toISOString(),
        status: "pending",
        payload: encryptPushJobPayload(plainJson, await getOrCreatePushPayloadKey()),
      }]),
    });
    if (!insert.ok) {
      return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

/**
 * 列出本账号名下还在排队/执行中的预约。
 *
 * 给「排期管理」面板用：用户想看到「哪些角色排了什么」并逐条删，
 * 而不是只有一个看不见内部的「全清」按钮。
 *
 * 只回 trigger_key / kind / execute_at / status：payload 是加密的，服务端
 * 也没打算在这里解密；trigger_key 已足够反解回角色与用途。
 */
export async function GET(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const result = await supabaseRestFetch<Array<{ trigger_key: string; kind: string; execute_at: string; status: string }>>(
      `push_jobs?user_id=eq.${encodeSupabaseFilter(account.id)}&status=in.(pending,running)`
      + "&select=trigger_key,kind,execute_at,status&order=execute_at.asc&limit=200",
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true, jobs: result.data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

/** 心跳续约：把 pending 预约的接管时刻推迟到 now+90s。本地生成期间每 30s 一跳。 */
export async function PATCH(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    if (!triggerKey) {
      return NextResponse.json({ ok: false, error: "缺少 triggerKey。" }, { status: 400 });
    }
    const runNow = body.runNow === true;
    const filter = `user_id=eq.${encodeSupabaseFilter(account.id)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}&status=eq.pending`;
    const result = await supabaseRestFetch(`push_jobs?${filter}`, {
      method: "PATCH",
      body: JSON.stringify({
        execute_at: new Date(Date.now() + (runNow ? 0 : 90_000)).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    const triggerPrefix = cleanAccountText(body.triggerPrefix, 200);
    // 前缀清理时可保留一个刚挂上的新键（先挂后清，防止清理和重挂之间被杀导致预约丢失）
    const excludeKey = cleanAccountText(body.excludeKey, 200);
    // all=true：清空本账号名下全部离线预约。存量任务散落在多种前缀下
    //（followup: / reply: / idle: / timedwake: / periodcare: / shortcut:），
    // 逐条列举既容易漏、又会随功能增加而过时，所以留一个明确的“全清”开关。
    const purgeAll = body.all === true;
    if (!purgeAll && !triggerKey && !triggerPrefix) {
      return NextResponse.json({ ok: false, error: "缺少 triggerKey 或 triggerPrefix。" }, { status: 400 });
    }
    const keyFilter = purgeAll
      ? ""
      : (triggerKey
        ? `trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`
        : `trigger_key=like.${encodeSupabaseFilter(`${triggerPrefix}%`)}`
          + (excludeKey ? `&trigger_key=neq.${encodeSupabaseFilter(excludeKey)}` : ""));
    const userFilter = `user_id=eq.${encodeSupabaseFilter(account.id)}`;
    // 全清时没有键过滤条件：拼成 `&` 再填空串会得到「&&」，PostgREST 虽能容忍，
    // 但没必要把这种可疑写法留在请求里。
    const keyFilterPart = keyFilter ? `&${keyFilter}` : "";

    // 已领取（running）的任务不能靠删除停手：那些已经跑进 push-generate 的执行体
    // 持有自己的一份快照，把它从表里删掉并不会中断它，它跑完还会照常续排下一发。
    // 用户看到的就是「规则删掉了，消息还在发，而且没完没了」。
    // 改为把它标记成 cancelled——执行体在生成前与续排前各查一次，被撤就停手。
    const cancelRunning = await supabaseRestFetch(
      `push_jobs?${userFilter}${keyFilterPart}&status=eq.running`,
      { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }) },
    );
    if (!cancelRunning.ok) {
      return NextResponse.json({ ok: false, error: cancelRunning.error }, { status: 500 });
    }

    const result = await supabaseRestFetch(
      `push_jobs?${userFilter}${keyFilterPart}&status=eq.pending`,
      { method: "DELETE" },
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
