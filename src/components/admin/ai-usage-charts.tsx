"use client";

import { useMemo } from "react";
import type { ChartData, ChartOptions } from "chart.js";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Bar, Chart, Doughnut } from "react-chartjs-2";

/**
 * AI 调用统计图表（chart.js + react-chartjs-2）
 * - 每日调用趋势（柱状：成功/失败）
 * - 模型调用分布（环形）
 * - 提供方/场景分布（横向条形）
 */

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, LineElement, PointElement, Tooltip, Legend, Filler);

export interface AiUsageStatsData {
  summary: {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  };
  byDay: { day: string; total: number; success: number; failed: number; tokens: number }[];
  byModel: { model: string; total: number; tokens: number }[];
  byProvider: { provider: string; total: number; tokens: number }[];
  byScene: { scene: string; total: number; tokens: number }[];
  recentErrors: { model: string; error: string; created_time: string }[];
}

const CHART_COLORS = [
  "#16a34a",
  "#0d9488",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#65a30d",
  "#db2777",
  "#4b5563",
];

export function AiUsageCharts({ stats }: { stats: AiUsageStatsData }) {
  const dayLabels = useMemo(() => stats.byDay.map((entry) => entry.day.slice(5)), [stats.byDay]);

  const trendData = useMemo(
    () =>
      ({
      labels: dayLabels,
      datasets: [
        {
          label: "成功",
          data: stats.byDay.map((entry) => entry.success),
          backgroundColor: "#16a34a",
          borderRadius: 4,
          stack: "calls",
        },
        {
          label: "失败",
          data: stats.byDay.map((entry) => entry.failed),
          backgroundColor: "#dc2626",
          borderRadius: 4,
          stack: "calls",
        },
        {
          label: "Tokens",
          data: stats.byDay.map((entry) => entry.tokens),
          type: "line" as const,
          borderColor: "#0d9488",
          backgroundColor: "rgba(13, 148, 136, 0.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 2,
          yAxisID: "y1",
        },
      ],
      }) as unknown as ChartData<"bar" | "line", number[], string>,
    [stats.byDay, dayLabels],
  );

  const trendOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index" as const, intersect: false },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, stacked: true, ticks: { precision: 0 }, title: { display: true, text: "调用次数" } },
        y1: {
          beginAtZero: true,
          position: "right" as const,
          grid: { drawOnChartArea: false },
          title: { display: true, text: "Tokens" },
        },
      },
      plugins: { legend: { position: "bottom" as const } },
    }),
    [],
  );

  const modelData = useMemo(() => {
    const top = stats.byModel.slice(0, 8);
    const rest = stats.byModel.slice(8).reduce((sum, entry) => sum + entry.total, 0);
    const labels = top.map((entry) => entry.model);
    const values = top.map((entry) => entry.total);
    if (rest > 0) {
      labels.push("其他");
      values.push(rest);
    }
    return {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: labels.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]),
          borderWidth: 0,
        },
      ],
    };
  }, [stats.byModel]);

  const modelOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "58%",
      plugins: { legend: { position: "bottom" as const, labels: { boxWidth: 12 } } },
    }),
    [],
  );

  const sceneData = useMemo(() => {
    const scenes = stats.byScene.slice(0, 6);
    return {
      labels: scenes.map((entry) => entry.scene),
      datasets: [
        {
          label: "调用次数",
          data: scenes.map((entry) => entry.total),
          backgroundColor: "#0d9488",
          borderRadius: 4,
        },
      ],
    };
  }, [stats.byScene]);

  const sceneOptions = useMemo(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
      plugins: { legend: { display: false } },
    }),
    [],
  );

  if (stats.summary.total === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
        <span className="text-3xl">📈</span>
        <p className="text-sm font-medium">暂无调用数据</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          通过 AI 提供方的「测试」按钮或机器人 AI 客服发起调用后，这里会展示趋势图表。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">总调用</p>
          <p className="text-2xl font-bold">{stats.summary.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">成功率</p>
          <p className="text-2xl font-bold">{stats.summary.successRate}%</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Tokens 总量</p>
          <p className="text-2xl font-bold">{stats.summary.totalTokens.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">平均耗时</p>
          <p className="text-2xl font-bold">{stats.summary.avgDurationMs}ms</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold">每日调用趋势</h3>
          <div className="h-64">
            <Chart
              type="bar"
              data={trendData}
              options={trendOptions as unknown as ChartOptions<"bar" | "line">}
            />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">模型调用分布</h3>
          <div className="h-64">
            <Doughnut data={modelData} options={modelOptions} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">调用场景分布</h3>
          <div className="h-56">
            <Bar data={sceneData} options={sceneOptions} />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold">提供方调用量</h3>
          {stats.byProvider.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无数据</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {stats.byProvider.map((entry) => (
                <div key={entry.provider} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{entry.provider}</span>
                  <span className="text-muted-foreground">
                    {entry.total} 次 · {entry.tokens.toLocaleString()} tokens
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {stats.recentErrors.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
          <h3 className="mb-2 text-sm font-semibold text-red-700 dark:text-red-400">最近失败调用（{stats.recentErrors.length}）</h3>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {stats.recentErrors.map((entry, index) => (
              <p key={index} className="truncate text-xs text-red-600 dark:text-red-300" title={entry.error}>
                <span className="font-mono">[{entry.created_time.slice(5, 16)}] {entry.model || "?"}</span> — {entry.error}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
