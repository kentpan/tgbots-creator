"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Bot } from "grammy";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  createBotRecord,
  deleteBotRecord,
  deleteGroupBotAdmin,
  getBot,
  getGroupBotAdmin,
  upsertGroupBotAdmin,
  updateBotRecord,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import { parseBotMenuConfig, sendMenuMessage, validateMenuConfig, renderMenuMarkup } from "@/services/bot-menu";
import {
  acquireMenuBot,
  applyBotProfile,
  parseBotProfile,
  restartMenuBot,
  stopMenuBot,
  syncBotCommandsToTelegram,
} from "@/bot/multi-runtime";
import { registerTelegramChat } from "@/services/chat-registry";

function botPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/bots?${query}` : "/admin/bots";
}

function groupsPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/groups?${query}` : "/admin/groups";
}

function parseCommands(raw: string): { command: string; description: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\/?([\w]{1,32})\s+[-—]?\s*(.+)$/);
      if (!match) return null;
      return { command: match[1].toLowerCase(), description: match[2].trim() };
    })
    .filter((item): item is { command: string; description: string } => item !== null);
}

export async function saveBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const enabled = formData.get("enabled") === "1";
  const myName = String(formData.get("my_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const shortDescription = String(formData.get("short_description") ?? "").trim();
  const commandsRaw = String(formData.get("commands") ?? "");

  if (!name) redirect(botPath({ error: "name-required" }));
  const isEdit = Boolean(idRaw && /^\d+$/.test(idRaw));
  if (token && !/^\d{6,}:[\w-]{30,}$/.test(token)) {
    redirect(botPath({ error: "invalid-token" }));
  }
  if (!token && !isEdit) {
    redirect(botPath({ error: "invalid-token" }));
  }

  const requestHeaders = await headers();
  const existingForEdit = isEdit ? await getBot(BigInt(idRaw)) : null;
  if (isEdit && !existingForEdit) redirect(botPath({ error: "invalid-id" }));
  // 编辑时保留指令菜单/隐私模式等由其他弹窗维护的字段，避免被表单覆盖
  const profile = parseBotProfile(existingForEdit?.config ?? "{}");
  profile.my_name = myName || undefined;
  profile.description = description || undefined;
  profile.short_description = shortDescription || undefined;
  profile.commands = parseCommands(commandsRaw);

  // v1.1.0：grammY 插件开关 + 会话存储单项覆盖
  const pluginsRaw = String(formData.get("plugins_json") ?? "");
  if (pluginsRaw) {
    try {
      const parsed = JSON.parse(pluginsRaw) as {
        autoRetry?: boolean;
        throttler?: boolean;
        sessionStorage?: string;
      };
      profile.plugins = {
        autoRetry: parsed.autoRetry !== false,
        throttler: parsed.throttler !== false,
        sessionStorage:
          parsed.sessionStorage === "memory" ||
          parsed.sessionStorage === "sqlite" ||
          parsed.sessionStorage === "d1" ||
          parsed.sessionStorage === "r2" ||
          parsed.sessionStorage === "s3"
            ? parsed.sessionStorage
            : "inherit",
      };
    } catch {
      /* 保持原 plugins 配置 */
    }
  }

  // v1.1.0：菜单按钮 setChatMenuButton（default/commands/web_app Mini App）
  const menuButtonRaw = String(formData.get("menuButton_json") ?? "");
  if (menuButtonRaw) {
    try {
      const parsed = JSON.parse(menuButtonRaw) as { type?: string; text?: string; url?: string };
      if (parsed.type === "commands" || parsed.type === "web_app" || parsed.type === "default") {
        profile.menuButton = {
          type: parsed.type,
          text: parsed.text?.trim() || undefined,
          url: parsed.url?.trim() || undefined,
        };
      }
    } catch {
      /* 保持原 menuButton 配置 */
    }
  }

  // v1.1.0：默认管理员权限 setMyDefaultAdministratorRights（群组/频道）
  const adminRightsRaw = String(formData.get("defaultAdminRights_json") ?? "");
  if (adminRightsRaw) {
    try {
      const parsed = JSON.parse(adminRightsRaw) as {
        group?: Record<string, boolean> | null;
        channel?: Record<string, boolean> | null;
      };
      profile.defaultAdminRights = {
        group: parsed.group ?? undefined,
        channel: parsed.channel ?? undefined,
      };
    } catch {
      /* 保持原 defaultAdminRights 配置 */
    }
  }

  // v1.1.0：AI 客服配置
  const aiSupportRaw = String(formData.get("aiSupport_json") ?? "");
  if (aiSupportRaw) {
    try {
      const parsed = JSON.parse(aiSupportRaw) as {
        enabled?: boolean;
        modelSelection?: string;
        scope?: string;
        systemPrompt?: string;
      };
      profile.aiSupport = {
        enabled: parsed.enabled === true,
        modelSelection: parsed.modelSelection?.trim() || "auto",
        scope: parsed.scope === "private" || parsed.scope === "all" ? parsed.scope : "private_mention",
        systemPrompt: parsed.systemPrompt?.trim() || undefined,
      };
    } catch {
      /* 保持原 aiSupport 配置 */
    }
  }

  const configJson = JSON.stringify(profile);
  const bestEffortToken = token || existingForEdit?.token || "";

  if (isEdit) {
    const existing = existingForEdit!;
    await updateBotRecord(BigInt(idRaw), {
      name,
      token: token || existing.token,
      enabled,
      config: configJson,
    });
    // v1.1.1 性能修复：轮询实例重启 / getMe 回写用户名全部后台并行执行，
    // 不再阻塞保存重定向（此前串行等完所有 Telegram 调用要 10s+）
    if (enabled) {
      void restartMenuBot(BigInt(idRaw)).catch((error: unknown) => {
        console.error(`[bots] 机器人 #${idRaw} 保存后重启运行实例失败:`, error);
      });
    } else {
      void stopMenuBot(BigInt(idRaw)).catch((error: unknown) => {
        console.error(`[bots] 机器人 #${idRaw} 保存后停止运行实例失败:`, error);
      });
    }
    void syncBotUsername(bestEffortToken, existing.id).catch((error: unknown) => {
      console.error(`[bots] 机器人 #${existing.id} 保存后回写用户名失败:`, error);
    });
    await logOperation(admin, {
      action: "保存机器人",
      target: name,
      detail: `状态：${enabled ? "启用" : "停用"}`,
      headers: requestHeaders,
    });
  } else {
    const created = await createBotRecord({
      name,
      token,
      enabled,
      config: configJson,
    });
    if (!created) redirect(botPath({ error: "duplicate-token" }));
    // 后台并行：启动轮询实例 + getMe 回写用户名（不阻塞保存）
    if (enabled) {
      void restartMenuBot(created.id).catch((error: unknown) => {
        console.error(`[bots] 新建机器人 #${created.id} 启动运行实例失败:`, error);
      });
    }
    void syncBotUsername(bestEffortToken, created.id).catch((error: unknown) => {
      console.error(`[bots] 新建机器人 #${created.id} 回写用户名失败:`, error);
    });
    await logOperation(admin, {
      action: "新增机器人",
      target: name,
      headers: requestHeaders,
    });
  }
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "1" }));
}

/** 保存后自动调用 getMe 回写机器人 @用户名（失败不阻塞保存，但错误全量输出到日志） */
async function syncBotUsername(token: string, botId: bigint): Promise<void> {
  if (!token || !/^\d{6,}:[\w-]{30,}$/.test(token)) return;
  const me = await new Bot(token, telegramBotClientOptions()).api.getMe();
  if (!me.username) return;
  await updateBotRecord(botId, { username: me.username });
}

export async function deleteBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const existing = await getBot(BigInt(idRaw));
  if (!existing) redirect(botPath({ error: "invalid-id" }));
  await stopMenuBot(existing.id).catch((error: unknown) => {
    console.error(`[bots] 删除机器人前停止运行实例失败（#id ${existing.id}）:`, error);
  });
  await deleteBotRecord(existing.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "删除机器人",
    target: existing.name,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "deleted" }));
}

export async function testBotAction(formData: FormData): Promise<void> {
  await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));
  try {
    const me = await new Bot(bot.token, telegramBotClientOptions()).api.getMe();
    await updateBotRecord(bot.id, { username: me.username });
    revalidatePath("/admin/bots");
    redirect(botPath({ test: "ok", message: `@${me.username}` }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    redirect(botPath({ test: "fail", message: detail.slice(0, 200) }));
  }
}

export async function saveBotMenuAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const configRaw = String(formData.get("menu_config") ?? "");
  const menuText = String(formData.get("menu_text") ?? "").trim();
  const syncChatIdRaw = String(formData.get("sync_chat_id") ?? "").trim();

  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));

  const parsed = parseBotMenuConfig(configRaw);
  const validation = validateMenuConfig(parsed);
  if (!validation.ok) redirect(botPath({ error: "invalid-menu", message: validation.reason }));

  // 隐私模式开关随菜单设计器一起提交（通用隐私功能，写入 bots.config.privacyMode）
  const privacyMode = formData.get("privacyMode");
  const profile = parseBotProfile(bot.config);
  if (privacyMode !== null) {
    profile.privacyMode = privacyMode === "1";
  }

  await updateBotRecord(bot.id, {
    menuConfig: JSON.stringify(parsed),
    menuText: menuText || parsed.content.text,
    config: JSON.stringify(profile),
  });

  let syncMessage = "";
  if (syncChatIdRaw && /^-?\d+$/.test(syncChatIdRaw)) {
    const handle = await acquireMenuBot(bot.id);
    if (!handle) redirect(botPath({ error: "invalid-id" }));
    try {
      // v1.1.1：菜单键盘由官方 @grammyjs/menu 的 render(ctx) 渲染为普通
      // InlineKeyboardMarkup（插件自身序列化代码，回调数据与插件中间件解码格式一致）
      const result = await sendMenuMessage(handle.bot.api, Number(syncChatIdRaw), parsed.content, {
        replyMarkup: await renderMenuMarkup(parsed, handle.bot),
        keyboardText: menuText,
      });
      syncMessage = `消息 #${result.messageId}${result.keyboardOnAlbum ? "（相册后自动补发带按钮消息）" : ""}`;
      // 群组配置一致性（v1.1.1）：同步目标群组同时登记到该机器人名下，
      // 保证「真实群组」列表 / 测试页与实际可发送目标一致（不覆盖已有验证配置）
      try {
        await registerTelegramChat({
          chatId: BigInt(syncChatIdRaw),
          chatTitle: null,
          botToken: bot.token,
        });
      } catch (error) {
        console.error(`[bots] 菜单同步后登记群组 ${syncChatIdRaw} 失败:`, error);
      }
      if (bot.enabled) {
        void restartMenuBot(bot.id).catch((error: unknown) => {
          console.error(`[bots] 菜单同步后重启运行实例失败（#id ${bot.id}）:`, error);
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      redirect(botPath({ sync: "fail", message: detail.slice(0, 200) }));
    }
  } else if (bot.enabled) {
    void restartMenuBot(bot.id).catch((error: unknown) => {
      console.error(`[bots] 菜单保存后重启运行实例失败（#id ${bot.id}）:`, error);
    });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: syncMessage ? "同步机器人消息内嵌按钮" : "保存机器人消息内嵌按钮",
    target: bot.name,
    detail: syncMessage ? `已发送到群组 ${syncChatIdRaw}（${syncMessage}）` : undefined,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots");
  redirect(
    syncMessage
      ? botPath({ saved: "sync", message: syncMessage })
      : botPath({ saved: "menu" }),
  );
}

export async function syncBotMenuAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw) || !chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    redirect(botPath({ error: "invalid-id" }));
  }
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));
  const parsed = parseBotMenuConfig(bot.menuConfig);
  const validation = validateMenuConfig(parsed);
  if (!validation.ok) redirect(botPath({ error: "invalid-menu", message: validation.reason }));
  const handle = await acquireMenuBot(bot.id);
  if (!handle) redirect(botPath({ error: "invalid-id" }));
  try {
    // v1.1.1：官方 menu.render(ctx) 渲染普通 InlineKeyboardMarkup 直发 + 同步后登记群组链接
    const result = await sendMenuMessage(handle.bot.api, Number(chatIdRaw), parsed.content, {
      replyMarkup: await renderMenuMarkup(parsed, handle.bot),
      keyboardText: bot.menuText,
    });
    try {
      await registerTelegramChat({
        chatId: BigInt(chatIdRaw),
        chatTitle: null,
        botToken: bot.token,
      });
    } catch (error) {
      console.error(`[bots] 菜单同步后登记群组 ${chatIdRaw} 失败:`, error);
    }
    if (bot.enabled) {
      void restartMenuBot(bot.id).catch((error: unknown) => {
        console.error(`[bots] 菜单同步后重启运行实例失败（#id ${bot.id}）:`, error);
      });
    }
    const requestHeaders = await headers();
    await logOperation(admin, {
      action: "同步机器人消息内嵌按钮",
      target: bot.name,
      detail: `已发送到群组 ${chatIdRaw}（消息 #${result.messageId}）`,
      headers: requestHeaders,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    redirect(botPath({ sync: "fail", message: detail.slice(0, 200) }));
  }
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "sync" }));
}

const BOT_ADMIN_RIGHT_KEYS = [
  "can_manage_chat",
  "can_change_info",
  "can_delete_messages",
  "can_invite_users",
  "can_restrict_members",
  "can_pin_messages",
  "can_manage_video_chats",
  "can_promote_members",
] as const;

export type BotAdminRights = Partial<Record<(typeof BOT_ADMIN_RIGHT_KEYS)[number], boolean>>;

export async function setBotGroupAdminAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const botIdRaw = String(formData.get("bot_id") ?? "").trim();
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!botIdRaw || !/^\d+$/.test(botIdRaw) || !chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    redirect(groupsPath({ error: "botadmin" }));
  }
  const bot = await getBot(BigInt(botIdRaw));
  if (!bot) redirect(groupsPath({ error: "botadmin" }));

  const rights: BotAdminRights = {};
  for (const key of BOT_ADMIN_RIGHT_KEYS) {
    rights[key] = formData.get(key) === "1";
  }

  try {
    const handle = await acquireMenuBot(bot.id);
    if (!handle) redirect(groupsPath({ error: "botadmin" }));
    const me = await handle.bot.api.getMe();
    await handle.bot.api.promoteChatMember(Number(chatIdRaw), me.id, rights);
    await updateBotRecord(bot.id, { username: me.username });
    await upsertGroupBotAdmin({
      botId: bot.id,
      chatId: BigInt(chatIdRaw),
      rights: JSON.stringify(rights),
    });
    const requestHeaders = await headers();
    await logOperation(admin, {
      action: "设置群组机器人管理员",
      target: `${bot.name} → ${chatIdRaw}`,
      headers: requestHeaders,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    redirect(groupsPath({ error: "botadmin", message: detail.slice(0, 200) }));
  }
  revalidatePath("/admin/groups");
  redirect(groupsPath({ saved: "botadmin" }));
}

export async function removeBotGroupAdminAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(groupsPath({ error: "botadmin" }));
  const record = await getGroupBotAdmin(BigInt(idRaw));
  if (!record) redirect(groupsPath({ error: "botadmin" }));
  const bot = await getBot(record.botId);
  if (bot) {
    try {
      const handle = await acquireMenuBot(bot.id);
      if (handle) {
        const me = await handle.bot.api.getMe();
        await handle.bot.api.promoteChatMember(Number(record.chatId), me.id, {
          can_manage_chat: false,
          can_change_info: false,
          can_delete_messages: false,
          can_invite_users: false,
          can_restrict_members: false,
          can_pin_messages: false,
          can_manage_video_chats: false,
          can_promote_members: false,
        });
      }
    } catch {
      /* best effort demote */
    }
  }
  await deleteGroupBotAdmin(record.id);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "移除群组机器人管理员",
    target: bot?.name ?? String(record.botId),
    headers: requestHeaders,
  });
  revalidatePath("/admin/groups");
  redirect(groupsPath({ saved: "botadmin-removed" }));
}

export async function applyBotProfileAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));
  try {
    const profile = parseBotProfile(bot.config);
    const handle = await acquireMenuBot(bot.id);
    if (!handle) redirect(botPath({ error: "invalid-id" }));
    await applyBotProfile(handle.bot, profile);
    const requestHeaders = await headers();
    await logOperation(admin, {
      action: "应用机器人官方资料",
      target: bot.name,
      headers: requestHeaders,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    redirect(botPath({ test: "fail", message: detail.slice(0, 200) }));
  }
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "profile" }));
}

/**
 * 保存机器人指令菜单配置（真实生效）：
 * - privacyMode：隐私模式开关，写入 bots.config.privacyMode
 * - commandIds：指令菜单选中的指令库条目，写入 bots.config.commandIds
 * 保存后立即调用 setMyCommands 同步 Telegram 用户指令菜单，并热更新运行实例。
 */
export async function saveBotCommandMenuAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const existing = await getBot(BigInt(idRaw));
  if (!existing) redirect(botPath({ error: "invalid-id" }));

  const privacyMode = formData.get("privacyMode") === "1";
  const commandIdsRaw = String(formData.get("commandIds") ?? "[]");
  let commandIds: number[] = [];
  try {
    const parsed = JSON.parse(commandIdsRaw) as unknown;
    if (Array.isArray(parsed)) {
      commandIds = parsed
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0);
    }
  } catch {
    redirect(botPath({ error: "invalid-commands" }));
  }

  const profile = parseBotProfile(existing.config);
  profile.privacyMode = privacyMode;
  profile.commandIds = commandIds;
  await updateBotRecord(existing.id, { config: JSON.stringify(profile) });

  const sync = await syncBotCommandsToTelegram(existing.id);
  await restartMenuBot(existing.id).catch((error: unknown) => {
    console.error(`[bots] 指令菜单保存后重启运行实例失败（#id ${existing.id}）:`, error);
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存机器人指令菜单",
    target: existing.name,
    detail: `隐私模式：${privacyMode ? "开启" : "关闭"}；指令 ${commandIds.length} 条；setMyCommands ${sync.ok ? `成功(${sync.count})` : `失败(${sync.error ?? "未知错误"})`}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "commands" }));
}

/** 隐私模式快捷开关（消息内嵌按钮设计器等处使用）：仅切换 bots.config.privacyMode */
export async function saveBotPrivacyModeAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const existing = await getBot(BigInt(idRaw));
  if (!existing) redirect(botPath({ error: "invalid-id" }));

  const privacyMode = formData.get("privacyMode") === "1";
  const profile = parseBotProfile(existing.config);
  profile.privacyMode = privacyMode;
  await updateBotRecord(existing.id, { config: JSON.stringify(profile) });
  await restartMenuBot(existing.id).catch((error: unknown) => {
    console.error(`[bots] 隐私模式切换后重启运行实例失败（#id ${existing.id}）:`, error);
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "切换机器人隐私模式",
    target: existing.name,
    detail: privacyMode ? "开启" : "关闭",
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots");
}

/**
 * 保存单项运行配置（传输模式 + 隐私模式，跟随全局/显式指定），并立即热应用：
 * - polling：注销 Webhook → 启动长轮询
 * - webhook：停止轮询 → setWebhook（Base URL 取全局配置，自动附带密钥）
 */
export async function saveBotRuntimeAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const existing = await getBot(BigInt(idRaw));
  if (!existing) redirect(botPath({ error: "invalid-id" }));

  const transportRaw = String(formData.get("transportMode") ?? "inherit");
  const transportMode =
    transportRaw === "polling" || transportRaw === "webhook" ? transportRaw : "inherit";
  const privacyRaw = String(formData.get("privacySetting") ?? "inherit");
  const privacySetting = privacyRaw === "on" || privacyRaw === "off" ? privacyRaw : "inherit";

  const profile = parseBotProfile(existing.config);
  profile.transportMode = transportMode;
  profile.privacyModeSetting = privacySetting;
  await updateBotRecord(existing.id, { config: JSON.stringify(profile) });

  if (existing.enabled) {
    await restartMenuBot(existing.id).catch((error: unknown) => {
      console.error(`[bots] 运行配置保存后重启运行实例失败（#id ${existing.id}）:`, error);
    });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存机器人运行配置",
    target: existing.name,
    detail: `传输模式：${transportMode === "inherit" ? "跟随全局" : transportMode === "polling" ? "长轮询" : "Webhook"}；隐私模式：${privacySetting === "inherit" ? "跟随全局" : privacySetting === "on" ? "开启" : "关闭"}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "runtime" }));
}
