/**
 * GET /api/admin/backup/tables — 可备份表清单（白名单 + 行数），备份页多选导出消费。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { DATA_TABLE_WHITELIST } from "@/lib/backup/whitelist";
import { driverOf } from "@/lib/backup/backup-runner";

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  const tables: { name: string; rows: number }[] = [];
  for (const name of DATA_TABLE_WHITELIST) {
    let rows = 0;
    try {
      const r = await db.all<{ c: number }>(`SELECT COUNT(*) as c FROM ${name}`);
      rows = Number(r[0]?.c || 0);
    } catch {
      rows = 0;
    }
    tables.push({ name, rows });
  }
  return NextResponse.json({ ok: true, data: { tables, driver: driverOf(db) } });
}
