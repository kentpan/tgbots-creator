/**
 * POST /api/admin/backup/import-file — 本地备份文件导入（v2.2.4，两段式）。
 *
 * multipart/form-data:
 *   file   : 备份文件（.sql / .db / .json，≤50MB）
 *   mode   : analyze（解析 → 表清单/行数/本地存在性/运行环境支持判定）
 *          | apply（按 tables 选中表整表覆盖导入 → 逐表报告）
 *   tables : apply 模式必填，逗号分隔表名
 *
 * 运行环境判定：Node SQLite 三种格式全支持；Cloudflare D1 下 .db 判不支持（如实提示改用 .sql/.json）。
 * 权限：settings:manage（与备份回灌一致）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import {
  analyzeImportFile,
  applyImportFile,
  IMPORT_FILE_MAX_BYTES,
} from "@/lib/backup/import-file";

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "请求必须是 multipart/form-data" }, { status: 200 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "缺少上传文件（file 字段）" }, { status: 200 });
  }
  if (file.size > IMPORT_FILE_MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 50 MB` },
      { status: 200 },
    );
  }
  const mode = String(form.get("mode") || "analyze");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const db = await getDatabase();

  if (mode === "analyze") {
    try {
      const analysis = await analyzeImportFile(db, file.name, bytes);
      return NextResponse.json({ ok: true, data: { analysis } });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "文件解析失败" },
        { status: 200 },
      );
    }
  }

  if (mode === "apply") {
    const tablesParam = String(form.get("tables") || "").trim();
    const selected = tablesParam
      ? tablesParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (!selected.length) {
      return NextResponse.json({ ok: false, error: "未选择任何要导入的表" }, { status: 200 });
    }
    try {
      const report = await applyImportFile(db, file.name, bytes, selected);
      return NextResponse.json({ ok: true, data: { report } });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "导入失败" },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({ ok: false, error: `未知 mode: ${mode}` }, { status: 200 });
}
