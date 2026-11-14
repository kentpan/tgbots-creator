"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  deleteGroupBotAdminsByChat,
  deleteGroupSettings,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

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
