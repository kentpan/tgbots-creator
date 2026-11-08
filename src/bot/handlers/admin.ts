import type { BotContext } from "../context";
import {
  getGlobalStats,
  getGroupSettings,
  getPendingCodeContext,
  resolveVerificationChannel,
  isSuperGroupChatId,
} from "@/database/operations";
import { formatBeijingDateTime } from "@/utils/datetime";
import { config } from "@/config/settings";
import { adminOnly } from "../filters";
import { mainMenu } from "../menus";
import { InlineKeyboard } from "grammy";
import { htmlEscape } from "@/utils/html";
import { codeQuestion } from "../verification-question";

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
    const superGroup = isSuperGroupChatId(chatId);
    const invite = await ctx.api.createChatInviteLink(Number(chatId), {
      ...(superGroup ? { creates_join_request: true } : {}),
      name: "TGuard 加群验证",
    });
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
      { reply_markup: new InlineKeyboard().url("🔄 申请加入群组", invite.invite_link) },
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
          promptText: pending.settings?.promptText ?? "🔐 请回复本消息并输入验证码完成验证",
          code: pending.session.expectedCode,
          expiresAt: pending.session.expiresAt,
          contextLabel: "/start resend",
        });
        return;
      }
      const promptText = pending.settings?.promptText ?? "🔐 请回复本消息并输入验证码完成验证";
      // 隐私红线（同 code-input.ts）：/start 可能在群里输入，有 pending 会话时
      // 验证提示必须私聊发送；不用 ctx.reply（force_reply 提示会落到当前群聊），
      // 发送失败由 grammY bot.catch 全局兜底并记录
      await ctx.api.sendMessage(ctx.from.id, htmlEscape(promptText) + codeQuestion.messageSuffixHTML(), {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "输入验证码",
        },
      });
      return;
    }
  }

  await ctx.reply(
    "🤖 *TGuard 群组验证机器人*\n\n" +
      "🛡️ *自动验证新成员身份，防止机器人和恶意用户进入群组*\n\n" +
      "*功能：*\n" +
      "• 新成员申请加群时自动发送验证链接\n" +
      "• 通过人机验证后自动批准加群\n" +
      "• 支持多种验证码服务\\(hCaptcha、Cap\\.js、Turnstile\\)\n\n" +
      "使用 `/help` 查看更多信息\n\n" +
      "👇 也可以直接点击下方菜单按钮：",
    // @grammyjs/menu 官方约束：Menu 实例只能发给安装它的 bot —— 菜单 bot 实例
    // 优先发自己安装的菜单（ctx.botMenu），主 bot 无 botMenu 注入走全局 mainMenu
    { parse_mode: "MarkdownV2", reply_markup: ctx.botMenu ?? mainMenu },
  );
}

export async function cmdHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "🤖 *TGuard 群组验证机器人*\n\n" +
      "🛡️ *自动验证新成员身份，防止机器人和恶意用户进入群组*\n\n" +
      "*使用说明：*\n" +
      "如何使用请见 [README](https://github.com/SideCloudGroup/TGuard/blob/main/README.md)\n\n" +
      "*技术支持：*\n" +
      "由 [TGuard](https://github.com/SideCloudGroup/TGuard) 提供技术支持",
    {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    },
  );
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
