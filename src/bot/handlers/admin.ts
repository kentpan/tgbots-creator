import type { BotContext } from "../context";
import {
  getGlobalStats,
  getGroupSettings,
  getPendingCodeContext,
  listBots,
  resolveVerificationChannel,
  isSuperGroupChatId,
} from "@/database/operations";
import { acquireStableGroupInviteLink } from "@/services/invite-link";
import { formatBeijingDateTime } from "@/utils/datetime";
import { config } from "@/config/settings";
import { adminOnly } from "../filters";
import { mainMenu } from "../menus";
import { InlineKeyboard } from "grammy";
import { htmlEscape } from "@/utils/html";
import { DEFAULT_BOT_HELP_MARKDOWN_V2, DEFAULT_BOT_START_WELCOME_MARKDOWN_V2 } from "@/services/bot-messages";

/**
 * /start —— 三段式入口（v1.1.3）：
 * ① 深链 /start join_<chatId>：回复「申请加入群组」按钮（入群申请链接，需机器人审批）。
 *    这是买家从站外进入的唯一推荐入口：先启动机器人 → 私聊可达 → 申请加群 → 私聊验证 → 审批入群，
 *    全程群内零消息。
 * ② 有未完成的验证会话：重发验证提示（覆盖「申请加群时还没点开始」的用户，
 *    之前私聊不可达，现在点了开始即可继续验证，无需重新申请）。
 * ③ 默认欢迎语。
 */
export async function cmdStart(ctx: BotContext): Promise<void> {
  // bot.command 注册下 ctx.match = 「/start」之后的原始参数（深链 t.me/bot?start=join_x → "join_x"）
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (payload.startsWith("join_")) {
    const rawChatId = payload.slice("join_".length);
    let chatId: bigint;
    try {
      chatId = BigInt(rawChatId);
    } catch {
      await ctx.reply("⚠️ 加群链接不合法，请联系管理员获取新的入群链接。");
      return;
    }
    const settings = await getGroupSettings(chatId);
    if (!settings || settings.enabled === false) {
      await ctx.reply("⚠️ 该群组未启用加群验证，暂不接受入群申请。");
      return;
    }
    // v2.0.12：基础群不支持 creates_join_request 邀请链接（Telegram 限制），
    // 自动回退普通链接（买家点链接直接进群 → chat_member 补验证私聊发码）
    // v2.0.14：不再每次 /start 都新建一条链接（旧实现买家每点一次深链就多一条
    // 链接，且与一键部署保存的链接不一致）—— 统一走规范链接管道：优先复用
    // 一键部署保存的链接（editChatInviteLink 存活探测，死链自动重建并落库），
    // 保证买家拿到的永远与部署面板展示的是同一条有效链接。
    const superGroup = isSuperGroupChatId(chatId);
    let inviteLink: string;
    try {
      const bots = await listBots();
      const botRow = bots.find((item) => item.enabled && item.token === ctx.api.token);
      const acquired = await acquireStableGroupInviteLink({
        api: ctx.api,
        chatId,
        superGroup,
        requireApproval: settings.requireApproval,
        botId: botRow?.id ?? null,
        meta: { chat_title: settings.chatTitle ?? null },
      });
      inviteLink = acquired.invite_link;
    } catch (error) {
      console.error("cmdStart: acquire invite link failed:", error);
      await ctx.reply("⚠️ 生成入群链接失败，请稍后重试；若持续失败请联系管理员重新部署该群组。");
      return;
    }
    const title = settings.chatTitle ?? "群组";
    // v2.0.12 三态验证渠道文案：群内模式（超级群 auto/显式 group）申请后自动进群、群内按钮验证；
    // 私聊模式保持 v1.1.3 文案（私聊提示、群内零消息）；基础群提示直连入群补验证
    const flowLines =
      resolveVerificationChannel(settings, chatId) === "group"
        ? "• 提交申请后将自动批准进群，并在群内完成验证\n" +
          "• 在群内点击验证按钮即可（输入内容其他成员不可见）"
        : "• 验证提示将由本机器人私聊发送（群里看不到）\n" +
          "• 按私聊提示输入验证码，校验通过后自动进群";
    await ctx.reply(
      `🔐 点击下方按钮申请加入「${title}」。\n\n${flowLines}`,
      { reply_markup: new InlineKeyboard().url("🔄 申请加入群组", inviteLink) },
    );
    return;
  }

  if (ctx.from && !ctx.from.is_bot) {
    const pending = await getPendingCodeContext(BigInt(ctx.from.id));
    if (pending) {
      // v1.1.7 code_self：重发含验证码的完整提示（验证码随会话落库，重发同一码，
      // 与首次发送文案一致）；code_api 仍走原提示（验证码在用户手里/外部系统）
      if (pending.session.method === "code_self" && pending.session.expectedCode) {
        const { sendCodeSelfPrompt } = await import("../verification-prompt");
        await sendCodeSelfPrompt(ctx.api, ctx.from.id, {
          promptText: pending.settings?.promptText ?? "🔐 请在下方输入框直接发送验证码完成验证",
          code: pending.session.expectedCode,
          expiresAt: pending.session.expiresAt,
          contextLabel: "/start resend",
        });
        return;
      }
      const promptText = pending.settings?.promptText ?? "🔐 请在下方输入框直接发送验证码完成验证";
      // /start 可能在群里输入，有 pending 会话时仍只向用户私聊发送提示。
      // 私聊不受群隐私模式限制，用户直接发送文本即可，无需 force_reply。
      await ctx.api.sendMessage(
        ctx.from.id,
        `${htmlEscape(promptText)}\n\n请直接在下方输入框发送验证码，无需回复本消息。`,
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }
  }

  // 可配置欢迎语优先于默认欢迎文案；按当前界面模式挂载对应键盘/菜单。
  const configuredWelcome = ctx.startWelcomeText?.trim();
  if (configuredWelcome) {
    const welcome = configuredWelcome
      .replaceAll("{{bot_name}}", ctx.me?.first_name ?? "TGuard")
      .replaceAll("{{bot_username}}", ctx.me?.username ? `@${ctx.me.username}` : "");
    const markup =
      ctx.interfaceKeyboardMode && ctx.customKeyboard
        ? ctx.customKeyboard
        : ctx.interfaceMenuEnabled === false
          ? undefined
          : ctx.botMenu ?? mainMenu;
    await ctx.reply(welcome, {
      ...(markup ? { reply_markup: markup } : {}),
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  // v2.3 界面模式互斥：键盘模式 = 欢迎语 + 自定义键盘（不发内嵌菜单）；
  // 内嵌按钮面板关闭 = 纯文本欢迎（不发菜单）；否则 = 欢迎语 + 内嵌菜单
  if (ctx.interfaceMenuEnabled === false) {
    await ctx.reply(
      "🤖 *TGuard 机器人*\n\n发送 /help 查看可用指令。",
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  if (ctx.interfaceKeyboardMode && ctx.customKeyboard) {
    await ctx.reply(
      "🤖 *TGuard 机器人*\n\n👇 请使用下方自定义键盘按钮：",
      { parse_mode: "MarkdownV2", reply_markup: ctx.customKeyboard },
    );
    return;
  }

  await ctx.reply(
    DEFAULT_BOT_START_WELCOME_MARKDOWN_V2,
    // @grammyjs/menu 官方约束：Menu 实例只能发给安装它的 bot —— 菜单 bot 实例
    // 优先发自己安装的菜单（ctx.botMenu），主 bot 无 botMenu 注入走全局 mainMenu
    { parse_mode: "MarkdownV2", reply_markup: ctx.botMenu ?? mainMenu },
  );
  // v2.3：内嵌模式下不注入 ctx.customKeyboard（multi-runtime 已按界面模式互斥注入），
  // 此分支仅作为主 bot（无界面模式标记）的旧语义兜底保留
  if (ctx.customKeyboard && ctx.interfaceKeyboardMode === undefined) {
    await ctx.reply("👇 请使用下方自定义键盘按钮：", { reply_markup: ctx.customKeyboard });
  }
}

export async function cmdHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(DEFAULT_BOT_HELP_MARKDOWN_V2, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
  });
}

// v2.0.13：机器人消息内时间统一北京时间（服务器时区为 UTC，用户在国内）
function formatDateTime(date: Date): string {
  return formatBeijingDateTime(date);
}

function formatRate(rate: number): string {
  return rate.toFixed(1);
}

export async function cmdStats(ctx: BotContext): Promise<void> {
  try {
    const stats = await getGlobalStats();

    if (!stats) {
      await ctx.reply(
        "❌ *无法获取统计数据*\n\n" +
          "请检查数据库连接状态",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const currentDateTime = formatDateTime(new Date());

    const statsText =
      "📊 *TGuard 统计信息*\n" +
      `⏰ 更新时间：\`${currentDateTime}\`\n\n` +
      "📈 *总体统计*\n" +
      `• 总验证请求：\`${stats.total_requests}\`\n` +
      `• 已通过：\`${stats.approved}\`\n` +
      `• 已拒绝：\`${stats.rejected}\`\n` +
      `• 待处理：\`${stats.pending}\`\n` +
      `• 已过期：\`${stats.expired}\`\n` +
      `• 通过率：\`${formatRate(stats.approval_rate)}%\`\n\n` +
      "📅 *今日统计*\n" +
      `• 今日请求：\`${stats.today_total}\`\n` +
      `• 今日通过：\`${stats.today_approved}\`\n` +
      `• 今日通过率：\`${formatRate(stats.today_approval_rate)}%\``;

    await ctx.reply(statsText, { parse_mode: "MarkdownV2" });
  } catch (error) {
    console.error("Error in stats command:", error);
    await ctx.reply(
      "❌ *获取统计数据时发生错误*\n\n" +
        "请稍后重试",
      { parse_mode: "MarkdownV2" },
    );
  }
}

export async function cmdApi(ctx: BotContext): Promise<void> {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("⚠️ 为避免泄露 API Key，请在与机器人的私聊中使用此命令");
    return;
  }

  try {
    const apiConfig = config.api;

    let apiText: string;
    if (apiConfig.enable) {
      apiText =
        "🔌 *API 状态：已启用*\n\n" +
        "🌐 *服务器地址：*\n" +
        `\`${apiConfig.baseUrl}\`\n\n` +
        "🔑 *API Key：*\n" +
        `\`${apiConfig.apiKey}\`\n\n` +
        "⚠️ *注意：请妥善保管您的 API Key*";
    } else {
      apiText =
        "🔌 *API 状态：未启用*\n\n" +
        "请在配置文件中设置 `api.enable = true` 来启用 API 功能";
    }

    await ctx.reply(apiText, { parse_mode: "MarkdownV2" });
  } catch (error) {
    console.error("Error in api command:", error);
    await ctx.reply(
      "❌ *获取 API 信息时发生错误*\n\n" +
        "请稍后重试",
      { parse_mode: "MarkdownV2" },
    );
  }
}

export function setupAdminHandlers(bot: import("grammy").Bot<BotContext>): void {
  bot.command("start", cmdStart);
  bot.command("help", cmdHelp);
  bot.command("stats", adminOnly, cmdStats);
  bot.command("api", adminOnly, cmdApi);
}
