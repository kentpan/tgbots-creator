import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getAiUsageStats } from "@/services/ai-config";

/** AI 调用统计（chart.js 数据源）：近 N 天汇总 + 按日/模型/提供方/场景聚合 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? "7");
  const stats = await getAiUsageStats(Number.isFinite(days) ? days : 7);
  return NextResponse.json({ ok: true, data: stats });
}
