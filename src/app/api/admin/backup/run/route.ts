/**
 * POST /api/admin/backup/run — 手动执行一次定时备份链路（管理员触发，与定时回调同一实现）。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { loadBackupSettings, parseBackupConfig, runBackup, markBackupRan } from "@/lib/backup/backup-runner";
import { getBackupStore } from "@/lib/backup/backup-store";

export async function POST(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  const store = await getBackupStore();
  const cfg = parseBackupConfig(await loadBackupSettings(db));
  const result = await runBackup(db, store, cfg.tables);
  await markBackupRan(db);
  return NextResponse.json({
    ok: true,
    data: {
      backup: result,
      message: `备份完成: ${result.key} (${result.tables.length} 表 / ${result.rows} 行 → ${result.storage})`,
    },
  });
}
