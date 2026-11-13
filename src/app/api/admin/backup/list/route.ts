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
  let store;
  try {
    store = await getBackupStore();
  } catch (e) {
    console.error("[backup/list] getBackupStore 失败:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  let items;
  try {
    items = await store.list();
  } catch (e) {
    console.error("[backup/list] store.list 失败:", e);
    return NextResponse.json({ ok: false, error: "备份列表读取失败: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
  return NextResponse.json({ ok: true, data: { driver: store.driver, storage: store.label, items } });
}
