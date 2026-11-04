"use client";

import { useCallback, useEffect, useState } from "react";
import { AiUsageCharts, type AiUsageStatsData } from "@/components/admin/ai-usage-charts";

/** AI 调用统计 tab：时间范围切换 + chart.js 图表 */
export function AiUsageTab() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<AiUsageStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/ai/usage?days=${range}`);
      const payload = (await response.json()) as { ok: boolean; data?: AiUsageStatsData; error?: string };
      if (payload.ok && payload.data) {
        setStats(payload.data);
      } else {
        setError(payload.error ?? "加载失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
    const timer = setInterval(() => void load(days), 30000);
    return () => clearInterval(timer);
  }, [days, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">统计范围</span>
          {[7, 14, 30].map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setDays(range)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                days === range ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              }`}
            >
              近 {range} 天
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load(days)}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
        >
          刷新
        </button>
      </div>

      {loading && !stats ? (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed">
          <p className="text-sm text-muted-foreground">加载统计数据…</p>
        </div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : stats ? (
        <AiUsageCharts stats={stats} />
      ) : null}
    </div>
  );
}
