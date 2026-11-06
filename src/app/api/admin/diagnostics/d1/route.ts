import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getD1Usage } from "@/database/d1-metrics";
import { getReadCacheStats, clearAggregateCache, invalidateAllReadCache } from "@/database/read-cache";
import { getDatabaseInfo } from "@/database/client";
import { recalculateJoinRequestCounters } from "@/database/stats-counters";

/**
 * D1 读取额度诊断（v2.2.0）
 *
 * GET  /api/admin/diagnostics/d1        当前 isolate 的当日读写用量 + 按 SQL 归因
 * POST { action: "recalculate-stats" }  按当前数据全量重算加群申请计数器
 * POST { action: "clear-cache" }        清空进程内读缓存（排障用）
 *
 * 注意：计量是 **isolate 维度** 的（workerd 无常驻进程），看到的是当前实例
 * 处理过的流量；绝对值仅供参考，**归因排行**才是排障重点。
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "dashboard:view") && !hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const [dbInfo, usage] = await Promise.all([getDatabaseInfo(), Promise.resolve(getD1Usage())]);
  return NextResponse.json({
    ok: true,
    data: {
      database: dbInfo,
      usage,
      cache: getReadCacheStats(),
    },
  });
}

interface PostPayload {
  action?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: PostPayload = {};
  try {
    payload = (await request.json()) as PostPayload;
  } catch {
    payload = {};
  }

  if (payload.action === "recalculate-stats") {
    const counters = await recalculateJoinRequestCounters();
    clearAggregateCache();
    return NextResponse.json({ ok: true, data: counters });
  }

  if (payload.action === "clear-cache") {
    invalidateAllReadCache();
    clearAggregateCache();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
}
