"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChartData, ChartOptions } from "chart.js";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar, Doughnut } from "react-chartjs-2";
import { RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { formatBeijingDateTime } from "@/utils/datetime";

/**
 * API 日志页（v2.2.5）：数据看板 + chart.js 统计图表 + 全量日志列表/详情。
 * 覆盖四类主要 API：Webhook 请求 / TGAPI 申请 / 一键部署 / Bot API 调用。
 */

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

interface ApiLogRow {
  id: number;
  category: string;
  bot_id: string | null;
  bot_label: string | null;
  method: string;
  ok: number;
  status_code: number | null;
  request_payload: string | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  created_time: string;
}

interface ApiLogStats {
  summary: {
    total: number;
    last24h: number;
    last24hFail: number;
    successRate: number;
    avgDurationMs: number;
  };
  byCategory: { category: string; total: number; fail: number }[];
  byHour: { hour: string; webhook: number; tgapi: number; deploy: number; "bot-api": number }[];
  topMethods: { method: string; total: number; fail: number }[];
  recentErrors: {
    id: number;
    category: string;
    method: string;
    bot_label: string | null;
    error: string | null;
    created_time: string;
  }[];
}

const CATEGORY_LABELS: Record<string, string> = {
  webhook: "Webhook 请求",
  tgapi: "TGAPI 申请",
  deploy: "一键部署",
  "bot-api": "Bot API 调用",
};

const CATEGORY_COLORS: Record<string, string> = {
  webhook: "#0d9488",
  tgapi: "#ca8a04",
  deploy: "#16a34a",
  "bot-api": "#65a30d",
};

const PAGE_SIZE = 20;

function formatTime(raw: string): string {
  const date = new Date(`${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return formatBeijingDateTime(date);
}

function prettyJson(text: string | null): string {
  if (!text) return "（空）";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function ApiLogsClient() {
  const [stats, setStats] = useState<ApiLogStats | null>(null);
  const [logs, setLogs] = useState<ApiLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("all");
  const [okFilter, setOkFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ApiLogRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [clearing, setClearing] = useState(false);

  /**
   * v2.2.6 D1 限额优化：列表接口不再返回 payload 大字段，详情弹窗打开时按需
   * 读取单行（GET /api/admin/api-logs/[id]）；错误完整展示，不静默。
   */
  const openDetail = useCallback(async (row: ApiLogRow) => {
    setDetail(row);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/admin/api-logs/${row.id}`, { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; log?: ApiLogRow; error?: string };
      if (payload.ok && payload.log) {
        setDetail(payload.log);
      } else {
        setDetailError(payload.error ?? `详情读取失败（HTTP ${response.status}）`);
      }
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "详情读取请求失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    const response = await fetch("/api/admin/api-logs/stats", { cache: "no-store" });
    const payload = await response.json();
    if (payload.ok) setStats(payload.stats as ApiLogStats);
  }, []);

  const loadLogs = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(PAGE_SIZE),
          ok: okFilter,
        });
        if (category !== "all") params.set("category", category);
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/admin/api-logs?${params.toString()}`, { cache: "no-store" });
        const payload = await response.json();
        if (payload.ok) {
          setLogs(payload.logs as ApiLogRow[]);
          setTotal(payload.total as number);
          setPage(payload.page as number);
        }
      } finally {
        setLoading(false);
      }
    },
    [category, okFilter, query],
  );

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    void loadLogs(1);
  }, [loadLogs]);

  const refreshAll = useCallback(() => {
    void loadStats();
    void loadLogs(1);
  }, [loadStats, loadLogs]);

  const clearLogs = async () => {
    setClearing(true);
    try {
      const response = await fetch("/api/admin/api-logs/clear", { method: "POST" });
      const payload = await response.json();
      if (payload.ok) {
        setNotice({ ok: true, text: `API 日志已清空（共删除 ${payload.removed} 条记录）` });
        refreshAll();
      } else {
        setNotice({ ok: false, text: `清空失败：${payload.error ?? "未知错误"}` });
      }
    } catch (error) {
      setNotice({
        ok: false,
        text: `清空失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setClearing(false);
    }
  };

  // ---- 图表数据（chart.js）----
  const trendData = useMemo<ChartData<"bar", number[], string>>(
    () => ({
      labels: (stats?.byHour ?? []).map((entry) => entry.hour),
      datasets: (["webhook", "tgapi", "deploy", "bot-api"] as const).map((key) => ({
        label: CATEGORY_LABELS[key],
        data: (stats?.byHour ?? []).map((entry) => entry[key]),
        backgroundColor: CATEGORY_COLORS[key],
        stack: "api",
        borderRadius: 3,
      })),
    }),
    [stats],
  );

  const trendOptions = useMemo<ChartOptions<"bar">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, stacked: true, ticks: { precision: 0 }, title: { display: true, text: "调用次数" } },
      },
      plugins: { legend: { position: "bottom" } },
    }),
    [],
  );

  const categoryData = useMemo<ChartData<"doughnut", number[], string>>(() => {
    const entries = stats?.byCategory ?? [];
    return {
      labels: entries.map((entry) => CATEGORY_LABELS[entry.category] ?? entry.category),
      datasets: [
        {
          data: entries.map((entry) => entry.total),
          backgroundColor: entries.map((entry) => CATEGORY_COLORS[entry.category] ?? "#4b5563"),
          borderWidth: 0,
        },
      ],
    };
  }, [stats]);

  const methodData = useMemo<ChartData<"bar", number[], string>>(() => {
    const entries = (stats?.topMethods ?? []).slice(0, 8);
    return {
      labels: entries.map((entry) => entry.method),
      datasets: [
        {
          label: "调用次数",
          data: entries.map((entry) => entry.total),
          backgroundColor: entries.map((entry) => (entry.fail > 0 ? "#ea580c" : "#16a34a")),
          borderRadius: 4,
        },
      ],
    };
  }, [stats]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summaryCards = [
    { label: "日志总数", value: stats ? String(stats.summary.total) : "—" },
    { label: "24 小时请求", value: stats ? String(stats.summary.last24h) : "—" },
    { label: "24 小时失败", value: stats ? String(stats.summary.last24hFail) : "—" },
    { label: "成功率", value: stats ? `${stats.summary.successRate}%` : "—" },
    { label: "平均耗时", value: stats ? `${stats.summary.avgDurationMs} ms` : "—" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">API 日志</h1>
          <p className="text-sm text-muted-foreground">
            Webhook 请求 / TGAPI 申请 / 一键部署 / Bot API 调用的全流程日志与统计（保留最近 5000 条）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-1 h-4 w-4" />
            刷新
          </Button>
          <ConfirmDialog
            trigger={
              <span className="flex items-center gap-1">
                <Trash2 className="h-4 w-4" />
                {clearing ? "清空中…" : "清空日志"}
              </span>
            }
            triggerClassName="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700"
            title="清空全部 API 日志"
            description="将删除所有 API 日志记录（含 Webhook / TGAPI / 部署 / Bot API 类别），该操作不可恢复。确定继续吗？"
            confirmLabel="确认清空"
            onConfirm={clearLogs}
          />
        </div>
      </div>

      {notice ? (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            notice.ok
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* 数据看板 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {summaryCards.map((card) => (
          <div key={card.label} className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-xl font-semibold">{card.value}</p>
          </div>
        ))}
      </div>

      {/* 统计图表 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-xl border bg-card p-4 xl:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">24 小时调用趋势（按类别）</h2>
          <div className="h-64">
            <Bar data={trendData} options={trendOptions} />
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">类别分布</h2>
          <div className="h-64">
            {stats && stats.byCategory.length > 0 ? (
              <Doughnut
                data={categoryData}
                options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }}
              />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无数据</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">高频方法（橙 = 含失败）</h2>
          <div className="h-56">
            {stats && stats.topMethods.length > 0 ? (
              <Bar
                data={methodData}
                options={{
                  indexAxis: "y",
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
                  plugins: { legend: { display: false } },
                }}
              />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无数据</p>
            )}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4 xl:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">最近失败记录</h2>
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
            {stats && stats.recentErrors.length > 0 ? (
              stats.recentErrors.map((entry) => (
                <div key={entry.id} className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                      {CATEGORY_LABELS[entry.category] ?? entry.category}
                    </span>
                    <span className="font-mono text-xs">{entry.method}</span>
                    {entry.bot_label ? (
                      <span className="text-xs text-muted-foreground">{entry.bot_label}</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">{formatTime(entry.created_time)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-red-700">{entry.error ?? "（无错误详情）"}</p>
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无失败记录</p>
            )}
          </div>
        </div>
      </div>

      {/* 筛选 + 列表 */}
      <div className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="全部类别" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类别</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={okFilter}
            onValueChange={(value) => {
              setOkFilter(value);
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="success">仅成功</SelectItem>
              <SelectItem value="fail">仅失败</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-64"
            placeholder="搜索方法/机器人/错误/参数…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="ml-auto text-sm text-muted-foreground">共 {total} 条</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">时间</th>
                <th className="px-4 py-3 font-medium">类别</th>
                <th className="px-4 py-3 font-medium">方法 / 端点</th>
                <th className="px-4 py-3 font-medium">机器人</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">耗时</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    加载中…
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    暂无日志记录
                  </td>
                </tr>
              ) : (
                logs.map((row) => (
                  <tr key={row.id} className="border-b text-sm last:border-0 hover:bg-muted/40">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{formatTime(row.created_time)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-white"
                        style={{ backgroundColor: CATEGORY_COLORS[row.category] ?? "#4b5563" }}
                      >
                        {CATEGORY_LABELS[row.category] ?? row.category}
                      </span>
                    </td>
                    <td className="max-w-64 truncate px-4 py-2.5 font-mono text-xs" title={row.method}>
                      {row.method}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {row.bot_label ?? (row.bot_id ? `#${row.bot_id}` : "—")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {row.ok === 1 ? (
                        <span className="text-xs font-medium text-green-600">成功{row.status_code ? ` · ${row.status_code}` : ""}</span>
                      ) : (
                        <span className="text-xs font-medium text-red-600" title={row.error ?? ""}>
                          失败{row.status_code ? ` · ${row.status_code}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                      {row.duration_ms === null ? "—" : `${row.duration_ms} ms`}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button variant="outline" size="sm" onClick={() => void openDetail(row)}>
                        详情
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t p-4 text-sm">
          <span className="text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => void loadLogs(page - 1)}>
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => void loadLogs(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </div>

      {/* 详情弹窗 */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              日志详情 #{detail?.id} · {detail ? CATEGORY_LABELS[detail.category] ?? detail.category : ""}
            </DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="space-y-2 py-4">
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-20 w-full animate-pulse rounded bg-muted" />
              <div className="h-20 w-full animate-pulse rounded bg-muted" />
            </div>
          ) : detailError ? (
            <p className="text-sm text-red-600">{detailError}</p>
          ) : detail ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">时间</p>
                  <p className="font-mono">{formatTime(detail.created_time)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">方法 / 端点</p>
                  <p className="font-mono break-all">{detail.method}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">状态</p>
                  <p className={detail.ok === 1 ? "text-green-600" : "text-red-600"}>
                    {detail.ok === 1 ? "成功" : "失败"}
                    {detail.status_code ? ` · HTTP ${detail.status_code}` : ""}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">耗时</p>
                  <p className="font-mono">{detail.duration_ms === null ? "—" : `${detail.duration_ms} ms`}</p>
                </div>
              </div>
              {detail.bot_id || detail.bot_label ? (
                <div className="text-xs">
                  <p className="text-muted-foreground">机器人</p>
                  <p className="font-mono">
                    {detail.bot_label ?? ""} {detail.bot_id ? `(#${detail.bot_id})` : ""}
                  </p>
                </div>
              ) : null}
              {detail.error ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-red-600">错误信息</p>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                    {detail.error}
                  </pre>
                </div>
              ) : null}
              <div>
                <p className="mb-1 text-xs font-medium">请求传参（原始）</p>
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs [scrollbar-width:thin]">
                  {prettyJson(detail.request_payload)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">返回结果（原始数据）</p>
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs [scrollbar-width:thin]">
                  {prettyJson(detail.response_body)}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 清空确认由 ConfirmDialog 内建（AlertDialog 二次确认） */}
    </div>
  );
}
