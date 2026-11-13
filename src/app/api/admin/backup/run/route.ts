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
  let db;
  try {
    db = await getDatabase();
  } catch (e) {
    console.error("[backup/run] getDatabase 失败:", e);
    return NextResponse.json({ ok: false, error: "数据库不可用: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
  let store;
  try {
    store = await getBackupStore();
  } catch (e) {
    console.error("[backup/run] getBackupStore 失败:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const cfg = parseBackupConfig(await loadBackupSettings(db));
  let result;
  try {
    result = await runBackup(db, store, cfg.tables);
  } catch (e) {
    console.error("[backup/run] runBackup 失败:", e);
    return NextResponse.json({ ok: false, error: "备份执行失败: " + (e instanceof Error ? e.message : String(e)) }, { status: 502 });
  }
  await markBackupRan(db);
  return NextResponse.json({
    ok: true,
    data: {
      backup: result,
      message: `备份完成: ${result.key} (${result.tables.length} 表 / ${result.rows} 行 → ${result.storage})`,
    },
  });
}
