"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createRole,
  deleteRole,
  getRolePermissionCodes,
  setRolePermissions,
  updateRole,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

export async function saveRoleAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("roles:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const permissions = formData.getAll("permissions").map((value) => String(value));

  if (!code || !/^[a-z0-9_]{2,32}$/.test(code)) {
    redirect("/admin/roles?error=invalid-code");
  }
  if (!name) redirect("/admin/roles?error=name-required");

  let roleId: bigint;
  if (idRaw && /^\d+$/.test(idRaw)) {
    const updated = await updateRole(BigInt(idRaw), { code, name, description: description || null });
    if (!updated) redirect("/admin/roles?error=builtin-role");
    roleId = BigInt(idRaw);
    await logOperation(admin, {
      action: "更新角色",
      target: `${code}（${name}）`,
      detail: `权限 ${permissions.length} 项`,
      headers: await headers(),
    });
  } else {
    const created = await createRole({ code, name, description: description || null });
    if (!created) redirect("/admin/roles?error=duplicate-code");
    roleId = created.id;
    await logOperation(admin, {
      action: "创建角色",
      target: `${code}（${name}）`,
      detail: `权限 ${permissions.length} 项`,
      headers: await headers(),
    });
  }
  await setRolePermissions(roleId, permissions);
  revalidatePath("/admin/roles");
  redirect("/admin/roles?saved=1");
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("roles:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect("/admin/roles?error=invalid-id");

  const before = await getRolePermissionCodes(BigInt(idRaw));
  void before;
  const ok = await deleteRole(BigInt(idRaw));
  if (!ok) redirect("/admin/roles?error=builtin-role");
  await logOperation(admin, {
    action: "删除角色",
    target: `#${idRaw}`,
    headers: await headers(),
  });
  revalidatePath("/admin/roles");
  redirect("/admin/roles?saved=deleted");
}
