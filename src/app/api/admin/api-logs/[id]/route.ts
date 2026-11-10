import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { getApiLogDetail } from "@/lib/api-log";

/**
 * 单条 API 日志详情（v2.2.6）：GET /api/admin/api-logs/[id]
 * v2.2.6 D1 限额优化配套端点 —— 列表不再返回 request_payload/response_body
 * 大字段，详情弹窗打开时按需读取单行（1 行读取配额）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ ok: false, error: "无效的日志 ID" }, { status: 400 });
  }
  const row = await getApiLogDetail(numericId);
  if (!row) {
    return NextResponse.json({ ok: false, error: "日志不存在或已被清理" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, log: row });
}
