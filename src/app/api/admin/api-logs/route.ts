import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { listApiLogs } from "@/lib/api-log";

/**
 * API 日志列表（v2.2.5）：GET /api/admin/api-logs
 * 查询参数：category（webhook/tgapi/deploy/bot-api）、ok（success/fail）、q（模糊搜索）、page、pageSize
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const okParam = url.searchParams.get("ok");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get("pageSize") ?? "20") || 20));
  const { rows, total } = await listApiLogs({
    category: url.searchParams.get("category") ?? undefined,
    ok: okParam === "success" || okParam === "fail" ? okParam : "all",
    q: url.searchParams.get("q") ?? undefined,
    page,
    pageSize,
  });
  return NextResponse.json({ ok: true, logs: rows, total, page, pageSize });
}
