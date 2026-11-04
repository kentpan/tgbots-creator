import Link from "next/link";
import { listOperationLogs } from "@/database/operations";
import { requirePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requirePermission("logs:view");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const { rows, total } = await listOperationLogs({ page, pageSize: 20 });
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">操作日志</h1>
        <p className="text-sm text-muted-foreground">共 {total} 条后台操作审计记录。</p>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">操作人</th>
                <th className="px-4 py-3 font-medium">动作</th>
                <th className="px-4 py-3 font-medium">对象</th>
                <th className="px-4 py-3 font-medium">详情</th>
                <th className="px-4 py-3 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无操作日志
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={String(row.id)} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm font-mono">{String(row.id)}</td>
                    <td className="px-4 py-3 text-sm">
                      {row.adminUsername ?? (row.adminId ? `#${String(row.adminId)}` : "-")}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">{row.action}</td>
                    <td className="max-w-48 truncate px-4 py-3 text-sm" title={row.target ?? ""}>
                      {row.target ?? "-"}
                    </td>
                    <td className="max-w-64 truncate px-4 py-3 text-sm" title={row.detail ?? ""}>
                      {row.detail ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDateTime(row.createdTime)}
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
              href={`/admin/logs?page=${page - 1}`}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-accent"
            >
              上一页
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link
              href={`/admin/logs?page=${page + 1}`}
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
