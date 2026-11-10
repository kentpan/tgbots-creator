"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { D1DailyUsage } from "@/services/d1-metrics";

/**
 * Dashboard 核心指标卡片 —— D1 数据库配额（v2.0.7 引入，v2.1.3 按用户参考样式重做）。
 *
 * 数据链路：客户端懒加载 /api/admin/dashboard/d1-metrics（服务端 5 分钟缓存聚合，
 * GraphQL Analytics API 真实读取注入运行环境的 CLOUDFLARE_API_TOKEN 对应账号数据），
 * 不阻塞控制台 RSC 首屏；未配置/权限不足时优雅降级展示原因。
 *
 * 卡片布局（对齐用户参考截图）：
 *   [D1 数据库配额] [D1 精确计量] [日期 (UTC)] [读充足·写充足]      UTC 午夜重置 X小时Y分后
 *   今日读取行数                        7,039 / 5,000,000
 *   [进度条] 已用 0.1% · 41 次读查询
 *   今日写入行数                            2 / 100,000
 *   [进度条] 已用 0% · 2 次写查询
 *
 * UTC 午夜重置倒计时为纯客户端定时器（30s 一跳，零 D1/KV 消耗）。
 */

function formatRows(value: number): string {
  return value.toLocaleString("en-US");
}

function usageTone(percent: number): { bar: string; text: string } {
  if (percent >= 100) return { bar: "bg-red-500", text: "text-red-600" };
  if (percent >= 80) return { bar: "bg-amber-500", text: "text-amber-600" };
  return { bar: "bg-emerald-500", text: "text-emerald-600" };
}

/** 距下一个 UTC 午夜的倒计时文案（X小时Y分后 / N分后 / 即将重置） */
function utcResetCountdown(now: Date): string {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  const ms = Math.max(0, nextMidnight - now.getTime());
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}小时${minutes}分后`;
  if (minutes > 0) return `${minutes}分后`;
  return "即将重置";
}

function UsageBar({
  label,
  used,
  limit,
  queries,
  queryLabel,
}: {
  label: string;
  used: number;
  limit: number;
  queries: number;
  queryLabel: string;
}) {
  const percent = limit > 0 ? Math.min(999, Math.round((used / limit) * 1000) / 10) : 0;
  const tone = usageTone(percent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-medium">
          {formatRows(used)} / {formatRows(limit)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${Math.max(percent > 0 ? 1.5 : 0, Math.min(100, percent))}%` }}
        />
      </div>
      <p className={`text-xs ${tone.text}`}>
        已用 {percent}% · {formatRows(queries)} 次{queryLabel}
      </p>
    </div>
  );
}

/** D1 用量数据来源徽标（运行环境注入 / 部署默认值 / 后台配置 / Token 自动探测） */
function sourceBadgeText(usage: D1DailyUsage): string | null {
  if (!usage.source) return null;
  const kinds = [usage.source.accountId, usage.source.apiToken];
  if (kinds.includes("env-cloudflare")) return "运行环境注入";
  if (kinds.includes("env-default")) return "部署默认值";
  if (kinds.every((kind) => kind === "stored")) return "后台配置";
  if (kinds.includes("auto-probe")) return "Token 自动探测";
  return null;
}

export function D1UsageCard() {
  const [usage, setUsage] = useState<D1DailyUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  // UTC 午夜重置倒计时：纯客户端时钟，30s 一跳（SSR 返回空串避免水合不一致）
  const [countdown, setCountdown] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(null);
    try {
      const response = await fetch("/api/admin/dashboard/d1-metrics", { cache: "no-store" });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: D1DailyUsage;
        error?: string;
      };
      if (payload.data) {
        setUsage(payload.data);
        setFailed(null);
      } else {
        setFailed(payload.error ?? `服务返回异常（HTTP ${response.status}）`);
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const update = (): void => setCountdown(utcResetCountdown(new Date()));
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const sourceLabel = usage ? sourceBadgeText(usage) : null;
  // 读/写状态徽章：<80% 充足，≥80% 紧张，≥100% 已超限
  const readTone = usage ? usageTone(usage.readPercent) : null;
  const writeTone = usage ? usageTone(usage.writePercent) : null;
  const readStatus = usage ? (usage.readPercent >= 100 ? "读取已超限" : usage.readPercent >= 80 ? "读取紧张" : "读充足") : "";
  const writeStatus = usage ? (usage.writePercent >= 100 ? "写入已超限" : usage.writePercent >= 80 ? "写入紧张" : "写充足") : "";
  const bothOk = usage && usage.readPercent < 80 && usage.writePercent < 80;

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Database className="h-4 w-4 text-emerald-600" aria-hidden />
            D1 数据库配额
          </h2>
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
            D1 精确计量
          </span>
          {usage?.ok ? (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {usage.dateUTC} (UTC)
            </span>
          ) : null}
          {usage?.ok && bothOk ? (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
              读充足 · 写充足
            </span>
          ) : null}
          {usage?.ok && !bothOk ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">
              <span className={readTone?.text}>{readStatus}</span>
              {" · "}
              <span className={writeTone?.text}>{writeStatus}</span>
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="text-[11px] leading-tight text-muted-foreground">UTC 午夜重置</p>
            {usage?.ok && countdown ? (
              <p className="text-xs font-semibold leading-tight">{countdown}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新 D1 用量"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {loading && !usage ? (
        <div className="space-y-3 py-1">
          <div className="h-2 w-full animate-pulse rounded-full bg-muted" />
          <div className="h-2 w-full animate-pulse rounded-full bg-muted" />
        </div>
      ) : failed ? (
        <p className="text-sm text-red-600">{failed}</p>
      ) : usage && !usage.configured ? (
        <div className="space-y-1.5 text-sm">
          <p className="text-muted-foreground">{usage.error}</p>
          <p className="text-xs text-muted-foreground">
            部署时 CI 自动注入 CLOUDFLARE_API_TOKEN 等环境变量（Token 需含 Account Analytics:Read
            权限）；也可在{" "}
            <Link href="/admin/settings" className="text-primary hover:underline">
              系统设置 → BOT 数据存储
            </Link>{" "}
            手动配置兜底。
          </p>
        </div>
      ) : usage && usage.ok ? (
        <div className="space-y-4">
          <UsageBar
            label="今日读取行数"
            used={usage.rowsRead}
            limit={usage.limits.rowsRead}
            queries={usage.readQueries}
            queryLabel="读查询"
          />
          <UsageBar
            label="今日写入行数"
            used={usage.rowsWritten}
            limit={usage.limits.rowsWritten}
            queries={usage.writeQueries}
            queryLabel="写查询"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            数据来自 Cloudflare GraphQL Analytics（5 分钟缓存）
            {sourceLabel ? ` · 凭据来源：${sourceLabel}` : ""}
            {usage.accountWide ? " · 统计账户下全部 D1 数据库" : ""}
          </p>
        </div>
      ) : usage ? (
        <p className="text-sm text-red-600">{usage.error}</p>
      ) : null}
    </div>
  );
}
