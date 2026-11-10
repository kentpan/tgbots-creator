/**
 * GET /api/admin/backup/[key]/download — 下载一个备份对象（原始字节流）。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBackupStore } from "@/lib/backup/backup-store";

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }): Promise<Response> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const { key: rawKey } = await context.params;
  const key = decodeURIComponent(rawKey || "");
  if (!key) return NextResponse.json({ ok: false, error: "缺少备份文件名" }, { status: 200 });
  const store = await getBackupStore();
  const data = await store.get(key);
  if (!data) return NextResponse.json({ ok: false, error: `备份不存在: ${key}` }, { status: 200 });
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": key.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
      "content-disposition": `attachment; filename="${key}"`,
      "content-length": String(data.byteLength),
    },
  });
}
