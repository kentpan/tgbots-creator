import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createAdminSession,
  deleteAdminSession,
  deleteExpiredAdminSessions,
  getAdminSession,
  type AdminSessionContext,
  type MenuRow,
  listMenus,
  recordOperationLog,
} from "@/database/operations";
import { generateSessionToken, sha256Hex } from "@/lib/password";

function ipFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "127.0.0.1";
}

export const SESSION_COOKIE_NAME = "bg_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SUPER_ADMIN_ROLE_CODE = "super_admin";

export function hasPermission(
  admin: Pick<AdminSessionContext, "user" | "permissions">,
  code: string,
): boolean {
  if (admin.user.roleCode === SUPER_ADMIN_ROLE_CODE) return true;
  return admin.permissions.includes(code);
}

export async function createLoginSession(
  userId: bigint,
  headers: Headers,
): Promise<void> {
  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createAdminSession({
    userId,
    tokenHash,
    expiresAt,
    ipAddress: ipFromHeaders(headers),
    userAgent: headers.get("user-agent"),
  });
  void deleteExpiredAdminSessions();
  const jar = await cookies();
  // v2.0.12：https 站点（Cloudflare Pages 线上）cookie 使用 SameSite=None，
  // 允许本地 node 管理后台把「部署/加群申请」等实操请求跨站转发到线上时
  // 自动携带线上登录态（浏览器要求 SameSite=None 必须搭配 Secure）；
  // http（本地 dev）维持 SameSite=Lax。
  const forwardedProto = (headers.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  const isHttps = forwardedProto === "https";
  jar.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isHttps ? "none" : "lax",
    secure: isHttps,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    const tokenHash = await sha256Hex(token);
    await deleteAdminSession(tokenHash);
  }
  jar.delete(SESSION_COOKIE_NAME);
}

export async function getCurrentAdmin(): Promise<AdminSessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  try {
    return await getAdminSession(tokenHash);
  } catch (error) {
    console.error("Error loading admin session:", error);
    return null;
  }
}

export async function requireAuth(): Promise<AdminSessionContext> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    redirect("/login");
  }
  return admin;
}

export async function requirePermission(code: string): Promise<AdminSessionContext> {
  const admin = await requireAuth();
  if (!hasPermission(admin, code)) {
    redirect(`/admin?denied=${encodeURIComponent(code)}`);
  }
  return admin;
}

export interface SidebarMenu extends MenuRow {
  children: SidebarMenu[];
}

export async function loadAuthorizedMenus(
  admin: AdminSessionContext,
): Promise<SidebarMenu[]> {
  const menus = await listMenus({ visibleOnly: true });
  const allowed = menus.filter(
    (menu) => !menu.permissionCode || hasPermission(admin, menu.permissionCode),
  );
  const roots = allowed.filter((menu) => menu.parentId === 0n);
  return roots.map<SidebarMenu>((menu) => ({
    ...menu,
    children: allowed
      .filter((child) => child.parentId === menu.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id - b.id))
      .map<SidebarMenu>((child) => ({ ...child, children: [] })),
  }));
}

export async function logOperation(
  admin: AdminSessionContext,
  input: { action: string; target?: string | null; detail?: string | null; headers?: Headers },
): Promise<void> {
  try {
    await recordOperationLog({
      adminId: admin.user.id,
      adminUsername: admin.user.username,
      action: input.action,
      target: input.target ?? null,
      detail: input.detail ?? null,
      ipAddress: input.headers ? ipFromHeaders(input.headers) : null,
    });
  } catch (error) {
    console.error("Error recording operation log:", error);
  }
}
