import type { MenuRow } from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { permissionLabel } from "@/lib/menu-permissions";
import type { MenuTreeOption } from "@/components/admin/menu-parent-select";
import type { MenuFormValues } from "./menu-form-dialog";
import { deleteMenuAction } from "./actions";
import { MenuFormDialog } from "./menu-form-dialog";

// v2.0.13：时间展示统一北京时间（服务器/Edge 运行时时区为 UTC）
function formatDateTime(date: Date): string {
  return formatBeijingDateTimeMinute(date);
}

function sortTree(rows: MenuRow[]): MenuRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id - b.id));
}

function toFormValues(menu: MenuRow): MenuFormValues {
  return {
    id: String(menu.id),
    parentId: String(menu.parentId),
    title: menu.title,
    path: menu.path,
    icon: menu.icon ?? "",
    sortOrder: menu.sortOrder,
    visible: menu.visible,
    permissionCode: menu.permissionCode,
    status: menu.status === 1,
  };
}

function MenuNode({
  menu,
  all,
  menuOptions,
  level,
  isLast,
}: {
  menu: MenuRow;
  all: MenuRow[];
  menuOptions: MenuTreeOption[];
  level: number;
  isLast: boolean;
}) {
  const children = sortTree(all.filter((item) => item.parentId === menu.id));
  const hasChildren = children.length > 0;

  return (
    <div>
      <div className="grid grid-cols-[minmax(240px,1.7fr)_minmax(150px,1fr)_90px_70px_120px_70px_auto] items-center gap-2 border-b border-dashed px-3 py-2.5 last:border-0 hover:bg-accent/40">
        <div className="flex min-w-0 items-center">
          {level > 0 ? (
            <span
              className="relative inline-block shrink-0 text-muted-foreground/50"
              style={{ width: `${level * 26}px` }}
            >
              <span className="absolute right-1 top-1/2 h-px w-4 bg-border" />
              <span
                className="absolute top-0 h-full w-px bg-border"
                style={{ right: "17px", height: isLast ? "50%" : "100%" }}
              />
            </span>
          ) : null}
          <span className="mr-2">{menu.icon ?? (hasChildren ? "📁" : "📄")}</span>
          <span className={`truncate ${hasChildren ? "font-semibold" : "font-medium"}`}>
            {menu.title}
          </span>
          {hasChildren ? (
            <span className="ml-2 shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              目录 · {children.length} 个下级
            </span>
          ) : null}
          {menu.visible ? null : (
            <span className="ml-2 shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              隐藏
            </span>
          )}
          {menu.status === 1 ? null : (
            <span className="ml-2 shrink-0 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs text-red-600">
              停用
            </span>
          )}
        </div>
        <div className="truncate font-mono text-sm text-muted-foreground">
          {menu.path || <span className="text-muted-foreground/60">—（目录）</span>}
        </div>
        <div className="truncate text-sm text-muted-foreground">{permissionLabel(menu.permissionCode)}</div>
        <div className="text-sm text-muted-foreground">{menu.sortOrder}</div>
        <div className="text-sm text-muted-foreground">{formatDateTime(menu.updatedTime)}</div>
        <div className="text-sm text-muted-foreground">ID {String(menu.id)}</div>
        <div className="flex items-center justify-end gap-1.5">
          <MenuFormDialog
            menuOptions={menuOptions}
            defaultParentId={String(menu.id)}
            trigger="+ 下级"
            triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-2.5 text-sm text-primary hover:bg-primary/10"
          />
          <MenuFormDialog
            menu={toFormValues(menu)}
            menuOptions={menuOptions}
            trigger="编辑"
            triggerClassName="inline-flex h-8 items-center rounded-md border px-2.5 text-sm hover:bg-accent"
          />
          <ConfirmDialog
            trigger="删除"
            triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
            title={`删除菜单「${menu.title}」？`}
            description={
              hasChildren
                ? `该菜单下有 ${children.length} 个直接下级（含更深层级）将一并删除，此操作不可恢复。`
                : "删除后不可恢复，确定继续吗？"
            }
            confirmLabel="确认删除"
            action={deleteMenuAction}
            fields={{ id: String(menu.id) }}
          />
        </div>
      </div>
      {children.map((child, index) => (
        <MenuNode
          key={String(child.id)}
          menu={child}
          all={all}
          menuOptions={menuOptions}
          level={level + 1}
          isLast={index === children.length - 1}
        />
      ))}
    </div>
  );
}

export function MenuTree({
  menus,
  menuOptions,
}: {
  menus: MenuRow[];
  menuOptions: MenuTreeOption[];
}) {
  const roots = sortTree(menus.filter((menu) => menu.parentId === 0n));
  return (
    <div>
      <div className="grid grid-cols-[minmax(240px,1.7fr)_minmax(150px,1fr)_90px_70px_120px_70px_auto] gap-2 border-b px-3 py-2.5 text-left text-sm font-medium text-muted-foreground">
        <div>标题（层级）</div>
        <div>路径</div>
        <div>权限</div>
        <div>排序</div>
        <div>更新时间</div>
        <div>ID</div>
        <div className="text-right">操作</div>
      </div>
      {roots.map((menu, index) => (
        <MenuNode
          key={String(menu.id)}
          menu={menu}
          all={menus}
          menuOptions={menuOptions}
          level={0}
          isLast={index === roots.length - 1}
        />
      ))}
    </div>
  );
}
