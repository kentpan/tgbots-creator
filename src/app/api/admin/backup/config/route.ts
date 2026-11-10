/**
 * GET  /api/admin/backup/config — 定时备份配置读取（含存储模式/下次到点/回调令牌）。
 * PUT  /api/admin/backup/config — 定时备份配置更新（app_settings.backup_*）。
 * Body: { enabled, interval_days, hour, minute, second, tables, generate_cron_token? }
 * generate_cron_token=true 时生成新的回调令牌（供 Cloudflare Cron / 外部定时器回调）。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase, type SqlDatabase } from "@/database/client";
import { isWhitelistedTable } from "@/lib/backup/whitelist";
import { parseBackupConfig, loadBackupSettings } from "@/lib/backup/backup-runner";
import { getBackupStore, getStorageSettings } from "@/lib/backup/backup-store";

const BACKUP_SETTING_KEYS = [
  "backup_enabled",
  "backup_interval_days",
  "backup_hour",
  "backup_minute",
  "backup_second",
  "backup_tables",
  "backup_cron_token",
] as const;

async function readAppSettings(db: SqlDatabase, keys: readonly string[]): Promise<Record<string, string>> {
  const placeholders = keys.map(() => "?").join(",");
  const rows = await db.all<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN (${placeholders})`,
    [...keys],
  );
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

async function upsertAppSetting(db: SqlDatabase, key: string, value: string): Promise<void> {
  const updated = await db
    .run(`UPDATE app_settings SET value = ?, updated_time = CURRENT_TIMESTAMP WHERE key = ?`, [value, key])
    .catch(() => null);
  if (!updated || updated.changes === 0) {
    await db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
  }
}

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  const cfg = parseBackupConfig(await loadBackupSettings(db));

  // 存储模式探测（不抛错 — 未配置时如实展示缺什么）；附带 R2/S3 配置态与 CDN 域名
  let storage = "";
  let storageError = "";
  const storageSettings = { driver: "r2", configured: false, missing: "", cdn_base_url: "" };
  try {
    const st = await getStorageSettings(db);
    storageSettings.driver = st.driver;
    storageSettings.configured = !!st.s3Config;
    storageSettings.missing = st.missing;
    storageSettings.cdn_base_url = st.cdnBaseUrl;
  } catch {
    // 设置读取失败如实留空
  }
  try {
    const store = await getBackupStore();
    storage = store.label;
  } catch (error) {
    storageError = error instanceof Error ? error.message : String(error);
  }

  // 下次到点（服务器时区）
  let nextDue = "";
  if (cfg.enabled) {
    const now = new Date();
    const target = new Date(now);
    target.setHours(cfg.hour, cfg.minute, cfg.second, 0);
    let due = target;
    if (now.getTime() < target.getTime() || (cfg.last_run_at && new Date(cfg.last_run_at).getTime() >= target.getTime())) {
      // 今天时刻未到或已跑过 → 下一个周期
      due = new Date(target.getTime() + cfg.interval_days * 86_400_000);
    }
    nextDue = due.toISOString();
  }

  return NextResponse.json({
    ok: true,
    data: { config: cfg, storage, storage_error: storageError, next_due: nextDue, storage_settings: storageSettings },
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 200 });
  }

  const db = await getDatabase();
  const clamp = (v: unknown, def: number, min: number, max: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
  };
  const updates: Array<[string, string]> = [];
  if (body.enabled !== undefined) updates.push(["backup_enabled", body.enabled ? "true" : "false"]);
  if (body.interval_days !== undefined) updates.push(["backup_interval_days", String(clamp(body.interval_days, 1, 1, 3650))]);
  if (body.hour !== undefined) updates.push(["backup_hour", String(clamp(body.hour, 4, 0, 23))]);
  if (body.minute !== undefined) updates.push(["backup_minute", String(clamp(body.minute, 38, 0, 59))]);
  if (body.second !== undefined) updates.push(["backup_second", String(clamp(body.second, 0, 0, 59))]);
  if (body.tables !== undefined) {
    const t = String(body.tables).trim() || "all";
    if (t !== "all") {
      const names = t.split(",").map((s) => s.trim()).filter(Boolean);
      for (const n of names) {
        if (!isWhitelistedTable(n)) return NextResponse.json({ ok: false, error: `表不在白名单内: ${n}` }, { status: 200 });
      }
      if (!names.length) return NextResponse.json({ ok: false, error: "表范围不能为空" }, { status: 200 });
    }
    updates.push(["backup_tables", t]);
  }
  if (body.generate_cron_token) {
    const token = Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 10)).join("");
    updates.push(["backup_cron_token", token]);
  }
  if (!updates.length) return NextResponse.json({ ok: false, error: "没有需要更新的配置" }, { status: 200 });

  for (const [key, value] of updates) {
    await upsertAppSetting(db, key, value);
  }

  const config = parseBackupConfig(await readAppSettings(db, BACKUP_SETTING_KEYS));
  return NextResponse.json({ ok: true, data: { config } });
}
