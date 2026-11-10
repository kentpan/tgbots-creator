import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { getApiLogStats } from "@/lib/api-log";

/** API 日志统计（v2.2.5）：GET /api/admin/api-logs/stats —— 数据看板 + 图表数据 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const stats = await getApiLogStats();
  return NextResponse.json({ ok: true, stats });
}
