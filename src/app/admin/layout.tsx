import type { Metadata } from "next";
import { logoutAction } from "@/app/login/actions";
import { SubmitButton } from "@/components/admin/submit-button";
import { AdminSidebar, type SidebarMenuLink } from "@/components/admin/sidebar";
import { loadAuthorizedMenus, requireAuth } from "@/lib/auth";
import { getDatabaseInfo } from "@/database/client";
import { APP_VERSION } from "@/lib/app-version";

export const metadata: Metadata = {
  title: "TGuard 管理后台",
};

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAuth();
  const menuRows = await loadAuthorizedMenus(admin);
  const dbInfo = await getDatabaseInfo();

  const menus: SidebarMenuLink[] = menuRows.map((menu) => ({
    id: String(menu.id),
    title: menu.title,
    path: menu.path,
    icon: menu.icon,
    children: menu.children.map((child) => ({
      id: String(child.id),
      title: child.title,
      path: child.path,
      icon: child.icon,
      children: [],
    })),
  }));

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar menus={menus} title="TGuard 后台" version={APP_VERSION} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b bg-card px-6">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">管理后台</span>
            <span className="rounded-full border px-2 py-0.5 text-sm text-muted-foreground">
              数据层：{dbInfo.kind === "d1" ? "Cloudflare D1" : `Node SQLite（${dbInfo.displayPath}）`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {admin.user.displayName ?? admin.user.username}（{admin.user.roleName}）
            </span>
            <form action={logoutAction}>
              <SubmitButton
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
                pendingLabel="退出中…"
              >
                退出登录
              </SubmitButton>
            </form>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
