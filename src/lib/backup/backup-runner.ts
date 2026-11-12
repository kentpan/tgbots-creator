/**
 * backup-runner — 备份执行器（v2.2.3，自 xianyu-admin v2.3.10 backup-runner.ts 原样复刻，
 * 数据层适配本项目的 SqlDatabase：driver 由 kind 映射，get 由 all 首行实现）。
 *
 * 快照格式: JSON envelope { exported_at, driver, tables: { 表名: 行[] } }
 *   — 与导入（backup-restore.ts / api/admin/backup/import）的格式完全同源, 备份列表「导入」
 *   即复用该导入链路 (按表 PK upsert), 绝不做第二套解析。
 *
 * 定时语义「每 X 天 X时X分X秒」:
 *   - 到点判定: 今天的服务器时区 H:M:S 时刻已过 && 上次运行早于该时刻 &&
 *     今天距上次运行日 >= X 天 (首次运行 last 为空 → 到点即跑);
 *   - Cloudflare Cron Triggers 最小粒度是分钟, 秒级由「分钟内到点判定」兑现
 *     (cron 每分钟打一次 /api/admin/backup/cron, 在 H:M:S 落入的那个分钟窗口内执行);
 *   - 本地 Node 常驻部署由内置任务循环 (src/bot/tasks.ts) 兜底轮询同一判定。
 */
import { getDatabase, type SqlDatabase } from "@/database/client";
import { isCatalogTable, loadTableCatalog } from "./whitelist";

export interface BackupConfig {
  enabled: boolean;
  interval_days: number;
  hour: number;
  minute: number;
  second: number;
  tables: string;
  last_run_at: string;
  cron_token: string;
}

/** 本项目数据库驱动标识（SqlDatabase.kind → 展示语义）。 */
export function driverOf(db: SqlDatabase): string {
  return db.kind === "d1" ? "d1" : "sqlite";
}

export function parseBackupConfig(settings: Record<string, string>): BackupConfig {
  const num = (v: string | undefined, def: number, min: number, max: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
  };
  return {
    enabled: String(settings.backup_enabled ?? "false") === "true",
    interval_days: num(settings.backup_interval_days, 1, 1, 3650),
    hour: num(settings.backup_hour, 4, 0, 23),
    minute: num(settings.backup_minute, 38, 0, 59),
    second: num(settings.backup_second, 0, 0, 59),
    tables: String(settings.backup_tables ?? "all") || "all",
    last_run_at: String(settings.backup_last_run_at ?? ""),
    cron_token: String(settings.backup_cron_token ?? ""),
  };
}

/** 读取主库中的全部备份相关设置（app_settings.backup_*）。 */
export async function loadBackupSettings(db?: SqlDatabase): Promise<Record<string, string>> {
  const database = db ?? (await getDatabase());
  const rows = await database.all<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key LIKE 'backup_%'`,
  );
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

/** 解析定时备份的表范围: 'all' → 数据库全部业务表; 否则按逗号分隔且仅保留库中实际存在的表名。 */
export async function resolveBackupTables(db: SqlDatabase, tables: string): Promise<string[]> {
  const t = String(tables || "all").trim();
  const catalog = await loadTableCatalog(db);
  if (!t || t === "all") return [...catalog.tables];
  const wanted = t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && isCatalogTable(catalog, s));
  const unknown = t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !isCatalogTable(catalog, s));
  if (unknown.length > 0) {
    throw new Error(`配置的备份表不存在于数据库: ${unknown.join(", ")}`);
  }
  return wanted;
}

/** 收集快照数据 (JSON envelope)。表读失败直接抛出，绝不静默产出缺表快照。 */
export async function collectSnapshot(
  db: SqlDatabase,
  tablesParam: string | string[],
): Promise<{
  exported_at: string
  driver: string
  tables: Record<string, Record<string, unknown>[]>
}> {
  const catalog = await loadTableCatalog(db);
  const wanted = Array.isArray(tablesParam)
    ? tablesParam.filter((name) => {
        if (isCatalogTable(catalog, name)) return true;
        throw new Error(`表不存在于数据库: ${name}`);
      })
    : await resolveBackupTables(db, tablesParam);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of wanted) {
    tables[name] = await db.all(`SELECT * FROM ${name}`);
  }
  return { exported_at: new Date().toISOString(), driver: driverOf(db), tables };
}

/** 到点判定结果 (due + 如实原因, 供回调端点原样透出)。 */
export function isBackupDue(cfg: BackupConfig, now = new Date()): { due: boolean; reason: string } {
  if (!cfg.enabled) return { due: false, reason: "定时备份未启用" };
  const target = new Date(now);
  target.setHours(cfg.hour, cfg.minute, cfg.second, 0);
  if (now.getTime() < target.getTime()) return { due: false, reason: `未到今天的备份时刻 (${cfg.hour}:${cfg.minute}:${cfg.second})` };
  if (!cfg.last_run_at) return { due: true, reason: "首次备份: 已到点且从未运行" };
  const last = new Date(cfg.last_run_at);
  if (Number.isNaN(last.getTime())) return { due: true, reason: "上次运行时间损坏, 视作从未运行" };
  if (last.getTime() >= target.getTime()) return { due: false, reason: "今天的备份时刻已运行过" };
  const lastTarget = new Date(last);
  lastTarget.setHours(cfg.hour, cfg.minute, cfg.second, 0);
  const dayDiff = Math.floor((target.getTime() - lastTarget.getTime()) / 86_400_000);
  if (dayDiff < cfg.interval_days) {
    return { due: false, reason: `未到周期: 距上次运行 ${dayDiff} 天, 需 ≥ ${cfg.interval_days} 天` };
  }
  return { due: true, reason: `已到点 (每 ${cfg.interval_days} 天 ${cfg.hour}:${cfg.minute}:${cfg.second})` };
}

export interface BackupRunResult {
  key: string;
  size: number;
  storage: string;
  tables: string[];
  rows: number;
}

/** 执行一次备份并落存储 (定时/手动共用)。 */
export async function runBackup(
  db: SqlDatabase,
  store: Awaited<ReturnType<typeof import("./backup-store").getBackupStore>>,
  tablesParam: string | string[],
): Promise<BackupRunResult> {
  const snapshot = await collectSnapshot(db, tablesParam);
  const tableNames = Object.keys(snapshot.tables);
  const json = JSON.stringify(snapshot);
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  const key = `backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  await store.put(key, json);
  const rows = tableNames.reduce((acc, t) => acc + (snapshot.tables[t]?.length || 0), 0);
  return { key, size: new TextEncoder().encode(json).length, storage: store.label, tables: tableNames, rows };
}

/** 备份后回写 last_run 设置 (app_settings.backup_last_run_at)。回写失败留痕，不影响已落盘的备份。 */
export async function markBackupRan(db: SqlDatabase): Promise<void> {
  const value = new Date().toISOString();
  try {
    const updated = await db.run(
      `UPDATE app_settings SET value = ?, updated_time = CURRENT_TIMESTAMP WHERE key = 'backup_last_run_at'`,
      [value],
    );
    if (updated.changes === 0) {
      await db.run(`INSERT INTO app_settings (key, value) VALUES ('backup_last_run_at', ?)`, [value]);
    }
  } catch (error) {
    console.error("备份 last_run_at 回写失败（下次到点将重复执行一次备份）:", error);
  }
}
