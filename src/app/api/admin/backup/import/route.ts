/**
 * POST /api/admin/backup/import — 导入 JSON 备份（按表 PK upsert 回灌）。
 *
 * Body shape: { tables: { tableName: rows[] } }
 * 对每行: PK 在行中 → 已存在则 UPDATE, 否则 INSERT (复合主键表 INSERT OR REPLACE)。
 * 与备份列表「导入」共用 backup-restore.restoreTables 语义。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { restoreTables, type RestoreReport } from "@/lib/backup/backup-restore";

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 200 });
  }
  const incoming = (body.tables ?? body) as Record<string, Record<string, unknown>[]>;
  const report: RestoreReport = await restoreTables(db, incoming);
  return NextResponse.json({ ok: true, data: { report } });
}
