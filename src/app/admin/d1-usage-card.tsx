"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { D1DailyUsage } from "@/services/d1-metrics";

/**
 * Dashboard 核心指标卡片 —— D1 每日读写用量（v2.0.7）。
 * 客户端懒加载 /api/admin/dashboard/d1-metrics（服务端 5 分钟缓存聚合），
 * 不阻塞控制台 RSC 首屏；未配置/权限不足时优雅降级展示原因。
 */

function formatRows(value: number): string {
  return value.toLocaleString("en-US");
}

function usageTone(percent: number): { bar: string; text: string } {
  if (percent >= 100) return { bar: "bg-red-500", text: "text-red-600" };
  if (percent >= 80) return { bar: "bg-amber-500", text: "text-amber-600" };
  return { bar: "bg-emerald-500", text: "text-emerald-600" };
}

function UsageBar({
  label,
  used,
  limit,
  queries,
}: {
  label: string;
  used: number;
  limit: number;
  queries: number;
}) {
  const percent = limit > 0 ? Math.min(999, Math.round((used / limit) * 1000) / 10) : 0;
  const tone = usageTone(percent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {label}
          <span className="ml-2 text-xs text-muted-foreground/70">
            {formatRows(queries)} 次查询
          </span>
        </span>
        <span className={`font-medium ${tone.text}`}>{percent}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${Math.max(percent > 0 ? 2 : 0, Math.min(100, percent))}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-mono">{formatRows(used)} 行</span>
        <span>限额 {formatRows(limit)} 行/天（UTC 重置）</span>
      </div>
    </div>
  );
}

export function D1UsageCard() {
  const [usage, setUsage] = useState<D1DailyUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

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

  const sourceLabel = usage?.source
    ? usage.source.apiToken === "stored" || usage.source.accountId === "stored"
      ? "后台配置"
      : usage.source.apiToken === "env-default" || usage.source.accountId === "env-default"
        ? "部署默认值"
        : null
    : null;

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          D1 每日读写用量
          {usage?.ok ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {usage.dateUTC} (UTC)
              {sourceLabel ? ` · ${sourceLabel}` : ""}
            </span>
          ) : null}
        </h2>
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
            可在{" "}
            <Link href="/admin/settings" className="text-primary hover:underline">
              系统设置 → BOT 数据存储
            </Link>{" "}
            配置 Cloudflare D1（未填字段自动使用部署默认值）。
          </p>
        </div>
      ) : usage && usage.ok ? (
        <div className="space-y-4">
          <UsageBar label="读取" used={usage.rowsRead} limit={usage.limits.rowsRead} queries={usage.readQueries} />
          <UsageBar label="写入" used={usage.rowsWritten} limit={usage.limits.rowsWritten} queries={usage.writeQueries} />
        </div>
      ) : usage ? (
        <p className="text-sm text-red-600">{usage.error}</p>
      ) : null}
    </div>
  );
}
