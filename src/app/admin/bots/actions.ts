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
  upsertGroupSettings,
  updateBotRecord,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import { parseBotMenuConfig, sendMenuMessage, validateMenuConfig, renderMenuMarkup } from "@/services/bot-menu";
import { parseCustomKeyboardConfig } from "@/services/custom-keyboard";
import { deployBotAndReport } from "@/services/bot-deploy";
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
  saveGroupBotAdminRights,
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

/**
 * 通用显式部署（v2.1.10 整合）：唯一实现在 services/bot-deploy.ts（deployBotAndReport），
 * 机器人管理页列表「🚀 部署」按钮与 TGAPI 申请页列表「🚀 部署」是同一实现的两个入口。
 * 重启运行实例并按生效传输模式取真实结果（webhook=setWebhook 注册结果 /
 * polling=getMe 确认），成败原因随 redirect 回显到页面横幅；停用状态下拒绝部署。
 */
export async function deployBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));
  if (!bot.enabled) {
    redirect(botPath({ deploy: "fail", deploy_msg: "机器人已停用：请先启用后再部署" }));
  }
  const deploy = await deployBotAndReport(BigInt(idRaw), true);
  await logOperation(admin, {
    action: "部署机器人",
    target: bot.name,
    detail: deploy.message,
    headers: await headers(),
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ deploy: deploy.state, deploy_msg: deploy.message }));
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

/**
 * 保存机器人自定义键盘（v2.2.0）：「自定义键盘」弹窗提交 ——
 * 写入 bots.config JSON 顶层 customKeyboard 段（通用机器人附加到 /start 欢迎消息，
 * 按钮点击按配置真实响应）；保存后热更新运行实例（配置即时生效）。
 * 空提交 = 清除自定义键盘（机器人回到纯消息内嵌按钮形态）。
 */
export async function saveBotCustomKeyboardAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const keyboardRaw = String(formData.get("custom_keyboard") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(botPath({ error: "invalid-id" }));

  const profile = parseBotProfile(bot.config);
  if (keyboardRaw) {
    let source: unknown;
    try {
      source = JSON.parse(keyboardRaw);
    } catch {
      redirect(botPath({ error: "invalid-keyboard" }));
    }
    const parsed = parseCustomKeyboardConfig(source);
    if (!parsed) redirect(botPath({ error: "invalid-keyboard" }));
    profile.customKeyboard = parsed;
  } else {
    delete profile.customKeyboard;
  }

  await updateBotRecord(bot.id, { config: JSON.stringify(profile) });
  if (bot.enabled) {
    void restartMenuBot(bot.id).catch((error: unknown) => {
      console.error(`[bots] 自定义键盘保存后重启运行实例失败（#id ${bot.id}）:`, error);
    });
  }
  await logOperation(admin, {
    action: keyboardRaw ? "保存机器人自定义键盘" : "清除机器人自定义键盘",
    target: bot.name,
    headers: await headers(),
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "keyboard" }));
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
  // v2.1.1：「加群审核」开关已从弹窗移除（Bot API 无法远程修改该群级开关，旧可点开关为误导性展示）。
  // 表单不再提交 require_approval —— 缺失时传 undefined（upsert 语义：保持现有值不变），
  // 绝不能把旧实现默认的 false 覆盖写入。
  const requireApprovalRaw = formData.get("require_approval");
  const requireApproval = requireApprovalRaw === null ? undefined : requireApprovalRaw === "1";

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
      await saveGroupBotAdminRights(bot.id, chatId, rights);
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
      await saveGroupBotAdminRights(bot.id, chatId, actual);
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
          await saveGroupBotAdminRights(bot.id, chatId, actual);
          notice = `已通过提升者 @${promoter.username ?? "bot"} 真实提升为管理员并同步实际权限：${formatRights(actual)}`;
        } else {
          await saveGroupBotAdminRights(bot.id, chatId, rights);
          notice = "提升请求已发送，复查显示机器人尚未成为管理员（Telegram 可能延迟），已保存所配权限，稍后可重新保存同步";
        }
      } else {
        await saveGroupBotAdminRights(bot.id, chatId, rights);
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
  void restartMenuBot(existing.id).catch((error: unknown) => {
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
  void restartMenuBot(existing.id).catch((error: unknown) => {
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
    void restartMenuBot(existing.id).catch((error: unknown) => {
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

/**
 * 保存机器人「功能配置」弹窗（v2.3，feature 形态统一保存）：
 * 一次落库：基本信息（名称/Token/启用）+ menu_config + 界面互斥（kb_mode）+
 * customKeyboard + privacyMode/commandIds + 功能面板开关（menu/commands/keyboardEnabled）+
 * 加群验证（bots.config.joinVerify）+ 通用门禁（bots.config.gate）。
 * 验证方式/参数覆盖只写 bot 配置，绝不回写验证方式库；保存后热更新运行实例。
 */
export async function saveBotFeatureConfigAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("bots:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const enabled = formData.get("enabled") === "1";
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(botPath({ error: "invalid-id" }));
  if (!name) redirect(botPath({ error: "name-required" }));
  const existing = await getBot(BigInt(idRaw));
  if (!existing) redirect(botPath({ error: "invalid-id" }));
  if (token && !/^\d{6,}:[\w-]{30,}$/.test(token)) redirect(botPath({ error: "invalid-token" }));

  const profile = parseBotProfile(existing.config);
  const next = profile as unknown as Record<string, unknown>;

  // /start 欢迎文案（纯文本，保存在 bots.config JSON，不新增数据库列/D1 写入）。
  if (formData.has("welcome_text")) {
    const welcomeText = String(formData.get("welcome_text") ?? "").replace(/\r\n?/g, "\n");
    if (welcomeText.length > 3500) redirect(botPath({ error: "welcome-too-long" }));
    if (welcomeText.trim()) next.welcomeText = welcomeText;
    else delete next.welcomeText;
  }

  // —— 隐私模式 + 指令勾选（与 saveTgApiBotAction / saveBotCommandMenuAction 同存储位） ——
  const privacyRaw = formData.get("privacyMode");
  if (privacyRaw !== null) next.privacyMode = privacyRaw === "1";
  const commandIdsRaw = formData.get("commandIds");
  if (commandIdsRaw !== null) {
    let commandIds: number[] = [];
    try {
      const parsedIds = JSON.parse(String(commandIdsRaw)) as unknown;
      if (Array.isArray(parsedIds)) {
        commandIds = parsedIds.map(Number).filter((item) => Number.isInteger(item) && item > 0);
      }
    } catch {
      redirect(botPath({ error: "invalid-commands" }));
    }
    next.commandIds = commandIds;
  }

  // —— 界面互斥 + 自定义键盘（键盘载荷空串 = 清空配置，与 TGAPI 保存同语义） ——
  const kbModeRaw = String(formData.get("kb_mode") ?? "").trim();
  if (kbModeRaw === "inline" || kbModeRaw === "keyboard") {
    next.interfaceMode = kbModeRaw;
  }
  const keyboardRaw = String(formData.get("custom_keyboard") ?? "").trim();
  if (formData.has("custom_keyboard")) {
    if (keyboardRaw) {
      let source: unknown;
      try {
        source = JSON.parse(keyboardRaw);
      } catch {
        redirect(botPath({ error: "invalid-keyboard" }));
      }
      const parsedKeyboard = parseCustomKeyboardConfig(source);
      if (!parsedKeyboard) redirect(botPath({ error: "invalid-keyboard" }));
      next.customKeyboard = parsedKeyboard;
    } else {
      delete next.customKeyboard;
    }
  }

  // —— 功能面板开关（显式 boolean；表单缺字段不触碰） ——
  // 表单字段 snake_case → config camelCase 映射（与 parseBotFeatureConfig 读取键一致，
  // 修复"保存后重新打开弹窗 checkbox 未回显"根因）
  const FEAT_FLAG_MAP: Record<string, string> = {
    menu_enabled: "menuEnabled",
    commands_enabled: "commandsEnabled",
    keyboard_enabled: "keyboardEnabled",
    gate_menu_required: "gateMenuRequired",
    gate_keyboard_required: "gateKeyboardRequired",
    gate_commands_required: "gateCommandsRequired",
  };
  const readFlag = (key: string): void => {
    const raw = formData.get(key);
    if (raw !== null) next[FEAT_FLAG_MAP[key] ?? key] = raw === "1";
  };
  readFlag("menu_enabled");
  readFlag("commands_enabled");
  readFlag("keyboard_enabled");

  // —— 加群验证（bots.config.joinVerify）：方式单选 + 超时/次数覆盖 ——
  if (formData.has("join_verify_enabled")) {
    const methodIdRaw = String(formData.get("join_verify_method_id") ?? "").trim();
    const timeoutRaw = Number(formData.get("join_verify_timeout") ?? "");
    const attemptsRaw = Number(formData.get("join_verify_attempts") ?? "");
    const override: Record<string, number> = {};
    if (Number.isFinite(timeoutRaw) && timeoutRaw >= 1) override.timeout_seconds = Math.floor(timeoutRaw);
    if (Number.isFinite(attemptsRaw) && attemptsRaw >= 1) override.max_attempts = Math.floor(attemptsRaw);
    next.joinVerify = {
      enabled: formData.get("join_verify_enabled") === "1",
      methodId: methodIdRaw && /^\d+$/.test(methodIdRaw) ? methodIdRaw : null,
      ...(Object.keys(override).length > 0 ? { override } : {}),
    };
  }

  // —— 面板门禁开关（内嵌按钮/键盘/指令三面板各一） ——
  const readGateFlag = (key: string): void => {
    const raw = formData.get(key);
    if (raw !== null) next[FEAT_FLAG_MAP[key] ?? key] = raw === "1";
  };
  readGateFlag("gate_menu_required");
  readGateFlag("gate_keyboard_required");
  readGateFlag("gate_commands_required");

  // —— 通用门禁（bots.config.gate）：绑定验证方式（v2.3 星星解锁已移除，固定验证码解锁） ——
  if (formData.has("gate_enabled")) {
    const gateMethodIdRaw = String(formData.get("verification_method_id") ?? "").trim();
    next.gate = {
      enabled: formData.get("gate_enabled") === "1",
      verificationMethodId: gateMethodIdRaw && /^\d+$/.test(gateMethodIdRaw) ? gateMethodIdRaw : null,
    };
  }

  // —— 内嵌按钮配置（menu_config payload，轻校验同 saveTgApiBotAction） ——
  const menuConfigRaw = String(formData.get("menu_config") ?? "").trim();
  let menuConfigJson: string | null = null;
  let menuTextValue: string | null = null;
  if (menuConfigRaw) {
    try {
      const parsed = parseBotMenuConfig(menuConfigRaw);
      menuConfigJson = JSON.stringify({ content: parsed.content, root: parsed.root });
      menuTextValue = parsed.content.text;
    } catch {
      redirect(botPath({ error: "invalid-menu" }));
    }
  }

  await updateBotRecord(BigInt(idRaw), {
    name,
    token: token || existing.token,
    enabled,
    config: JSON.stringify(profile),
    ...(menuConfigJson ? { menuConfig: menuConfigJson, menuText: menuTextValue ?? "" } : {}),
  });

  // 保存后热更新运行实例（启用中的实例即时应用新配置；失败全量输出日志不静默）
  // fire-and-forget：不 await 重启，避免 Telegram API + grammy 初始化的同步耗时
  // 触发 edge Worker "exceeded resource limits" 503；与 saveBotAction 等同款 void 模式
  if (enabled) {
    void restartMenuBot(BigInt(idRaw)).catch((error: unknown) => {
      console.error(`[bots] 功能配置保存后重启运行实例失败（#id ${idRaw}）:`, error);
    });
  }

  await logOperation(admin, {
    action: "保存机器人功能配置",
    target: name,
    detail: `面板：内嵌按钮=${formData.get("menu_enabled") ?? "?"} 指令=${formData.get("commands_enabled") ?? "?"} 键盘=${formData.get("keyboard_enabled") ?? "?"}；加群验证=${formData.get("join_verify_enabled") ?? "?"}；门禁=${formData.get("gate_enabled") ?? "?"}`,
    headers: await headers(),
  });
  revalidatePath("/admin/bots");
  redirect(botPath({ saved: "1" }));
}
