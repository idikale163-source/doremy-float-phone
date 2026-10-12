import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type OutboxRow = {
  id: string;
  session_id: string | null;
  trigger_key: string | null;
  raw_text: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

// 官方站点的共享推送额度已停用；但自部署用户用的是自己的 Supabase，
// 没有理由连自己也不能用。此前写死 true，导致自部署站点上回传箱不可读——
// 服务端生成的主动消息写进 push_outbox 后，客户端永远取不走。
const SHARED_PUSH_DISABLED = process.env.NEXT_PUBLIC_SELF_HOSTED_MODE !== "true";

function sharedPushDisabledResponse() {
  return NextResponse.json({ ok: false, error: "本站共享离线推送回传已停用。" }, { status: 503 });
}

// 停用后仍有大量旧版客户端（PWA 缓存的老 bundle）按旧逻辑轮询本接口。
// 响应对所有人相同：让浏览器缓存 1 小时、CDN 缓存 1 天，把这批残余轮询
// 挡在函数外面（重新部署会清 CDN 缓存，未来若恢复共享通道不受影响）。
function cachedSharedPushDisabledResponse() {
  return NextResponse.json(
    { ok: false, error: "本站共享离线推送回传已停用。" },
    {
      status: 503,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
      },
    },
  );
}

export async function GET(request: Request) {
  if (SHARED_PUSH_DISABLED) return cachedSharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const result = await supabaseRestFetch<OutboxRow[]>(
      `push_outbox?user_id=eq.${encodeSupabaseFilter(account.id)}&consumed_at=is.null`
      + "&select=id,session_id,trigger_key,raw_text,meta,created_at&order=created_at.asc&limit=20",
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, entries: result.data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 100).slice(0, 50)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少 ids。" }, { status: 400 });
    }
    const idList = ids.map(id => encodeSupabaseFilter(`"${id.replace(/"/g, "")}"`)).join(",");
    const result = await supabaseRestFetch(
      `push_outbox?user_id=eq.${encodeSupabaseFilter(account.id)}&id=in.(${idList})`,
      { method: "PATCH", body: JSON.stringify({ consumed_at: new Date().toISOString() }) },
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
