/**
 * DELETE /api/admin/backup/[key] — 删除一个备份对象。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBackupStore } from "@/lib/backup/backup-store";

export async function DELETE(_request: Request, context: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const { key: rawKey } = await context.params;
  const key = decodeURIComponent(rawKey || "");
  if (!key) return NextResponse.json({ ok: false, error: "缺少备份文件名" }, { status: 200 });
  const store = await getBackupStore();
  const existed = (await store.list()).some((o) => o.key === key);
  if (!existed) return NextResponse.json({ ok: false, error: `备份不存在: ${key}` }, { status: 200 });
  await store.delete(key);
  return NextResponse.json({ ok: true, data: { key } });
}
