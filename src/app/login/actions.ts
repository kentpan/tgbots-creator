"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createLoginSession,
  destroyCurrentSession,
  logOperation,
  requireAuth,
} from "@/lib/auth";
import { getAdminUserByUsername, recordOperationLog, touchAdminLogin } from "@/database/operations";
import { verifyPassword } from "@/lib/password";

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    redirect("/login?error=empty");
  }

  const user = await getAdminUserByUsername(username);
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || user.status !== "active" || !passwordOk) {
    redirect("/login?error=invalid");
  }

  const requestHeaders = await headers();
  await createLoginSession(user.id, requestHeaders);
  await touchAdminLogin(user.id);
  try {
    await recordOperationLog({
      adminId: user.id,
      adminUsername: user.username,
      action: "登录后台",
      target: user.username,
      ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
  } catch (error) {
    console.error("Error recording login log:", error);
  }

  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  const admin = await requireAuth();
  const requestHeaders = await headers();
  await logOperation(admin, { action: "退出后台", target: admin.user.username, headers: requestHeaders });
  await destroyCurrentSession();
  redirect("/login");
}
