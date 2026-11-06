import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getD1DailyUsage } from "@/services/d1-metrics";

/**
 * Dashboard 核心指标 —— D1 每日读写用量（v2.0.7）。
 * 数据由 d1-metrics 服务聚合（GraphQL Analytics API，5 分钟缓存）；
 * 未配置 D1 / 权限不足时返回 ok=false + error 说明，前端优雅降级展示。
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "dashboard:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const usage = await getD1DailyUsage();
  return NextResponse.json({ ok: usage.ok, data: usage });
}
