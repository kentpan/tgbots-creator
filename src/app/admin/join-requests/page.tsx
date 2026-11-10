import Link from "next/link";
import { listJoinRequests, RequestStatus } from "@/database/operations";
import { formatBeijingDateTime } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import {
  approveJoinRequestAction,
  rejectJoinRequestAction,
} from "./actions";
import { SubmitButton } from "@/components/admin/submit-button";

export const dynamic = "force-dynamic";

// v2.0.13：时间展示统一北京时间（Asia/Shanghai）—— 服务器/Edge 运行时时区为 UTC，
// 原本地时区拼接导致线上「申请时间不是北京时间」，改用显式时区工具函数
function formatDateTime(date: Date | null): string {
  return formatBeijingDateTime(date);
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

const NOTICES: Record<string, string> = {
  approved: "已批准该加群申请",
  rejected: "已拒绝该加群申请",
};

const ERRORS: Record<string, string> = {
  "missing-token": "缺少申请标识",
  "approve-failed": "批准操作失败，请重试",
  "reject-failed": "拒绝操作失败，请重试",
};

export default async function JoinRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; requestType?: string; page?: string; saved?: string; error?: string }>;
}) {
  await requirePermission("requests:view");
  const params = await searchParams;
  const status = params.status && Object.values(RequestStatus).includes(params.status as never)
    ? params.status
    : undefined;
  const requestType = params.requestType === "telegram" || params.requestType === "api"
    ? params.requestType
    : undefined;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const { rows, total } = await listJoinRequests({ status, requestType, page, pageSize: 20 });
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const buildPageUrl = (targetPage: number): string => {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (requestType) search.set("requestType", requestType);
    search.set("page", String(targetPage));
    return `/admin/join-requests?${search.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">加群申请</h1>
        <p className="text-sm text-muted-foreground">
          共 {total} 条记录。待处理申请可手动批准或拒绝。
        </p>
      </div>

      {params.saved && NOTICES[params.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[params.saved]}
        </div>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[params.error]}
        </div>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="space-y-1">
          <label htmlFor="status" className="block text-sm font-medium">
            状态
          </label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ""}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">全部状态</option>
            <option value="pending">待处理</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
            <option value="expired">已过期</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="requestType" className="block text-sm font-medium">
            来源类型
          </label>
          <select
            id="requestType"
            name="requestType"
            defaultValue={requestType ?? ""}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">全部来源</option>
            <option value="telegram">Telegram 群组</option>
            <option value="api">外部 API</option>
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          筛选
        </button>
      </form>

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">用户</th>
                <th className="px-4 py-3 font-medium">群组</th>
                <th className="px-4 py-3 font-medium">来源</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">申请时间</th>
                <th className="px-4 py-3 font-medium">处理时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    没有符合条件的申请记录
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={String(row.id)} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm font-mono">{String(row.id)}</td>
                    <td className="px-4 py-3 text-sm">
                      <div>{row.username ? `@${row.username}` : row.firstName || "匿名用户"}</div>
                      <div className="font-mono text-sm text-muted-foreground">
                        {String(row.userId)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono">{String(row.chatId)}</td>
                    <td className="px-4 py-3 text-sm">
                      {row.requestType === "api" ? "外部 API" : "Telegram"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                          STATUS_BADGES[row.status] ?? "border-gray-200 text-gray-600"
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDateTime(row.requestTime)}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDateTime(row.processedTime)}
                    </td>
                    <td className="px-4 py-3">
                      {row.status === "pending" ? (
                        <div className="flex items-center gap-2">
                          <form action={approveJoinRequestAction}>
                            <input type="hidden" name="token" value={row.verificationToken} />
                            <SubmitButton
                              className="inline-flex h-8 items-center rounded-md bg-green-600 px-3 text-sm font-medium text-white hover:bg-green-700"
                              pendingLabel="批准中…"
                            >
                              批准
                            </SubmitButton>
                          </form>
                          <form action={rejectJoinRequestAction}>
                            <input type="hidden" name="token" value={row.verificationToken} />
                            <SubmitButton
                              className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                              pendingLabel="拒绝中…"
                            >
                              拒绝
                            </SubmitButton>
                          </form>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">已处理</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link
              href={buildPageUrl(page - 1)}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
            >
              上一页
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link
              href={buildPageUrl(page + 1)}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
            >
              下一页
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
