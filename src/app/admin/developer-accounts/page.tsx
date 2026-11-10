import { listDeveloperAccounts } from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { deleteDeveloperAccountAction, saveDeveloperAccountAction } from "./actions";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "开发者账号已保存",
  deleted: "开发者账号已删除",
};

const ERRORS: Record<string, string> = {
  "field-required": "手机号、api_id、api_hash 均为必填",
  "invalid-api-id": "api_id 必须是纯数字",
  "invalid-id": "开发者账号不存在",
};

interface AccountRecord {
  id: string;
  phone: string;
  apiId: string;
  apiHash: string;
  remark: string | null;
}

function AccountFormDialog({
  account,
  trigger,
  triggerClassName,
}: {
  account?: AccountRecord;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={account ? "编辑开发者账号" : "新增开发者账号"}
      description="在 my.telegram.org → API development tools 申请 api_id 与 api_hash，用于 MTProto 客户端开发。"
      action={saveDeveloperAccountAction}
      submitLabel="保存账号"
    >
      <input type="hidden" name="id" value={account?.id ?? ""} />
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className={labelClass} htmlFor={`phone-${account?.id ?? "new"}`}>
            手机号 *
          </label>
          <input
            id={`phone-${account?.id ?? "new"}`}
            name="phone"
            required
            defaultValue={account?.phone ?? ""}
            placeholder="+8613800000000"
            className={`h-11 text-base ${inputClass}`}
          />
        </div>
        <div className="space-y-1.5">
          <label className={labelClass} htmlFor={`api-id-${account?.id ?? "new"}`}>
            api_id *
          </label>
          <input
            id={`api-id-${account?.id ?? "new"}`}
            name="api_id"
            required
            inputMode="numeric"
            defaultValue={account?.apiId ?? ""}
            placeholder="1234567"
            className={`h-11 text-base font-mono tracking-wide ${inputClass}`}
          />
        </div>
        <div className="space-y-1.5">
          <label className={labelClass} htmlFor={`api-hash-${account?.id ?? "new"}`}>
            api_hash *
          </label>
          <input
            id={`api-hash-${account?.id ?? "new"}`}
            name="api_hash"
            required
            defaultValue={account?.apiHash ?? ""}
            placeholder="0123456789abcdef0123456789abcdef"
            className={`h-11 text-base font-mono tracking-wide ${inputClass}`}
          />
        </div>
        <div className="space-y-1.5">
          <label className={labelClass} htmlFor={`remark-${account?.id ?? "new"}`}>
            备注
          </label>
          <input
            id={`remark-${account?.id ?? "new"}`}
            name="remark"
            defaultValue={account?.remark ?? ""}
            placeholder="账号用途说明"
            className={`h-11 ${inputClass}`}
          />
        </div>
      </div>
    </FormDialog>
  );
}

export default async function DeveloperAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requirePermission("devaccounts:view");
  const params = await searchParams;
  const accounts = await listDeveloperAccounts();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">开发者账号</h1>
          <p className="text-sm text-muted-foreground">
            维护 Telegram 开发者账号（手机号 + api_id + api_hash），供 MTProto 用户端开发与登录使用。
          </p>
        </div>
        <AccountFormDialog
          trigger="+ 新增账号"
          triggerClassName="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        />
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

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">手机号</th>
                <th className="px-4 py-3 font-medium">api_id</th>
                <th className="px-4 py-3 font-medium">api_hash</th>
                <th className="px-4 py-3 font-medium">备注</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有开发者账号，点击右上角「新增账号」录入
                  </td>
                </tr>
              ) : (
                accounts.map((account) => (
                  <tr key={account.id} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm font-mono">{String(account.id)}</td>
                    <td className="px-4 py-3 text-sm font-medium">{account.phone}</td>
                    <td className="px-4 py-3 font-mono text-sm">{account.apiId}</td>
                    <td className="px-4 py-3 font-mono text-sm text-muted-foreground">
                      {account.apiHash.slice(0, 8)}••••{account.apiHash.slice(-4)}
                    </td>
                    <td className="px-4 py-3 text-sm">{account.remark ?? "-"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <AccountFormDialog
                          account={{
                            id: String(account.id),
                            phone: account.phone,
                            apiId: account.apiId,
                            apiHash: account.apiHash,
                            remark: account.remark,
                          }}
                          trigger="编辑"
                          triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                        />
                        <ConfirmDialog
                          title={`删除开发者账号「${account.remark || account.phone}」`}
                          description={`确定要删除开发者账号「${account.remark || account.phone}」吗？删除后不可恢复！`}
                          action={deleteDeveloperAccountAction}
                          fields={{ id: String(account.id) }}
                          trigger="删除"
                          triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                        />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
