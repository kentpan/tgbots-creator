/**
 * GET /api/admin/backup/tables — 可备份表清单（运行时枚举数据库全部业务表 + 行数），
 * 备份页多选导出消费。新增表零维护自动出现在清单中。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { loadTableCatalog } from "@/lib/backup/whitelist";
import { driverOf } from "@/lib/backup/backup-runner";

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  const catalog = await loadTableCatalog(db);
  const tables: { name: string; rows: number }[] = [];
  for (const name of catalog.tables) {
    const counted = await db
      .all<{ c: number }>(`SELECT COUNT(*) as c FROM ${name}`)
      .catch((error: unknown) => {
        console.error(`备份表清单 ${name} 行数统计失败:`, error);
        return [{ c: 0 }];
      });
    tables.push({ name, rows: Number(counted[0]?.c ?? 0) });
  }
  return NextResponse.json({ ok: true, data: { tables, driver: driverOf(db) } });
}
