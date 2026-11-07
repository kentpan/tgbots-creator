"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Bot, GrammyError } from "grammy";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  createBotRecord,
  deleteBotRecord,
  deleteGroupBotAdmin,
  getBot,
  getGroupBotAdmin,
  getGroupSettings,
  upsertGroupBotAdmin,
  upsertGroupSettings,
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
import {
  INVALID_TOKEN_GUIDE,
  PROMOTE_SELF_GUIDE,
  actualRightsFromMember,
  findPromoterBot,
  formatRights,
} from "@/services/bot-group-admin-sync";
import { BOT_ADMIN_RIGHT_KEYS, type BotAdminRights } from "@/services/bot-admin-rights";

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

function parseRewriteRules(raw: string): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const from = trimmed.slice(0, eq).trim();
    const to = trimmed.slice(eq + 1).trim();
    if (from) rules[from] = to;
  }
  return rules;
}

function parseAllowedUserIds(raw: string): number[] {
  return raw
    .split(/[,\s，、]+/)
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/** 新增/编辑镜像机器人：config JSON 写入 mirror 段，multi-runtime 按此分发到 createMirrorBot */
export async function saveMirrorBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const enabled = formData.get("enabled") === "1";
  const targetBot = String(formData.get("target_bot") ?? "").trim().replace(/^@/, "");
  const relayModeRaw = String(formData.get("relay_mode") ?? "auto").trim();
  const relayBaseUrl = String(formData.get("relay_base_url") ?? "").trim();
  const serializeModeRaw = String(formData.get("serialize_mode") ?? "global").trim();
  const actionTimeoutSeconds = Number(String(formData.get("action_timeout_seconds") ?? "60"));
  const mediaInlineMaxMb = Number(String(formData.get("media_inline_max_mb") ?? "20"));
  const allowedUserIds = parseAllowedUserIds(String(formData.get("allowed_user_ids") ?? ""));
  const rewriteRules = parseRewriteRules(String(formData.get("rewrite_rules") ?? ""));

  const isEdit = Boolean(idRaw && /^\d+$/.test(idRaw));
  if (!name) redirect(botPath({ error: "name-required" }));
  if (!targetBot) redirect(botPath({ error: "mirror-target-required" }));
  if (token && !/^\d{6,}:[\w-]{30,}$/.test(token)) {
    redirect(botPath({ error: "invalid-token" }));
  }
  if (!token && !isEdit) {
    redirect(botPath({ error: "invalid-token" }));
  }

  // 访问模式：open / verify_bot（绑定加群验证机器人）/ whitelist（显式用户 ID 列表）
  const accessModeRaw = String(formData.get("access_mode") ?? "open").trim();
  const accessMode =
    accessModeRaw === "verify_bot" || accessModeRaw === "whitelist" ? accessModeRaw : "open";
  const verifyBotIdRaw = Number(String(formData.get("verify_bot_id") ?? ""));
  const developerAccountIdRaw = Number(String(formData.get("developer_account_id") ?? ""));

  const requestHeaders = await headers();
  const existingForEdit = isEdit ? await getBot(BigInt(idRaw)) : null;
  if (isEdit && !existingForEdit) redirect(botPath({ error: "invalid-id" }));

  // 编辑时保留 mirror 以外的既有 profile 字段
  const profile = parseBotProfile(existingForEdit?.config ?? "{}");
  profile.mirror = {
    targetBot,
    relayMode: relayModeRaw === "inprocess" || relayModeRaw === "remote" ? relayModeRaw : "auto",
    relayBaseUrl: relayBaseUrl || undefined,
    developerAccountId:
      Number.isInteger(developerAccountIdRaw) && developerAccountIdRaw > 0
        ? developerAccountIdRaw
        : undefined,
    allowedUserIds: accessMode === "whitelist" ? allowedUserIds : [],
    accessMode,
    verifyBotId:
      accessMode === "verify_bot" && Number.isInteger(verifyBotIdRaw) && verifyBotIdRaw > 0
        ? verifyBotIdRaw
        : undefined,
    serializeMode: serializeModeRaw === "per_user" ? "per_user" : "global",
    actionTimeoutSeconds: Number.isFinite(actionTimeoutSeconds) ? actionTimeoutSeconds : 60,
    syncCommands: true,
    mediaInlineMaxMb: Number.isFinite(mediaInlineMaxMb) ? mediaInlineMaxMb : 20,
    rewriteRules,
  };
  const configJson = JSON.stringify(profile);

  if (accessMode === "verify_bot" && !(Number.isInteger(verifyBotIdRaw) && verifyBotIdRaw > 0)) {
    redirect(botPath({ error: "mirror-verify-bot-required" }));
  }

  const accessDetail =
    accessMode === "verify_bot"
      ? `绑定验证机器人 #${verifyBotIdRaw}`
      : accessMode === "whitelist"
        ? `白名单 ${allowedUserIds.length} 人`
        : "开放使用";

  if (isEdit) {
    const existing = existingForEdit!;
    await updateBotRecord(BigInt(idRaw), {
      name,
      token: token || existing.token,
      enabled,
      config: configJson,
    });
    if (enabled) {
      void restartMenuBot(BigInt(idRaw)).catch((error: unknown) => {
        console.error(`[bots] 镜像机器人 #${idRaw} 保存后重启失败:`, error);
      });
    } else {
      void stopMenuBot(BigInt(idRaw)).catch((error: unknown) => {
        console.error(`[bots] 镜像机器人 #${idRaw} 保存后停止失败:`, error);
      });
    }
    void syncBotUsername(token || existing.token, existing.id).catch((error: unknown) => {
      console.error(`[bots] 镜像机器人 #${existing.id} 回写用户名失败:`, error);
    });
    await logOperation(admin, {
      action: "保存镜像机器人",
      target: name,
      detail: `目标：@${targetBot}，${accessDetail}，状态：${enabled ? "启用" : "停用"}`,
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
    if (enabled) {
      void restartMenuBot(created.id).catch((error: unknown) => {
        console.error(`[bots] 新建镜像机器人 #${created.id} 启动失败:`, error);
      });
    }
    void syncBotUsername(token, created.id).catch((error: unknown) => {
      console.error(`[bots] 新建镜像机器人 #${created.id} 回写用户名失败:`, error);
    });
    await logOperation(admin, {
      action: "新增镜像机器人",
      target: name,
      detail: `目标：@${targetBot}，${accessDetail}`,
      headers: requestHeaders,
    });
  }
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "1" }));
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

export async function setBotGroupAdminAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("groups:manage");
  const botIdRaw = String(formData.get("bot_id") ?? "").trim();
  const chatIdRaw = String(formData.get("chat_id") ?? "").trim();
  if (!botIdRaw || !/^\d+$/.test(botIdRaw) || !chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    redirect(groupsPath({ error: "botadmin" }));
  }
  const bot = await getBot(BigInt(botIdRaw));
  if (!bot) redirect(groupsPath({ error: "botadmin" }));

  // 用户勾选的目标权限
  const rights: BotAdminRights = {};
  for (const key of BOT_ADMIN_RIGHT_KEYS) {
    rights[key] = formData.get(key) === "1";
  }
  const requireApproval = formData.get("require_approval") === "1";

  const chatId = BigInt(chatIdRaw);
  const chatIdNum = Number(chatId);
  // 保存结果附加提示（真实同步详情/指引），在成功横幅中展示
  let notice = "";
  try {
    // v1.2.0：轻量 API 客户端 + 全链路超时 + 并行化。
    // 原实现经 acquireMenuBot 启动完整轮询 runtime —— 无效 token（401）时启动链路
    // 卡死重试 20s+，公网网关直接 502；一次性管理操作不需要轮询实例。
    // v1.2.0：getMe 与 getChat 并行（getChat 仅作审批开关参考，失败不阻塞）——
    // 代理网关单次调用实测 5~13s，串行三连调把保存拖到 12s+
    const { botByToken, withTelegramTimeout, getMeCached } = await import("@/services/telegram-sync");
    const api = botByToken(bot.token).api;
    const mePromise = withTelegramTimeout(getMeCached(api, bot.token));
    const tgApprovalNotePromise = (async (): Promise<string> => {
      // TG 侧审批状态参考（Bot API 无设置/读取审批开关的方法，只能读主邀请链接语义）。
      // 当前 @grammyjs/types 下 getChat().invite_link 为 string；对象形态（ChatInviteLink）
      // 做前向兼容探测 —— 两种线格式都不臆造，按真实读取结果给注记
      try {
        const chat = await withTelegramTimeout(api.getChat(chatIdNum));
        const link: unknown = "invite_link" in chat ? chat.invite_link : undefined;
        if (link && typeof link === "object" && "creates_join_request" in link) {
          const creates = (link as { creates_join_request?: boolean }).creates_join_request === true;
          return creates
            ? "TG 侧主邀请链接为「需审批加入」"
            : "TG 侧主邀请链接为「直接加入」（全局审批开关需在 TG 客户端群设置→权限→审批新成员 开启）";
        }
      } catch {
        /* getChat 失败不阻塞保存 */
      }
      return "";
    })();
    const me = await mePromise;

    // 「加群需要管理员审核」开关（v1.1.9）：先落库到 group_settings（保留其它字段不动）
    const existingSettings = await getGroupSettings(chatId);
    await upsertGroupSettings(chatId, {
      chatTitle: existingSettings?.chatTitle ?? null,
      method: existingSettings?.method ?? "code_self",
      methodId: existingSettings?.methodId ?? null,
      timeoutSeconds: existingSettings?.timeoutSeconds,
      maxAttempts: existingSettings?.maxAttempts,
      promptText: existingSettings?.promptText,
      successText: existingSettings?.successText,
      failureText: existingSettings?.failureText,
      enabled: existingSettings?.enabled ?? true,
      privacyMode: existingSettings?.privacyMode ?? true,
      requireApproval,
    });

    // 读目标 bot 在群里的真实身份状态（真实同步的权威数据源）。
    // v1.2.0：getChatMember 不等 getChat 注记（两者互不依赖，
    // 网关单次 5~14s，串行等待会把保存拖到双倍时长）
    let member: Awaited<ReturnType<typeof api.getChatMember>>;
    try {
      member = await withTelegramTimeout(api.getChatMember(chatIdNum, me.id));
    } catch (error) {
      // 机器人不在群/群不可见：无法读取也无法提升 → 保存本地配置 + 指引
      await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(rights) });
      await updateBotRecord(bot.id, { username: me.username });
      const { describeSyncError } = await import("@/services/telegram-sync");
      const detail = describeSyncError(error).slice(0, 120);
      notice = `已保存权限配置，但机器人成员状态读取失败（${detail}）。请确认机器人已在群内并设为管理员：${PROMOTE_SELF_GUIDE}`;
      const requestHeaders = await headers();
      await logOperation(admin, {
        action: "设置群组机器人管理员（本地保存）",
        target: `${bot.name} → ${chatIdRaw}`,
        detail: notice,
        headers: requestHeaders,
      });
      revalidatePath("/admin/groups");
      redirect(groupsPath({ saved: "botadmin", message: notice.slice(0, 200) }));
    }

    if (member.status === "administrator") {
      // 已是管理员：以 Telegram 实际权限为准保存（真实同步）
      const actual = actualRightsFromMember(member);
      await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(actual) });
      await updateBotRecord(bot.id, { username: me.username });
      const diffKeys = BOT_ADMIN_RIGHT_KEYS.filter((key) => Boolean(rights[key]) !== Boolean(actual[key]));
      notice =
        diffKeys.length > 0
          ? `机器人已是本群管理员，已同步 Telegram 实际权限：${formatRights(actual)}（勾选与实际不一致${diffKeys.length} 项已按实际为准；Telegram 限制机器人无法修改自己的权限，如需调整请在 TG 客户端修改后重新保存同步）`
          : "机器人已是本群管理员，勾选权限与 Telegram 实际状态一致（已同步确认）";
    } else {
      // 非管理员：优先尝试跨 bot 提升（Bot API 唯一合法自动化路径）
      const promoter = await findPromoterBot(chatIdNum, bot.id);
      if (promoter) {
        await withTelegramTimeout(
          promoter.api.promoteChatMember(chatIdNum, me.id, {
          can_manage_chat: rights.can_manage_chat === true,
          can_change_info: rights.can_change_info === true,
          can_delete_messages: rights.can_delete_messages === true,
          can_invite_users: rights.can_invite_users === true,
          can_restrict_members: rights.can_restrict_members === true,
          can_pin_messages: rights.can_pin_messages === true,
          can_manage_video_chats: rights.can_manage_video_chats === true,
          can_promote_members: rights.can_promote_members === true,
          }),
        );
        // 复查真实状态，以实际权限保存
        const after = await withTelegramTimeout(promoter.api.getChatMember(chatIdNum, me.id));
        if (after.status === "administrator") {
          const actual = actualRightsFromMember(after);
          await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(actual) });
          notice = `已通过提升者 @${promoter.username ?? "bot"} 真实提升为管理员并同步实际权限：${formatRights(actual)}`;
        } else {
          await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(rights) });
          notice = "提升请求已发送，复查显示机器人尚未成为管理员（Telegram 可能延迟），已保存所配权限，稍后可重新保存同步";
        }
      } else {
        await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(rights) });
        await updateBotRecord(bot.id, { username: me.username });
        notice = `已保存权限配置。${PROMOTE_SELF_GUIDE}`;
      }
    }

    // 收口并行中的 getChat 审批注记（此时大概率已完成，不额外增加等待）
    const tgApprovalNote = await tgApprovalNotePromise;

    if (tgApprovalNote) {
      notice += `；${tgApprovalNote}`;
    }

    const requestHeaders = await headers();
    await logOperation(admin, {
      action: "设置群组机器人管理员",
      target: `${bot.name} → ${chatIdRaw}`,
      detail: notice,
      headers: requestHeaders,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
    // Next.js redirect() 抛出的特殊对象带 digest 属性，必须原样上抛
    const digest = (error as { digest?: string })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw error;
    // v1.2.0：401（Token 失效）与网络超时/不可达给出可读中文，替代原始 GrammyError 描述
    // （用户此前看到的「Call to 'getMe' failed! (401: Unauthorized)」即此处的原始透传）
    const { describeSyncError } = await import("@/services/telegram-sync");
    const detail =
      error instanceof GrammyError && error.error_code === 401
        ? INVALID_TOKEN_GUIDE
        : describeSyncError(error);
    redirect(groupsPath({ error: "botadmin", message: detail.slice(0, 200) }));
  }
  revalidatePath("/admin/groups");
  redirect(groupsPath({ saved: "botadmin", message: notice.slice(0, 300) }));
}

export async function removeBotGroupAdminAction(
  adminIdRaw: string,
  formData: FormData,
): Promise<void> {
  const admin = await requirePermission("groups:manage");
  // v1.2.0：主参数经 action.bind(null, adminId) 预绑定（React 官方推荐的传参方式），
  // 兼容旧版独立小表单的 formData 字段（remove_id / id）
  const idRaw =
    String(adminIdRaw ?? "").trim() ||
    String(formData.get("remove_id") ?? formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(groupsPath({ error: "botadmin" }));
  const record = await getGroupBotAdmin(BigInt(idRaw));
  if (!record) redirect(groupsPath({ error: "botadmin" }));
  const bot = await getBot(record.botId);

  // Telegram 侧真实撤销（v1.1.9）：机器人无法撤销自己的管理员身份，
  // 需借助其它「提升者」bot；无提升者时仅移除本地记录并提示手动操作
  let tgDemoted = false;
  if (bot && bot.token.trim()) {
    try {
      const { botByToken, withTelegramTimeout, getMeCached } = await import("@/services/telegram-sync");
      const targetApi = botByToken(bot.token).api;
      const targetMe = await withTelegramTimeout(getMeCached(targetApi, bot.token));
      const promoter = await findPromoterBot(Number(record.chatId), record.botId);
      if (promoter) {
        await withTelegramTimeout(
          promoter.api.promoteChatMember(Number(record.chatId), targetMe.id, {
            is_anonymous: false,
            can_manage_chat: false,
            can_change_info: false,
            can_delete_messages: false,
            can_invite_users: false,
            can_restrict_members: false,
            can_pin_messages: false,
            can_manage_video_chats: false,
            can_promote_members: false,
          }),
        );
        tgDemoted = true;
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
    detail: tgDemoted ? "已通过提升者 bot 真实撤销 Telegram 管理员身份" : "已移除本地记录（Telegram 侧撤销需在客户端手动操作或接入其它管理员 bot）",
    headers: requestHeaders,
  });
  revalidatePath("/admin/groups");
  redirect(
    groupsPath({
      saved: "botadmin-removed",
      message: tgDemoted ? "已真实撤销 Telegram 管理员身份" : "已移除本地记录；Telegram 侧管理员身份需在客户端手动移除",
    }),
  );
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
