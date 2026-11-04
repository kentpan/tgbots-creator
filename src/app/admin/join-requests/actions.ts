"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  approveJoinRequest,
  rejectJoinRequest,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

export async function approveJoinRequestAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("requests:manage");
  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/admin/join-requests?error=missing-token");

  const ok = await approveJoinRequest(token, admin.user.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: ok ? "手动批准加群申请" : "手动批准失败",
    target: token.slice(0, 12),
    headers: requestHeaders,
  });
  revalidatePath("/admin/join-requests");
  redirect(ok ? "/admin/join-requests?saved=approved" : "/admin/join-requests?error=approve-failed");
}

export async function rejectJoinRequestAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("requests:manage");
  const token = String(formData.get("token") ?? "");
  if (!token) redirect("/admin/join-requests?error=missing-token");

  const ok = await rejectJoinRequest(token, admin.user.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: ok ? "手动拒绝加群申请" : "手动拒绝失败",
    target: token.slice(0, 12),
    headers: requestHeaders,
  });
  revalidatePath("/admin/join-requests");
  redirect(ok ? "/admin/join-requests?saved=rejected" : "/admin/join-requests?error=reject-failed");
}
