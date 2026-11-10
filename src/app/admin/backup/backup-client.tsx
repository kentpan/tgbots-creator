"use client";

/**
 * 备份管理（v2.2.3）—— 自 xianyu-admin v2.3.10 app/pages/admin/backup.vue 原样复刻：
 * 表数据导出 (sql/db/json) / 定时备份配置 / 备份列表 下载·导入·删除 / 立即备份。
 * 主题色按本项目 Tailwind 主题变量（primary/muted/destructive），结构、交互与
 * xianyu 版一一对应，绝不偷工减料。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Database,
  Download,
  KeyRound,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BackupTableInfo {
  name: string;
  rows: number;
}

interface BackupConfigInfo {
  enabled: boolean;
  interval_days: number;
  hour: number;
  minute: number;
  second: number;
  tables: string;
  last_run_at: string;
  cron_token: string;
}

interface BackupObjectInfo {
  key: string;
  size: number;
  modified_at: string;
}

interface BackupConfigResponse {
  ok: boolean;
  error?: string;
  data?: {
    config: BackupConfigInfo;
    storage: string;
    storage_error: string;
    next_due: string;
    storage_settings?: { driver: string; configured: boolean; missing: string; cdn_base_url: string };
  };
}

interface ImportFileTableInfo {
  name: string;
  rows: number;
  exists_in_db: boolean;
}

interface ImportAnalysis {
  file_name: string;
  file_type: "sql" | "db" | "json";
  file_size: number;
  driver: string;
  supported: boolean;
  unsupported_reason: string;
  tables: ImportFileTableInfo[];
}

interface ImportTableReport {
  deleted: number;
  imported: number;
  created: boolean;
  added_columns: string[];
  error: string;
}

 type ImportReport = Record<string, ImportTableReport>;

const FORMAT_OPTIONS = [
  { value: "sql", label: ".SQL" },
  { value: "db", label: ".DB" },
  { value: "json", label: ".JSON" },
] as const;

type ExportFormat = (typeof FORMAT_OPTIONS)[number]["value"];

const inputClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTimeFull(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = (await res.json()) as { ok: boolean; error?: string; data?: T };
  if (!payload.ok || payload.data === undefined) {
    throw new Error(payload.error || `请求失败 (HTTP ${res.status})`);
  }
  return payload.data;
}

export function BackupClient() {
  const [loading, setLoading] = useState(false);
  const [tables, setTables] = useState<BackupTableInfo[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("sql");
  const [exporting, setExporting] = useState(false);
  const [driver, setDriver] = useState<string>("node");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importFileRef = useRef<File | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importAnalysis, setImportAnalysis] = useState<ImportAnalysis | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [importApplying, setImportApplying] = useState(false);

  const [config, setConfig] = useState<BackupConfigInfo | null>(null);
  const [storage, setStorage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [cdnBaseUrl, setCdnBaseUrl] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [schedForm, setSchedForm] = useState({
    enabled: false,
    interval_days: 1,
    hour: 4,
    minute: 38,
    second: 0,
    tables: "all",
  });
  const [savingConfig, setSavingConfig] = useState(false);

  const [backups, setBackups] = useState<BackupObjectInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [restoring, setRestoring] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BackupObjectInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const mountedRef = useRef(true);

  const allSelected = tables.length > 0 && selectedTables.length === tables.length;
  const storageShort = !storage ? "存储" : storage.includes("R2") ? "R2" : storage.includes("S3") ? "S3" : "本地快照";
  const exportTablesHint = !selectedTables.length
    ? ""
    : selectedTables.length <= 3
      ? selectedTables.join(", ")
      : `${selectedTables.slice(0, 3).join(", ")} 等 ${selectedTables.length} 表`;

  const loadTables = useCallback(async () => {
    const data = await requestJson<{ tables: BackupTableInfo[]; driver: string }>("/api/admin/backup/tables");
    if (!mountedRef.current) return;
    setTables(data.tables);
    setDriver(data.driver);
  }, []);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/admin/backup/config");
    const payload = (await res.json()) as BackupConfigResponse;
    if (!payload.ok || !payload.data) throw new Error(payload.error || "配置加载失败");
    const data = payload.data;
    if (!mountedRef.current) return;
    setConfig(data.config);
    setStorage(data.storage);
    setStorageError(data.storage_error || "");
    setCdnBaseUrl(data.storage_settings?.cdn_base_url || "");
    setNextDue(data.next_due || "");
    setSchedForm({
      enabled: !!data.config.enabled,
      interval_days: data.config.interval_days,
      hour: data.config.hour,
      minute: data.config.minute,
      second: data.config.second,
      tables: data.config.tables || "all",
    });
  }, []);

  const loadBackups = useCallback(async () => {
    const data = await requestJson<{ driver: string; storage: string; items: BackupObjectInfo[] }>(
      "/api/admin/backup/list",
    );
    if (!mountedRef.current) return;
    setBackups(data.items);
    if (data.storage) setStorage(data.storage);
  }, []);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadTables(), loadConfig(), loadBackups()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载失败");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [loadTables, loadConfig, loadBackups]);

  useEffect(() => {
    mountedRef.current = true;
    void reloadAll();
    return () => {
      mountedRef.current = false;
    };
  }, [reloadAll]);

  function toggleAll(checked: boolean) {
    setSelectedTables(checked ? tables.map((t) => t.name) : []);
  }

  function toggleTable(name: string) {
    setSelectedTables((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function toggleImportTable(name: string) {
    setImportSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  const importAllSelected =
    !!importAnalysis && importAnalysis.tables.length > 0 && importSelected.length === importAnalysis.tables.length;

  async function onPickFile(file: File) {
    importFileRef.current = file;
    setImportAnalysis(null);
    setImportSelected([]);
    setImportDialogOpen(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", "analyze");
    try {
      const res = await fetch("/api/admin/backup/import-file", { method: "POST", body: fd });
      const payload = (await res.json()) as { ok: boolean; error?: string; data?: { analysis: ImportAnalysis } };
      if (!payload.ok || !payload.data) throw new Error(payload.error || "文件解析失败");
      if (!mountedRef.current) return;
      setImportAnalysis(payload.data.analysis);
    } catch (error) {
      setImportDialogOpen(false);
      toast.error(error instanceof Error ? error.message : "文件解析失败");
    }
  }

  async function applyImport() {
    const file = importFileRef.current;
    if (!file || !importSelected.length) return;
    setImportApplying(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", "apply");
      fd.append("tables", importSelected.join(","));
      const res = await fetch("/api/admin/backup/import-file", { method: "POST", body: fd });
      const payload = (await res.json()) as { ok: boolean; error?: string; data?: { report: ImportReport } };
      if (!payload.ok || !payload.data) throw new Error(payload.error || "导入失败");
      const report = payload.data.report;
      const okParts: string[] = [];
      const errParts: string[] = [];
      for (const [table, r] of Object.entries(report)) {
        if (r.error) {
          errParts.push(`${table}: ${r.error}`);
          continue;
        }
        okParts.push(
          `${table}: 清空 ${r.deleted} 行 / 写入 ${r.imported} 行${r.added_columns.length ? ` / 补列 ${r.added_columns.length}` : ""}${r.created ? " / 新建表" : ""}`,
        );
      }
      if (errParts.length) {
        toast.error(`导入完成但有失败 — ${errParts.slice(0, 3).join("; ")}${errParts.length > 3 ? " 等" : ""}`);
      } else {
        toast.success(`导入完成 — ${okParts.slice(0, 4).join(", ")}${okParts.length > 4 ? " 等" : ""}`);
      }
      setImportDialogOpen(false);
      await Promise.all([loadTables(), loadConfig(), loadBackups()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImportApplying(false);
    }
  }

  function doExport() {
    if (!selectedTables.length) return;
    // db 格式可用性由服务端按驱动判定 (sqlite=可, d1=如实报错), 前端不预判
    setExporting(true);
    try {
      const url = `/api/admin/backup/export?${new URLSearchParams({
        tables: selectedTables.join(","),
        format: exportFormat,
      }).toString()}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`已触发导出 (${exportFormat.toUpperCase()}, ${selectedTables.length} 表)`);
    } finally {
      setExporting(false);
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    try {
      const data = await requestJson<{ config: BackupConfigInfo }>("/api/admin/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: schedForm.enabled,
          interval_days: schedForm.interval_days,
          hour: schedForm.hour,
          minute: schedForm.minute,
          second: schedForm.second,
          tables: schedForm.tables,
        }),
      });
      setConfig(data.config);
      toast.success(schedForm.enabled ? "定时备份已开启" : "定时备份已关闭");
      await loadConfig();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSavingConfig(false);
    }
  }

  async function generateToken() {
    setSavingConfig(true);
    try {
      const data = await requestJson<{ config: BackupConfigInfo }>("/api/admin/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generate_cron_token: true }),
      });
      setConfig(data.config);
      toast.success("回调令牌已生成 — 请同步到定时器环境变量 BACKUP_TOKEN");
      await loadConfig();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setSavingConfig(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const data = await requestJson<{ backup: { key: string; tables: string[]; rows: number } }>(
        "/api/admin/backup/run",
        { method: "POST" },
      );
      toast.success(`备份完成: ${data.backup.key} (${data.backup.tables.length} 表 / ${data.backup.rows} 行)`);
      await Promise.all([loadBackups(), loadConfig()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "备份失败");
    } finally {
      setRunning(false);
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await requestJson(`/api/admin/backup/${encodeURIComponent(deleteTarget.key)}`, { method: "DELETE" });
      toast.success("备份已删除");
      setDeleteTarget(null);
      await loadBackups();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  async function doRestore(b: BackupObjectInfo) {
    if (!window.confirm(`确认把备份「${b.key}」导入当前库？按表 PK upsert (同名数据会被备份内容覆盖)。`)) return;
    setRestoring(b.key);
    try {
      const data = await requestJson<{ report: Record<string, { inserted: number; updated: number; skipped: number }> }>(
        `/api/admin/backup/${encodeURIComponent(b.key)}/restore`,
        { method: "POST" },
      );
      const parts: string[] = [];
      for (const [table, s] of Object.entries(data.report || {})) {
        parts.push(`${table}: 新增 ${s.inserted} / 更新 ${s.updated}${s.skipped ? ` / 跳过 ${s.skipped}` : ""}`);
      }
      toast.success(parts.length ? `导入完成 — ${parts.slice(0, 4).join(", ")}${parts.length > 4 ? " 等" : ""}` : "导入完成 (无变化)");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setRestoring("");
    }
  }

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">备份管理</h1>
          <p className="text-sm text-muted-foreground">
            表数据导出 (sql/db/json) / 定时备份到存储 / 备份列表下载·导入·删除
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void reloadAll()}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> 刷新
          </Button>
          <Button variant="outline" size="sm" disabled={importApplying} onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" /> 导入本地文件
          </Button>
          <Button size="sm" disabled={running} onClick={() => void runNow()}>
            {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            立即备份到 {storageShort}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".sql,.db,.sqlite,.sqlite3,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onPickFile(f);
            }}
          />
        </div>
      </div>

      {/* 存储模式提示 */}
      {storageError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-300">云端备份存储未就绪</p>
              <p className="mt-1 text-amber-600 dark:text-amber-400">{storageError}</p>
              <p className="mt-1 text-amber-600 dark:text-amber-400">
                本地 Node 部署自动回落 db-snapshots/backups/; Cloudflare 部署需在 wrangler.toml 配置 R2 绑定 BACKUP_R2。
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 数据导出 */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-medium">
            <Download className="h-4 w-4 text-primary" /> 数据导出
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedTables(tables.map((t) => t.name))}>
              全选
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelectedTables([])}>
              取消
            </Button>
            <div className="flex items-center gap-1 rounded-lg border p-0.5">
              {FORMAT_OPTIONS.map((f) => {
                const dbUnavailable = f.value === "db" && driver === "d1";
                return (
                  <button
                    key={f.value}
                    type="button"
                    disabled={dbUnavailable}
                    title={
                      dbUnavailable
                        ? ".db 快照需要本地 SQLite 引擎，D1 运行环境不可用 — 请用 .sql / .json"
                        : undefined
                    }
                    className={`rounded-md px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      exportFormat === f.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                    }`}
                    onClick={() => setExportFormat(f.value)}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            <Button size="sm" disabled={!selectedTables.length || exporting} onClick={doExport}>
              <Download className="h-4 w-4" /> 导出 ({selectedTables.length} 表)
            </Button>
          </div>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          .sql = 逐表 DELETE+INSERT 语句 · .db = SQLite 快照文件 (仅本地 SQLite 驱动) · .json = 与导入格式同源
          {exportTablesHint ? ` · 已选 ${exportTablesHint}` : null}
        </p>
        <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60">
              <tr className="text-left">
                <th className="w-10 p-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--primary)]"
                    checked={allSelected}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className="p-2 font-medium">表名</th>
                <th className="p-2 font-medium">行数</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.name} className="cursor-pointer border-t hover:bg-accent/40" onClick={() => toggleTable(t.name)}>
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--primary)]"
                      value={t.name}
                      checked={selectedTables.includes(t.name)}
                      onChange={() => toggleTable(t.name)}
                    />
                  </td>
                  <td className="p-2 font-mono">{t.name}</td>
                  <td className="p-2 text-muted-foreground">{t.rows}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!tables.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">暂无可备份表</div>
          ) : null}
        </div>
      </div>

      {/* 定时备份配置 */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-medium">
            <Clock className="h-4 w-4 text-primary" /> 定时备份 (每 X 天 X时X分X秒, 备份到 {storageShort})
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{schedForm.enabled ? "已开启" : "已关闭 (默认)"}</span>
            <Switch
              checked={schedForm.enabled}
              onCheckedChange={(checked) => setSchedForm((prev) => ({ ...prev, enabled: checked }))}
              aria-label="定时备份开关"
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24">
              <label className="mb-1 block text-sm font-medium">每 X 天</label>
              <input
                type="number"
                min={1}
                max={3650}
                className={inputClass}
                value={schedForm.interval_days}
                onChange={(e) => setSchedForm((prev) => ({ ...prev, interval_days: Number(e.target.value) }))}
              />
            </div>
            <div className="w-20">
              <label className="mb-1 block text-sm font-medium">时 (0-23)</label>
              <input
                type="number"
                min={0}
                max={23}
                className={inputClass}
                value={schedForm.hour}
                onChange={(e) => setSchedForm((prev) => ({ ...prev, hour: Number(e.target.value) }))}
              />
            </div>
            <div className="w-20">
              <label className="mb-1 block text-sm font-medium">分 (0-59)</label>
              <input
                type="number"
                min={0}
                max={59}
                className={inputClass}
                value={schedForm.minute}
                onChange={(e) => setSchedForm((prev) => ({ ...prev, minute: Number(e.target.value) }))}
              />
            </div>
            <div className="w-20">
              <label className="mb-1 block text-sm font-medium">秒 (0-59)</label>
              <input
                type="number"
                min={0}
                max={59}
                className={inputClass}
                value={schedForm.second}
                onChange={(e) => setSchedForm((prev) => ({ ...prev, second: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-sm font-medium">备份表范围</label>
              <select
                className={inputClass}
                value={schedForm.tables}
                onChange={(e) => setSchedForm((prev) => ({ ...prev, tables: e.target.value }))}
              >
                <option value="all">全部白名单表</option>
                {schedForm.tables !== "all" ? <option value={schedForm.tables}>自定义: {schedForm.tables}</option> : null}
              </select>
            </div>
            <p className="text-sm text-muted-foreground">
              上次运行: {formatTimeFull(config?.last_run_at ?? "") || "从未运行"}
              {nextDue ? ` · 下次到点: ${formatTimeFull(nextDue)}` : ""}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={savingConfig} onClick={() => void saveConfig()}>
            {savingConfig ? <RefreshCw className="h-4 w-4 animate-spin" /> : null} 保存配置
          </Button>
          <Button variant="outline" size="sm" disabled={savingConfig} onClick={() => void generateToken()}>
            <KeyRound className="h-4 w-4" /> 生成回调令牌
          </Button>
          {config?.cron_token ? (
            <span className="break-all font-mono text-sm text-muted-foreground">令牌: {config.cron_token}</span>
          ) : null}
        </div>

        <div className="mt-4 space-y-1.5 rounded-lg bg-muted/50 p-4">
          <p className="font-medium text-foreground/80">定时任务接入 (Cron Triggers 最小粒度 1 分钟, 秒级到点由服务端判定兑现):</p>
          <p className="text-muted-foreground">
            Cloudflare 部署可用 Cron Triggers / 外部定时器每分钟回调下方端点; 本地 Node 常驻部署由内置任务循环自动兜底:
          </p>
          <code className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-foreground/80">
            curl -X POST &quot;&lt;站点地址&gt;/api/admin/backup/cron?token=&lt;回调令牌&gt;&quot;
          </code>
        </div>
      </div>

      {/* 备份列表 */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Database className="h-4 w-4 text-primary" />
          <span className="font-medium">备份列表</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{storage || "存储未就绪"}</span>
          {cdnBaseUrl ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">CDN: {cdnBaseUrl}</span>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/60">
              <tr className="text-left">
                <th className="p-2 font-medium">文件名</th>
                <th className="p-2 font-medium">大小</th>
                <th className="p-2 font-medium">时间</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.key} className="border-t">
                  <td className="p-2 font-mono">{b.key}</td>
                  <td className="p-2 text-muted-foreground">{formatSize(b.size)}</td>
                  <td className="p-2 text-muted-foreground">{formatTimeFull(b.modified_at)}</td>
                  <td>
                    <div className="flex items-center justify-end gap-1">
                      <a
                        className="inline-flex h-8 items-center rounded-md px-2 hover:bg-accent"
                        title="下载"
                        href={`/api/admin/backup/${encodeURIComponent(b.key)}/download`}
                      >
                        <Download className="h-4 w-4" />
                      </a>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center rounded-md px-2 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                        title={b.key.endsWith(".json") ? "导入 (按表 PK upsert 回灌)" : "仅 .json 支持在线导入"}
                        disabled={!b.key.endsWith(".json") || restoring === b.key}
                        onClick={() => void doRestore(b)}
                      >
                        {restoring === b.key ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-8 items-center rounded-md px-2 text-destructive hover:bg-destructive/10"
                        title="删除"
                        onClick={() => setDeleteTarget(b)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!backups.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              暂无备份 — 点击右上角「立即备份」生成第一份
            </div>
          ) : null}
        </div>
      </div>

      {/* 删除备份确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除备份</DialogTitle>
            <DialogDescription className="sr-only">确认删除备份文件</DialogDescription>
          </DialogHeader>
          <div className="py-2 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <p className="text-muted-foreground">
              确认删除备份 <span className="font-medium text-foreground">{deleteTarget?.key}</span>？操作不可撤销。
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" className="flex-1" disabled={deleting} onClick={() => void doDelete()}>
              {deleting ? <RefreshCw className="h-4 w-4 animate-spin" /> : null} 确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 本地文件导入（.sql / .db / .json）：分析弹窗 → 表多选 → 整表覆盖导入 */}
      <Dialog open={importDialogOpen} onOpenChange={(open) => !open && setImportDialogOpen(false)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入本地备份文件</DialogTitle>
            <DialogDescription>
              {importAnalysis
                ? `${importAnalysis.file_name}（${importAnalysis.file_type.toUpperCase()} · ${formatSize(importAnalysis.file_size)}） · 当前运行环境：${importAnalysis.driver === "d1" ? "Cloudflare D1" : "Node SQLite"}`
                : "正在解析文件…"}
            </DialogDescription>
          </DialogHeader>

          {importAnalysis && !importAnalysis.supported ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
                <div>
                  <p className="font-medium text-amber-700 dark:text-amber-300">当前运行环境不支持导入此文件</p>
                  <p className="mt-1 text-amber-600 dark:text-amber-400">{importAnalysis.unsupported_reason}</p>
                </div>
              </div>
            </div>
          ) : null}

          {importAnalysis && importAnalysis.supported ? (
            <>
              <p className="text-sm text-muted-foreground">
                文件共 {importAnalysis.tables.length} 张表。勾选要导入的表（可全量或多选），
                导入时选中表<b className="text-destructive">现有数据会被清空</b>并整表替换为文件内容。
              </p>
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr className="text-left">
                      <th className="w-10 p-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          checked={importAllSelected}
                          onChange={(e) =>
                            setImportSelected(e.target.checked ? importAnalysis.tables.map((t) => t.name) : [])
                          }
                        />
                      </th>
                      <th className="p-2 font-medium">表名</th>
                      <th className="p-2 font-medium">文件行数</th>
                      <th className="p-2 font-medium">导入动作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importAnalysis.tables.map((t) => (
                      <tr
                        key={t.name}
                        className="cursor-pointer border-t hover:bg-accent/40"
                        onClick={() => toggleImportTable(t.name)}
                      >
                        <td className="p-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--primary)]"
                            checked={importSelected.includes(t.name)}
                            onChange={() => toggleImportTable(t.name)}
                          />
                        </td>
                        <td className="p-2 font-mono">{t.name}</td>
                        <td className="p-2 text-muted-foreground">{t.rows}</td>
                        <td className="p-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              t.exists_in_db
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            }`}
                          >
                            {t.exists_in_db ? "覆盖现有表" : "新建表"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!importAnalysis.tables.length ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">文件中没有可导入的表</div>
                ) : null}
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setImportDialogOpen(false)}>
              取消
            </Button>
            <Button
              className="flex-1"
              disabled={
                !importAnalysis ||
                !importAnalysis.supported ||
                !importSelected.length ||
                importApplying
              }
              onClick={() => void applyImport()}
            >
              {importApplying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              导入并覆盖 ({importSelected.length} 表)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
