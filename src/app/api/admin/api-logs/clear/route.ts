import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { clearApiLogs } from "@/lib/api-log";

/**
 * 清空 API 日志（v2.2.5）：POST /api/admin/api-logs/clear
 * 权限：settings:manage（破坏性维护操作，浏览权限不可执行）。
 */
export async function POST(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要系统设置管理权限）" }, { status: 403 });
  }
  const removed = await clearApiLogs();
  await logOperation(admin, {
    action: "清空 API 日志",
    detail: `${removed} 条`,
    headers: await headers(),
  });
  return NextResponse.json({ ok: true, removed });
}
