import Link from "next/link";
import {
  getDatabaseInfo,
} from "@/database/client";
import { getKv, getStorage } from "@/database/bindings";
import { getD1Usage } from "@/database/d1-metrics";
import {
  getGlobalStats,
  listJoinRequests,
} from "@/database/operations";
import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const STATUS_BADGES: Record<string, string> = {
  pending: "bg-yellow-50 text-yellow-700 border-yellow-200",
  approved: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  expired: "bg-gray-100 text-gray-600 border-gray-200",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  approved: "已通过",
  rejected: "已拒绝",
  expired: "已过期",
};

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const admin = await requirePermission("dashboard:view");
  const { denied } = await searchParams;

  const [stats, recent, dbInfo] = await Promise.all([
    getGlobalStats(),
    listJoinRequests({ pageSize: 8, page: 1 }),
    getDatabaseInfo(),
  ]);

  const kvKind = getKv().kind;
  const storageKind = getStorage().kind;
  // v2.2.0：D1 免费额度（500 万行读/天）用量看板 —— 事故后一眼可见「还剩多少」
  const d1Usage = getD1Usage();
  const readPercent = Math.min(100, d1Usage.readPercent);
  const usageTone =
    readPercent >= 80
      ? "text-red-600"
      : readPercent >= 60
        ? "text-amber-600"
        : "text-muted-foreground";

  const cards = [
    { label: "总验证请求", value: stats?.total_requests ?? 0, icon: "📈" },
    { label: "已通过", value: stats?.approved ?? 0, icon: "✅" },
    { label: "已拒绝", value: stats?.rejected ?? 0, icon: "⛔" },
    { label: "待处理", value: stats?.pending ?? 0, icon: "⏳" },
    { label: "已过期", value: stats?.expired ?? 0, icon: "🕒" },
    {
      label: "通过率",
      value: `${(stats?.approval_rate ?? 0).toFixed(1)}%`,
      icon: "🎯",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">控制台</h1>
        <p className="text-sm text-muted-foreground">
          欢迎回来，{admin.user.displayName ?? admin.user.username}。这里是 TGuard 验证服务的整体运行情况。
        </p>
      </div>

      {denied ? (
        <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700">
          权限不足：当前角色没有 <span className="font-mono">{denied}</span> 权限，请联系超级管理员分配。
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{card.label}</span>
              <span>{card.icon}</span>
            </div>
            <p className="mt-2 text-2xl font-bold">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border bg-card p-4 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">最新加群申请</h2>
            <Link
              href="/admin/join-requests"
              className="text-sm text-primary hover:underline"
            >
              查看全部
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="pb-2 font-medium">用户</th>
                  <th className="pb-2 font-medium">群组 Chat ID</th>
                  <th className="pb-2 font-medium">状态</th>
                  <th className="pb-2 font-medium">申请时间</th>
                </tr>
              </thead>
              <tbody>
                {recent.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                      暂无加群申请记录
                    </td>
                  </tr>
                ) : (
                  recent.rows.map((row) => (
                    <tr key={String(row.id)} className="border-b last:border-0">
                      <td className="py-2 text-sm">
                        {row.username ? `@${row.username}` : row.firstName || "匿名用户"}
                        <span className="ml-1 text-muted-foreground">({String(row.userId)})</span>
                      </td>
                      <td className="py-2 text-sm font-mono">{String(row.chatId)}</td>
                      <td className="py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                            STATUS_BADGES[row.status] ?? "border-gray-200 text-gray-600"
                          }`}
                        >
                          {STATUS_LABELS[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="py-2 text-sm text-muted-foreground">
                        {formatDateTime(row.requestTime)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">今日统计</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日请求</span>
                <span className="font-medium">{stats?.today_total ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日通过</span>
                <span className="font-medium">{stats?.today_approved ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日通过率</span>
                <span className="font-medium">
                  {(stats?.today_approval_rate ?? 0).toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">D1 读取额度（本实例）</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日已读</span>
                <span className={`font-medium ${usageTone}`}>
                  {d1Usage.rowsRead.toLocaleString()} 行
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${readPercent >= 80 ? "bg-red-500" : readPercent >= 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${readPercent}%` }}
                />
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>免费额度占比</span>
                <span>
                  {readPercent.toFixed(2)}% / 上限{" "}
                  {Math.round(d1Usage.readLimitFree / 10_000)} 万行
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日已写</span>
                <span className="font-medium">
                  {d1Usage.rowsWritten.toLocaleString()} 行
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">读缓存命中率</span>
                <span className="font-medium">{d1Usage.cacheHitRate.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">省电模式</span>
                <span className="font-medium">
                  {d1Usage.frugalMode ? "已开启（缓存 TTL ×6）" : "未开启"}
                </span>
              </div>
              <p className="pt-1 text-sm text-muted-foreground">
                计量为 isolate 维度，仅供归因；完整排行见{" "}
                <Link href="/api/admin/diagnostics/d1" className="text-primary hover:underline">
                  /api/admin/diagnostics/d1
                </Link>
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">运行环境</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">SQL 数据层</span>
                <span className="font-medium">
                  {dbInfo.kind === "d1" ? "Cloudflare D1" : "node:sqlite"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">数据库路径</span>
                <span className="max-w-40 truncate font-mono text-right" title={dbInfo.displayPath}>
                  {dbInfo.displayPath}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">KV 缓存</span>
                <span className="font-medium">
                  {kvKind === "cloudflare" ? "Cloudflare KV" : "内存缓存"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">对象存储</span>
                <span className="font-medium">
                  {storageKind === "cloudflare-r2" ? "Cloudflare R2" : "本地存储"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
