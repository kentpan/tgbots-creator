import { listMenus } from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import type { MenuTreeOption } from "@/components/admin/menu-parent-select";
import { MenuFormDialog } from "./menu-form-dialog";
import { MenuTree } from "./menu-tree";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "菜单已保存",
  deleted: "菜单已删除",
};

const ERRORS: Record<string, string> = {
  "title-required": "请填写菜单标题",
  "invalid-path": "路径必须以 / 开头（目录菜单可留空）",
  "invalid-id": "菜单不存在",
  "invalid-parent": "上级菜单不存在",
  "cycle-parent": "不能把菜单移动到它自己或它的下级之下",
};

export default async function MenusPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requirePermission("menus:view");
  const params = await searchParams;
  const menus = await listMenus();
  const menuOptions: MenuTreeOption[] = menus.map((menu) => ({
    id: String(menu.id),
    parentId: String(menu.parentId),
    title: menu.title,
    icon: menu.icon,
    sortOrder: menu.sortOrder,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">菜单管理</h1>
          <p className="text-sm text-muted-foreground">
            侧边栏菜单按树状层级管理：编辑时可在树状浮层中选择任意层级的上级菜单，目录菜单留空路径即可作为分组容器。
          </p>
        </div>
        <MenuFormDialog
          menuOptions={menuOptions}
          trigger="+ 新增菜单"
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

      <div className="rounded-xl border bg-card p-2">
        <MenuTree menus={menus} menuOptions={menuOptions} />
        {menus.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            还没有菜单，点击右上角「新增菜单」创建
          </p>
        ) : null}
      </div>
    </div>
  );
}
