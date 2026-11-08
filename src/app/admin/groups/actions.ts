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
  // v1.1.7：新增 code_self（自动验证码：机器人发码，用户输入验证码加群）
  if (method !== "captcha" && method !== "code_api" && method !== "code_self") {
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
    // v2.0.1：选中即落库保留（重开弹窗回显所选），不再非 code_api 时静默置 null。
    // 绑定方法仅在验证方式=自定义验证码(code_api)时参与验证流程
    // （chat-member / verification-flow 均有 method===code_api 守卫），
    // 其他方式下仅作偏好记录，绝不影响验证行为。
    methodId,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.trunc(timeoutSeconds) : 300,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.trunc(maxAttempts) : 3,
    promptText: String(formData.get("prompt_text") ?? "").trim() || undefined,
    successText: String(formData.get("success_text") ?? "").trim() || undefined,
    failureText: String(formData.get("failure_text") ?? "").trim() || undefined,
    enabled: formData.get("enabled") === "1",
    privacyMode: formData.get("privacy_mode") !== "0",
    // v2.0.7 直连入群踢出开关（默认关闭）：开关关闭时直连用户超时/失败保留在群内
    kickDirectJoins: formData.get("kick_direct_joins") === "1",
    // v2.1.5 群内回复输码快速验证（默认关闭）：开启后群内验证提示改为 force_reply
    // 形态，成员回复输码，验证结束后自动删除验证提示与验证码消息
    replyCodeInGroup: formData.get("reply_code_in_group") === "1",
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存群组验证配置",
    target: chatIdRaw,
    detail: `验证方式：${
      method === "code_api"
        ? `自定义验证码（方法 #${methodIdRaw}）`
        : method === "code_self"
          ? "自动验证码（输入验证码加群）"
          : "人机验证码"
    }`,
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
