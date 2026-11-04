"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  deleteGroupBotAdminsByChat,
  deleteGroupSettings,
  upsertGroupSettings,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

export async function saveGroupAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    redirect("/admin/groups?error=invalid-chat-id");
  }
  const chatId = BigInt(chatIdRaw);

  const method = String(formData.get("method") ?? "captcha");
  if (method !== "captcha" && method !== "code_api") {
    redirect("/admin/groups?error=invalid-method");
  }
  const methodIdRaw = String(formData.get("method_id") ?? "").trim();
  const methodId = methodIdRaw ? BigInt(methodIdRaw) : null;
  if (method === "code_api" && (!methodIdRaw || !/^\d+$/.test(methodIdRaw))) {
    redirect("/admin/groups?error=method-required");
  }

  const timeoutSeconds = Number(formData.get("timeout_seconds") ?? "300");
  const maxAttempts = Number(formData.get("max_attempts") ?? "3");

  await upsertGroupSettings(chatId, {
    chatTitle: String(formData.get("chat_title") ?? "").trim() || null,
    method,
    methodId: method === "code_api" ? methodId : null,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.trunc(timeoutSeconds) : 300,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.trunc(maxAttempts) : 3,
    promptText: String(formData.get("prompt_text") ?? "").trim() || undefined,
    successText: String(formData.get("success_text") ?? "").trim() || undefined,
    failureText: String(formData.get("failure_text") ?? "").trim() || undefined,
    enabled: formData.get("enabled") === "1",
    privacyMode: formData.get("privacy_mode") !== "0",
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存群组验证配置",
    target: chatIdRaw,
    detail: `验证方式：${method === "code_api" ? `自定义验证码（方法 #${methodIdRaw}）` : "人机验证码"}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/groups");
  redirect("/admin/groups?saved=1");
}

export async function deleteGroupAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!chatIdRaw) redirect("/admin/groups?error=invalid-chat-id");

  await deleteGroupSettings(BigInt(chatIdRaw));
  // 同步清理该群组的全部机器人关联行（group_bot_admins），避免孤儿行残留进「真实群组」下拉
  await deleteGroupBotAdminsByChat(BigInt(chatIdRaw));
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "删除群组验证配置",
    target: chatIdRaw,
    headers: requestHeaders,
  });
  revalidatePath("/admin/groups");
  redirect("/admin/groups?saved=deleted");
}
