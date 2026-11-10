import {
  getRolePermissionCodes,
  listMenus,
  listPermissions,
  listRoles,
  type RoleRow,
} from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { deleteRoleAction } from "./actions";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { RoleFormDialog, type PermissionTreeMenu } from "./role-form-dialog";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "角色已保存",
  deleted: "角色已删除",
};

const ERRORS: Record<string, string> = {
  "invalid-code": "角色编码需为 2-32 位小写字母数字下划线",
  "name-required": "请填写角色名称",
  "builtin-role": "内置角色不允许修改或删除",
  "duplicate-code": "角色编码已存在",
  "invalid-id": "角色不存在",
};

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requirePermission("roles:view");
  const params = await searchParams;
  const [roles, permissions, menus] = await Promise.all([
    listRoles(),
    listPermissions(),
    listMenus(),
  ]);
  const roleCodes = await Promise.all(
    roles.map((role) => getRolePermissionCodes(role.id)),
  );
  const checkedByRole = new Map(
    roles.map((role, index) => [String(role.id), roleCodes[index]] as const),
  );

  const permissionOptions = permissions.map((permission) => ({
    code: permission.code,
    name: permission.name,
    description: permission.description,
  }));

  const tree: PermissionTreeMenu[] = menus
    .filter((menu) => menu.parentId === 0n)
    .map((menu) => ({
      id: String(menu.id),
      title: menu.title,
      path: menu.path,
      permissionCode: menu.permissionCode,
      children: menus
        .filter((child) => child.parentId === menu.id)
        .map((child) => ({
          id: String(child.id),
          title: child.title,
          path: child.path,
          permissionCode: child.permissionCode,
          children: [],
        })),
    }));

  const roleTriggerClass = "inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">角色权限</h1>
          <p className="text-sm text-muted-foreground">
            RBAC 角色：超级管理员在代码层拥有全部权限；其他角色按树状菜单勾选权限点访问菜单与接口。
          </p>
        </div>
        <RoleFormDialog
          tree={tree}
          permissions={permissionOptions}
          trigger="+ 新增角色"
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
                <th className="px-4 py-3 font-medium">编码</th>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">描述</th>
                <th className="px-4 py-3 font-medium">类型</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role: RoleRow) => (
                <tr key={String(role.id)} className="border-b last:border-0">
                  <td className="px-4 py-3 text-sm font-mono">{String(role.id)}</td>
                  <td className="px-4 py-3 font-mono text-sm">{role.code}</td>
                  <td className="px-4 py-3 text-sm font-medium">{role.name}</td>
                  <td className="px-4 py-3 text-sm">{role.description ?? "-"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                        role.isBuiltin
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-gray-200 bg-gray-50 text-gray-500"
                      }`}
                    >
                      {role.isBuiltin ? "内置" : "自定义"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <RoleFormDialog
                        role={{
                          id: String(role.id),
                          code: role.code,
                          name: role.name,
                          description: role.description,
                          isBuiltin: role.isBuiltin,
                          checkedCodes: checkedByRole.get(String(role.id)) ?? [],
                        }}
                        tree={tree}
                        permissions={permissionOptions}
                        trigger="编辑"
                        triggerClassName={roleTriggerClass}
                      />
                      {!role.isBuiltin ? (
                        <ConfirmDialog
                          title={`删除角色「${role.name}」`}
                          description={`确定要删除角色「${role.name}」吗？该角色关联的管理员将失去对应权限，删除后不可恢复！`}
                          action={deleteRoleAction}
                          fields={{ id: String(role.id) }}
                          trigger="删除"
                          triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                        />
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
