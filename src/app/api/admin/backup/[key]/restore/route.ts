/**
 * POST /api/admin/backup/[key]/restore — 把一个备份对象导入当前库（按表 PK upsert）。
 * 与手动导入共用 backup-restore.restoreTables 语义。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { getBackupStore } from "@/lib/backup/backup-store";
import { restoreTables, type RestoreReport } from "@/lib/backup/backup-restore";

export async function POST(_request: Request, context: { params: Promise<{ key: string }> }): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const { key: rawKey } = await context.params;
  const key = decodeURIComponent(rawKey || "");
  if (!key) return NextResponse.json({ ok: false, error: "缺少备份文件名" }, { status: 200 });
  if (!key.endsWith(".json")) {
    return NextResponse.json(
      { ok: false, error: "仅支持导入 JSON 格式备份 (.json) — .sql/.db 请在本地工具执行后再用 JSON 导入回灌" },
      { status: 200 },
    );
  }
  const store = await getBackupStore();
  const data = await store.get(key);
  if (!data) return NextResponse.json({ ok: false, error: `备份不存在: ${key}` }, { status: 200 });
  let parsed: { tables?: Record<string, Record<string, unknown>[]> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `备份文件解析失败: ${error instanceof Error ? error.message : String(error)}` },
      { status: 200 },
    );
  }
  const incoming = (parsed?.tables ?? parsed) as Record<string, Record<string, unknown>[]>;
  const db = await getDatabase();
  const report: RestoreReport = await restoreTables(db, incoming);
  return NextResponse.json({ ok: true, data: { key, report } });
}
