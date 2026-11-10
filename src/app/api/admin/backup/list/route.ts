/**
 * GET /api/admin/backup/list — 备份列表（R2/S3 或本地快照目录）。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBackupStore } from "@/lib/backup/backup-store";

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const store = await getBackupStore();
  const items = await store.list();
  return NextResponse.json({ ok: true, data: { driver: store.driver, storage: store.label, items } });
}
