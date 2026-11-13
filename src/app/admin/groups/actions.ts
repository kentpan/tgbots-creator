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

/**
 * 保存群组配置（v2.3 对齐）：
 * 验证方式已迁机器人级（bots.config.joinVerify），群级只保存：
 * 群名 / 启用 / 三段文案 / 隐私模式 / 直连踢出 / 群内回复输码 / 新成员审核 / 自动审核机器人。
 */
export async function saveGroupAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    redirect("/admin/groups?error=invalid-chat-id");
  }
  const chatId = BigInt(chatIdRaw);

  // 自动审核机器人："" = 手动审核（null）；非法值直接报错不静默
  const joinVerifyBotRaw = String(formData.get("join_verify_bot_id") ?? "").trim();
  let joinVerifyBotId: bigint | null = null;
  if (joinVerifyBotRaw) {
    if (!/^\d+$/.test(joinVerifyBotRaw)) {
      redirect("/admin/groups?error=invalid-join-verify-bot");
    }
    joinVerifyBotId = BigInt(joinVerifyBotRaw);
  }

  await upsertGroupSettings(chatId, {
    chatTitle: String(formData.get("chat_title") ?? "").trim() || null,
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
    // v2.3 新成员审核（审批制入群）+ 自动审核机器人指定
    requireApproval: formData.get("require_approval") === "1",
    joinVerifyBotId,
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存群组配置",
    target: chatIdRaw,
    detail: `新成员审核：${formData.get("require_approval") === "1" ? "开启" : "关闭"}；自动审核机器人：${
      joinVerifyBotId === null ? "手动审核" : `#${joinVerifyBotRaw}`
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
    action: "删除群组配置",
    target: chatIdRaw,
    headers: requestHeaders,
  });
  revalidatePath("/admin/groups");
  redirect("/admin/groups?saved=deleted");
}
