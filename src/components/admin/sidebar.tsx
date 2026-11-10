"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

export interface SidebarMenuLink {
  id: string;
  title: string;
  path: string;
  icon: string | null;
  children: SidebarMenuLink[];
}

function NavLink({ item, active }: { item: SidebarMenuLink; active: boolean }) {
  // v2.2.5：当前态菜单不可点击（render 为 span 而非 Link，aria-current 标注页面语义）
  if (active) {
    return (
      <span
        aria-current="page"
        className="flex cursor-default items-center gap-3 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
      >
        <span className="w-5 text-center">{item.icon ?? "📄"}</span>
        <span>{item.title}</span>
      </span>
    );
  }
  return (
    <Link
      href={item.path || "/admin"}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <span className="w-5 text-center">{item.icon ?? "📄"}</span>
      <span>{item.title}</span>
    </Link>
  );
}

export function AdminSidebar({
  menus,
  title,
  version,
}: {
  menus: SidebarMenuLink[];
  title: string;
  version: string;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 所有叶子菜单（无子菜单的一级项 + 各级子项），用于计算当前路径的唯一最佳匹配
  const leaves = useMemo<SidebarMenuLink[]>(() => {
    const result: SidebarMenuLink[] = [];
    for (const menu of menus) {
      if (menu.children.length === 0) {
        result.push(menu);
      } else {
        result.push(...menu.children.filter((child) => child.path));
      }
    }
    return result;
  }, [menus]);

  // 当前路径应高亮的唯一叶子菜单：
  // 1) 精确匹配或按路径段前缀匹配（/admin/bots 不会误配 /admin/bots2）
  // 2) 多个菜单同时匹配时，取最长（最具体）的路径 —— 如 /admin/bots/testing 只高亮该菜单，不再同时高亮 /admin/bots
  // 3) 路径完全相同的重复菜单，取列表中靠后的一个
  const activeLeafId = useMemo<string | null>(() => {
    let best: SidebarMenuLink | null = null;
    let bestPath = "";
    for (const leaf of leaves) {
      const path = leaf.path || "/admin";
      const matched =
        path === "/admin"
          ? pathname === "/admin"
          : pathname === path || pathname.startsWith(`${path}/`);
      if (!matched) continue;
      if (best === null || path.length >= bestPath.length) {
        best = leaf;
        bestPath = path;
      }
    }
    return best?.id ?? null;
  }, [leaves, pathname]);

  const groupActive = (item: SidebarMenuLink): boolean =>
    item.children.some((child) => child.id === activeLeafId);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <span className="text-xl">🤖</span>
        <span className="text-sm font-bold">{title}</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {menus.map((menu) => {
          if (menu.children.length === 0) {
            return <NavLink key={menu.id} item={menu} active={menu.id === activeLeafId} />;
          }
          const active = groupActive(menu);
          const open = expanded[menu.id] ?? active;
          return (
            <div key={menu.id} className="space-y-1">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [menu.id]: !open }))}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <span className="w-5 text-center">{menu.icon ?? "📁"}</span>
                <span className="flex-1 text-left">{menu.title}</span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
                />
              </button>
              {open ? (
                <div className="ml-4 space-y-1 border-l pl-3">
                  {menu.children.map((child) => (
                    <NavLink key={child.id} item={child} active={child.id === activeLeafId} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
      <div className="border-t p-3">
        <p className="text-sm text-muted-foreground">
          TGuard 管理后台 (v{version})
        </p>
      </div>
    </aside>
  );
}
