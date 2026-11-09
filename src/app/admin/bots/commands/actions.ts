"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  createBotCommand,
  deleteBotCommand,
  getBot,
  getBotCommand,
  getGroupSettings,
  moveBotCommand,
  updateBotCommand,
  type BotCommandType,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";

function commandsPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/bots/commands?${query}` : "/admin/bots/commands";
}

/**
 * 解析指令归属表单字段（v2.1.13）：botId/groupId 均为可选字符串，
 * 空 = 不限定；两者互斥，同时非空返回 null 由调用方报 invalid-scope。
 * 返回 bigint | null：null = 全局/清空归属。
 */
async function parseCommandScope(
  formData: FormData,
): Promise<{ botId: bigint | null; groupId: bigint | null; error: string | null }> {
  const botIdRaw = String(formData.get("botId") ?? "").trim();
  const groupIdRaw = String(formData.get("groupId") ?? "").trim();
  if (botIdRaw && groupIdRaw) {
    return { botId: null, groupId: null, error: "invalid-scope" };
  }
  let botId: bigint | null = null;
  let groupId: bigint | null = null;
  if (botIdRaw) {
    if (!/^\d+$/.test(botIdRaw)) return { botId: null, groupId: null, error: "invalid-scope-target" };
    // 归属对象必须真实存在：机器人下拉来自 bots 表，群组下拉来自 group_settings 表，
    // 两个维度绝不允许混淆（机器人 id 与群组 chat_id 是不同的键空间）
    const bot = await getBot(BigInt(botIdRaw));
    if (!bot) return { botId: null, groupId: null, error: "invalid-scope-target" };
    botId = bot.id;
  }
  if (groupIdRaw) {
    if (!/^-?\d+$/.test(groupIdRaw)) return { botId: null, groupId: null, error: "invalid-scope-target" };
    const group = await getGroupSettings(BigInt(groupIdRaw));
    if (!group) return { botId: null, groupId: null, error: "invalid-scope-target" };
    groupId = group.chatId;
  }
  return { botId, groupId, error: null };
}

/**
 * 保存指令（内置指令与自定义指令共用）。
 * 指令名遵循 Telegram Bot API 限制：1-32 个字符，仅小写字母、数字与下划线；
 * 描述 1-256 字符（setMyCommands 的硬性要求）。
 * 归属（v2.1.13）：仅自定义指令提供机器人私有/群组私有（互斥），内置指令恒为全局。
 */
export async function saveBotCommandAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const type = (String(formData.get("type") ?? "builtin") === "custom"
    ? "custom"
    : "builtin") as BotCommandType;
  const name = String(formData.get("name") ?? "").trim().toLowerCase();
  const description = String(formData.get("description") ?? "").trim();
  const intro = String(formData.get("intro") ?? "").trim();
  const enabled = formData.get("enabled") === "1";
  const sortOrderRaw = Number(String(formData.get("sortOrder") ?? "0"));
  const sortOrder = Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : 0;
  const tab = type === "custom" ? "custom" : "builtin";

  if (!/^[a-z0-9_]{1,32}$/.test(name)) {
    redirect(commandsPath({ tab, error: "invalid-name" }));
  }
  if (!description || description.length > 256) {
    redirect(commandsPath({ tab, error: "invalid-description" }));
  }
  // 归属解析与互斥/存在性校验：内置指令恒为全局（不读表单归属字段）
  const scope = type === "custom" ? await parseCommandScope(formData) : { botId: null, groupId: null, error: null };
  if (scope.error) {
    redirect(commandsPath({ tab, error: scope.error }));
  }

  const requestHeaders = await headers();
  const isEdit = Boolean(idRaw && /^\d+$/.test(idRaw));
  if (isEdit) {
    const existing = await getBotCommand(BigInt(idRaw));
    if (!existing) redirect(commandsPath({ tab, error: "invalid-id" }));
    // 内置指令的类型与名字保持稳定，仅允许编辑描述/介绍/状态/排序
    await updateBotCommand(existing.id, {
      name: existing.type === "builtin" ? existing.name : name,
      description,
      intro,
      enabled,
      sortOrder,
      ...(existing.type === "custom" ? { botId: scope.botId, groupId: scope.groupId } : {}),
    });
    const scopeLabel =
      scope.botId !== null
        ? `机器人私有 #${String(scope.botId)}`
        : scope.groupId !== null
          ? `群组私有 ${String(scope.groupId)}`
          : "全局";
    await logOperation(admin, {
      action: existing.type === "builtin" ? "编辑内置指令" : "编辑自定义指令",
      target: `/${existing.name}`,
      detail: `状态：${enabled ? "启用" : "停用"}；归属：${scopeLabel}`,
      headers: requestHeaders,
    });
  } else {
    const created = await createBotCommand({
      type,
      name,
      description,
      intro,
      enabled,
      sortOrder,
      ...(type === "custom" ? { botId: scope.botId, groupId: scope.groupId } : {}),
    });
    if (!created) redirect(commandsPath({ tab, error: "duplicate-name" }));
    await logOperation(admin, {
      action: type === "builtin" ? "新增内置指令" : "新增自定义指令",
      target: `/${name}`,
      headers: requestHeaders,
    });
  }
  revalidatePath("/admin/bots/commands");
  redirect(commandsPath({ tab, saved: "1" }));
}

/**
 * ↑↓ 排序：与相邻的同类型指令交换 sort_order，保证「越常用的排越前面」可随时手工微调。
 */
export async function moveBotCommandAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const direction = String(formData.get("direction") ?? "up") === "down" ? "down" : "up";
  const tab = String(formData.get("tab") ?? "builtin") === "custom" ? "custom" : "builtin";
  const page = String(formData.get("page") ?? "1");
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(commandsPath({ tab, page, error: "invalid-id" }));
  const current = await getBotCommand(BigInt(idRaw));
  if (!current) redirect(commandsPath({ tab, page, error: "invalid-id" }));

  const moved = await moveBotCommand(current.id, current.type, direction);
  if (moved) {
    const requestHeaders = await headers();
    await logOperation(admin, {
      action: direction === "up" ? "上移指令" : "下移指令",
      target: `/${current.name}`,
      headers: requestHeaders,
    });
  }
  revalidatePath("/admin/bots/commands");
  redirect(commandsPath({ tab, page }));
}

export async function toggleBotCommandAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const tab = String(formData.get("tab") ?? "builtin") === "custom" ? "custom" : "builtin";
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(commandsPath({ tab, error: "invalid-id" }));
  const existing = await getBotCommand(BigInt(idRaw));
  if (!existing) redirect(commandsPath({ tab, error: "invalid-id" }));

  await updateBotCommand(existing.id, { enabled: !existing.enabled });
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: existing.enabled ? "停用指令" : "启用指令",
    target: `/${existing.name}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots/commands");
  redirect(commandsPath({ tab, page: String(formData.get("page") ?? "1") }));
}

export async function deleteBotCommandAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const tab = String(formData.get("tab") ?? "builtin") === "custom" ? "custom" : "builtin";
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(commandsPath({ tab, error: "invalid-id" }));
  const existing = await getBotCommand(BigInt(idRaw));
  if (!existing) redirect(commandsPath({ tab, error: "invalid-id" }));

  await deleteBotCommand(existing.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: existing.type === "builtin" ? "删除内置指令" : "删除自定义指令",
    target: `/${existing.name}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots/commands");
  redirect(commandsPath({ tab, saved: "deleted" }));
}
