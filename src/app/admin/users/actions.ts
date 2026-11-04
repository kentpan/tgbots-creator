"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createAdminUser,
  deleteAdminUser,
  updateAdminUser,
} from "@/database/operations";
import { hashPassword } from "@/lib/password";
import { logOperation, requirePermission } from "@/lib/auth";

export async function saveUserAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("users:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const username = String(formData.get("username") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const roleIdRaw = String(formData.get("role_id") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!/^\d+$/.test(roleIdRaw)) redirect("/admin/users?error=role-required");

  if (idRaw && /^\d+$/.test(idRaw)) {
    const fields: Parameters<typeof updateAdminUser>[1] = {
      displayName: displayName || null,
      roleId: BigInt(roleIdRaw),
      status: String(formData.get("status") ?? "active") === "disabled" ? "disabled" : "active",
    };
    if (password) {
      if (password.length < 6) redirect("/admin/users?error=password-short");
      fields.passwordHash = await hashPassword(password);
    }
    await updateAdminUser(BigInt(idRaw), fields);
    await logOperation(admin, {
      action: "更新系统用户",
      target: `#${idRaw} ${username}`,
      headers: await headers(),
    });
  } else {
    if (!username || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      redirect("/admin/users?error=invalid-username");
    }
    if (password.length < 6) redirect("/admin/users?error=password-short");
    await createAdminUser({
      username,
      passwordHash: await hashPassword(password),
      displayName: displayName || null,
      roleId: BigInt(roleIdRaw),
    });
    await logOperation(admin, {
      action: "创建系统用户",
      target: username,
      headers: await headers(),
    });
  }
  revalidatePath("/admin/users");
  redirect("/admin/users?saved=1");
}

export async function deleteUserAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("users:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect("/admin/users?error=invalid-id");

  const ok = await deleteAdminUser(BigInt(idRaw));
  if (!ok) redirect("/admin/users?error=builtin-user");
  await logOperation(admin, {
    action: "删除系统用户",
    target: `#${idRaw}`,
    headers: await headers(),
  });
  revalidatePath("/admin/users");
  redirect("/admin/users?saved=deleted");
}
