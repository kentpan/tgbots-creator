"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createMenu,
  getMenu,
  listMenus,
  deleteMenu,
  updateMenu,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import {
  MENU_PERMISSION_MANAGE,
  MENU_PERMISSION_VIEW,
} from "@/lib/menu-permissions";

const MENU_PERMISSION_WHITELIST = new Set<string>([MENU_PERMISSION_VIEW, MENU_PERMISSION_MANAGE]);

export async function saveMenuAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("menus:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const path = String(formData.get("path") ?? "").trim();
  const icon = String(formData.get("icon") ?? "").trim();
  const parentIdRaw = String(formData.get("parent_id") ?? "0").trim();
  const sortOrder = Number(formData.get("sort_order") ?? "0");
  const permissionRaw = String(formData.get("permission_code") ?? "").trim();
  const visible = formData.get("visible") === "1";
  const status = String(formData.get("status") ?? "1") === "0" ? 0 : 1;

  if (!title) redirect("/admin/menus?error=title-required");
  if (path && !path.startsWith("/")) redirect("/admin/menus?error=invalid-path");

  // 权限码白名单：菜单权限只允许 读取 / 编辑 两档（从源头约束）
  const permissionCode = MENU_PERMISSION_WHITELIST.has(permissionRaw) ? permissionRaw : null;
  const finalPath = path || "";
  const parentId = /^\d+$/.test(parentIdRaw) ? BigInt(parentIdRaw) : 0n;
  const selfId = idRaw && /^\d+$/.test(idRaw) ? BigInt(idRaw) : null;

  // 上级菜单必须存在，且不能是自己或自己的后代（防循环层级）
  if (parentId !== 0n) {
    if (selfId !== null && parentId === selfId) {
      redirect("/admin/menus?error=cycle-parent");
    }
    const parent = await getMenu(parentId);
    if (!parent) redirect("/admin/menus?error=invalid-parent");
    if (selfId !== null) {
      const all = await listMenus();
      const childrenMap = new Map<string, bigint[]>();
      for (const menu of all) {
        const key = String(menu.parentId);
        const bucket = childrenMap.get(key) ?? [];
        bucket.push(menu.id);
        childrenMap.set(key, bucket);
      }
      const stack = [...(childrenMap.get(String(selfId)) ?? [])];
      while (stack.length > 0) {
        const current = stack.pop() as bigint;
        if (current === parentId) redirect("/admin/menus?error=cycle-parent");
        stack.push(...(childrenMap.get(String(current)) ?? []));
      }
    }
  }

  const input = {
    parentId,
    title,
    path: finalPath,
    icon: icon || null,
    sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 0,
    visible,
    permissionCode,
    status,
  };

  if (selfId !== null) {
    await updateMenu(selfId, input);
    await logOperation(admin, {
      action: "更新菜单",
      target: `${title}（${finalPath}）`,
      headers: await headers(),
    });
  } else {
    await createMenu(input);
    await logOperation(admin, {
      action: "创建菜单",
      target: `${title}（${finalPath}）`,
      headers: await headers(),
    });
  }
  revalidatePath("/admin");
  revalidatePath("/admin/menus");
  redirect("/admin/menus?saved=1");
}

export async function deleteMenuAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("menus:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect("/admin/menus?error=invalid-id");

  const menu = await getMenu(BigInt(idRaw));
  await deleteMenu(BigInt(idRaw));
  await logOperation(admin, {
    action: "删除菜单",
    target: menu ? `${menu.title}（含全部下级）` : `#${idRaw}`,
    headers: await headers(),
  });
  revalidatePath("/admin");
  revalidatePath("/admin/menus");
  redirect("/admin/menus?saved=deleted");
}
