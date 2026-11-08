import { listAdminUsers, listRoles, type AdminUserRow } from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
import { deleteUserAction, saveUserAction } from "./actions";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "用户已保存",
  deleted: "用户已删除",
};

const ERRORS: Record<string, string> = {
  "invalid-username": "用户名需为 3-32 位字母数字下划线或短横线",
  "password-short": "密码至少 6 位",
  "role-required": "请选择角色",
  "invalid-id": "用户不存在",
  "builtin-user": "内置超级管理员账号不允许删除",
};

// v2.0.13：时间展示统一北京时间（服务器/Edge 运行时时区为 UTC）
function formatDateTime(date: Date | null): string {
  return formatBeijingDateTimeMinute(date);
}

function UserFormDialog({
  roles,
  user,
  trigger,
  triggerClassName,
}: {
  roles: { id: string; name: string; code: string }[];
  user?: AdminUserRow;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={user ? `编辑用户 · ${user.username}` : "新增用户"}
      description="后台登录账号，密码使用 PBKDF2-SHA256 加盐散列存储。"
      action={saveUserAction}
      submitLabel="保存用户"
    >
      <input type="hidden" name="id" value={user ? String(user.id) : ""} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`username-${user?.id ?? "new"}`}>
            用户名 {user ? "（不可修改）" : "*"}
          </label>
          <input
            id={`username-${user?.id ?? "new"}`}
            name="username"
            type="text"
            required={!user}
            readOnly={Boolean(user)}
            defaultValue={user?.username ?? ""}
            className={`${inputClass} ${user ? "disabled:opacity-60" : ""}`}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`display-${user?.id ?? "new"}`}>
            显示名
          </label>
          <input
            id={`display-${user?.id ?? "new"}`}
            name="display_name"
            type="text"
            defaultValue={user?.displayName ?? ""}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`password-${user?.id ?? "new"}`}>
            {user ? "重置密码（留空表示不修改）" : "密码 *"}
          </label>
          <input
            id={`password-${user?.id ?? "new"}`}
            name="password"
            type="password"
            minLength={user ? 0 : 6}
            required={!user}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`role-${user?.id ?? "new"}`}>
            角色 *
          </label>
          <select
            id={`role-${user?.id ?? "new"}`}
            name="role_id"
            required
            defaultValue={user ? String(user.roleId) : ""}
            className={selectClass}
          >
            <option value="" disabled>
              请选择角色
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}（{role.code}）
              </option>
            ))}
          </select>
        </div>
        {user ? (
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`status-${user.id}`}>
              状态
            </label>
            <select id={`status-${user.id}`} name="status" defaultValue={user.status} className={selectClass}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requirePermission("users:view");
  const params = await searchParams;
  const [users, roles] = await Promise.all([listAdminUsers(), listRoles()]);
  const roleOptions = roles.map((role) => ({
    id: String(role.id),
    name: role.name,
    code: role.code,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">系统用户</h1>
          <p className="text-sm text-muted-foreground">
            管理后台登录账号，密码使用 PBKDF2-SHA256 加盐散列存储。
          </p>
        </div>
        <UserFormDialog
          roles={roleOptions}
          trigger="+ 新增用户"
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
                <th className="px-4 py-3 font-medium">用户名</th>
                <th className="px-4 py-3 font-medium">显示名</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">最后登录</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={String(user.id)} className="border-b last:border-0">
                  <td className="px-4 py-3 text-sm font-mono">{String(user.id)}</td>
                  <td className="px-4 py-3 text-sm font-medium">{user.username}</td>
                  <td className="px-4 py-3 text-sm">{user.displayName ?? "-"}</td>
                  <td className="px-4 py-3 text-sm">{user.roleName || "-"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                        user.status === "active"
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-gray-200 bg-gray-50 text-gray-500"
                      }`}
                    >
                      {user.status === "active" ? "启用" : "停用"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDateTime(user.lastLoginTime)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <UserFormDialog
                        roles={roleOptions}
                        user={user}
                        trigger="编辑"
                        triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                      />
                      {user.username !== "admin" ? (
                        <form action={deleteUserAction}>
                          <input type="hidden" name="id" value={String(user.id)} />
                          <button
                            type="submit"
                            className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                          >
                            删除
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
