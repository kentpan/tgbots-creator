import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { adminOnly, isAdmin } from "../filters";
import { mainMenu } from "../menus";
import { cmdStart, cmdHelp, cmdStats, cmdApi } from "./admin";
import { APP_VERSION } from "@/lib/app-version";
import { getGlobalStats } from "@/database/operations";
import { config } from "@/config/settings";
import type { MenuCommandRegistry, MenuCommandRunner } from "@/services/bot-menu";

/**
 * 官方内置指令真实处理器注册表（v1.1.0）。
 *
 * 每条内置指令都有真实的 grammY 处理逻辑，按使用频率排序（start 最常用），
 * 与「指令管理」内置指令库一一对应：库中启用的指令才会注册到运行中的机器人。
 * 未在注册表中出现的内置条目（管理员自建的内置名）回退为回复其中文介绍。
 */

export interface BuiltinCommandHandler {
  handler: (ctx: BotContext) => Promise<void>;
  /** 仅管理员可用（TGuard config.toml adminIds） */
  adminOnly?: boolean;
  /** 仅私聊可用 */
  privateOnly?: boolean;
  /** 仅群组可用 */
  groupOnly?: boolean;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

const SHANGHAI_TZ = "Asia/Shanghai";

function formatShanghai(date: Date): string {
  return date.toLocaleString("zh-CN", {
    timeZone: SHANGHAI_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isGroupChat(ctx: BotContext): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/** 回复目标用户：要求对目标消息回复使用管理指令 */
function targetFromReply(ctx: BotContext): { id: number; name: string; messageId?: number } | null {
  const replied = ctx.message?.reply_to_message?.from;
  if (replied && !replied.is_bot) {
    const name = [replied.first_name, replied.last_name].filter(Boolean).join(" ") || String(replied.id);
    return { id: replied.id, name, messageId: ctx.message?.reply_to_message?.message_id };
  }
  return null;
}

/** 群组管理指令公共壳：校验群组/目标后执行 */
async function moderationGuard(
  ctx: BotContext,
  usage: string,
): Promise<{ chatId: number; target: { id: number; name: string; messageId?: number } } | null> {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.reply("⚠️ 该指令仅在群组中可用，且需要对目标用户的消息回复使用。");
    return null;
  }
  const target = targetFromReply(ctx);
  if (!target) {
    await ctx.reply(`⚠️ 请先回复目标用户的消息，再使用：\n${usage}`);
    return null;
  }
  return { chatId: ctx.chat.id, target };
}

function humanizeTelegramError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

// ---------------------------------------------------------------------------
// 基础指令（全员可用）
// ---------------------------------------------------------------------------

/** /menu — 打开主菜单 */
export async function cmdMenu(ctx: BotContext): Promise<void> {
  // @grammyjs/menu 官方约束：Menu 实例只能发给安装它的 bot —— 菜单 bot 实例
  // 优先发自己安装的菜单（ctx.botMenu），主 bot 无 botMenu 注入走全局 mainMenu
  await ctx.reply("👇 请通过下方菜单按钮继续操作：", { reply_markup: ctx.botMenu ?? mainMenu });
}

/** /about — 关于本机器人 */
export async function cmdAbout(ctx: BotContext): Promise<void> {
  const lines =
    "🤖 *关于本机器人*\n\n" +
    `• 名称：${ctx.me.first_name}${ctx.me.username ? ` (@${ctx.me.username})` : ""}\n` +
    `• 引擎：grammY + Telegram Bot API\n` +
    `• 框架：TGuard v${APP_VERSION}\n` +
    "• 能力：入群验证 / 群组管理 / AI 客服 / 指令菜单\n\n" +
    "由 [TGuard](https://github.com/SideCloudGroup/TGuard) 强力驱动";
  await ctx.reply(lines, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } });
}

/** /id — 查询当前聊天与用户 ID */
export async function cmdId(ctx: BotContext): Promise<void> {
  const lines: string[] = [];
  if (ctx.from) lines.push(`• 你的用户 ID：\`${ctx.from.id}\``);
  if (ctx.chat) {
    lines.push(`• 当前聊天 ID：\`${ctx.chat.id}\``);
    lines.push(`• 聊天类型：${ctx.chat.type}`);
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      lines.push(`• 群组名称：${ctx.chat.title ?? "—"}`);
    }
  }
  if (ctx.message?.message_thread_id !== undefined) {
    lines.push(`• 话题 ID：\`${ctx.message.message_thread_id}\``);
  }
  await ctx.reply(`🆔 *ID 信息*\n\n${lines.join("\n")}`, { parse_mode: "MarkdownV2" });
}

/** /info — 查看用户信息（可回复目标消息） */
export async function cmdInfo(ctx: BotContext): Promise<void> {
  const target = ctx.message?.reply_to_message?.from ?? ctx.from;
  if (!target) {
    await ctx.reply("⚠️ 无法识别用户。");
    return;
  }
  const lines = [
    `• 用户 ID：\`${target.id}\``,
    `• 姓名：${[target.first_name, target.last_name].filter(Boolean).join(" ") || "—"}`,
    `• 用户名：${target.username ? `@${target.username}` : "无"}`,
    `• 是否机器人：${target.is_bot ? "是" : "否"}`,
  ];
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, target.id);
      const statusMap: Record<string, string> = {
        creator: "群主",
        administrator: "管理员",
        member: "普通成员",
        restricted: "受限成员",
        left: "未入群",
        kicked: "已被封禁",
      };
      lines.push(`• 群内身份：${statusMap[member.status] ?? member.status}`);
    } catch {
      lines.push("• 群内身份：获取失败");
    }
  }
  await ctx.reply(`👤 *用户信息*\n\n${lines.join("\n")}`, { parse_mode: "MarkdownV2" });
}

/** /ping — 检测机器人响应延迟 */
export async function cmdPing(ctx: BotContext): Promise<void> {
  const started = Date.now();
  try {
    await ctx.api.getMe();
    const latency = Date.now() - started;
    await ctx.reply(`🏓 Pong！\n\n• Bot API 往返延迟：\`${latency} ms\``, { parse_mode: "MarkdownV2" });
  } catch (error) {
    await ctx.reply(`🏓 Pong（API 探测失败：${humanizeTelegramError(error)}）`);
  }
}

/** /time — 查看服务器时间 */
export async function cmdTime(ctx: BotContext): Promise<void> {
  const now = new Date();
  await ctx.reply(
    `🕐 *服务器时间*\n\n• 北京时间：\`${formatShanghai(now)}\`\n• 时区：\`${SHANGHAI_TZ}\``,
    { parse_mode: "MarkdownV2" },
  );
}

/** /cancel — 取消当前操作 */
export async function cmdCancel(ctx: BotContext): Promise<void> {
  ctx.session = {};
  await ctx.reply("✅ 已取消当前操作。如需重新开始，请发送 /start。");
}

/** /rules — 查看群规（读取群组描述） */
export async function cmdRules(ctx: BotContext): Promise<void> {
  if (!ctx.chat) {
    await ctx.reply("⚠️ 无法识别当前聊天。");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("⚠️ 群规仅在群组中提供，请进入群组后使用 /rules。");
    return;
  }
  try {
    const chat = await ctx.api.getChat(ctx.chat.id);
    const description = "description" in chat ? String(chat.description ?? "").trim() : "";
    if (description) {
      await ctx.reply(`📜 *${ctx.chat.title ?? "群规"}* 群规\n\n${description}`, { parse_mode: "MarkdownV2" });
    } else {
      await ctx.reply(
        "📜 本群尚未设置群规。\n\n提示：管理员可在 Telegram 群组设置 →「描述」中填写群规，成员使用 /rules 即可查看。",
      );
    }
  } catch (error) {
    await ctx.reply(`❌ 获取群规失败：${humanizeTelegramError(error)}`);
  }
}

/** /report — 举报违规消息（转发给群管理员） */
export async function cmdReport(ctx: BotContext): Promise<void> {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("⚠️ 举报功能仅在群组中可用：请回复要举报的消息使用 /report。");
    return;
  }
  const reported = ctx.message?.reply_to_message;
  if (!reported) {
    await ctx.reply("⚠️ 请先回复要举报的消息，再发送 /report。");
    return;
  }
  try {
    const admins = await ctx.api.getChatAdministrators(chat.id);
    let notified = 0;
    for (const admin of admins) {
      if (admin.user.is_bot || admin.user.id === ctx.from?.id) continue;
      try {
        await ctx.api.sendMessage(
          admin.user.id,
          `🚨 收到群组举报\n\n• 群组：${chat.title}\n• 举报人：${ctx.from ? `${[ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")} (${ctx.from.id})` : "未知"}\n• 被举报用户：${reported.from ? `${[reported.from.first_name, reported.from.last_name].filter(Boolean).join(" ")} (${reported.from.id})` : "未知"}`,
        );
        notified += 1;
      } catch {
        /* 管理员私聊不可达时跳过 */
      }
    }
    await ctx.reply(
      notified > 0
        ? `🚨 已收到举报，并私下通知了 ${notified} 位群管理员，感谢你的贡献。`
        : "🚨 已收到举报（管理员私聊通知失败，请管理员检查隐私设置）。",
      { reply_parameters: { message_id: reported.message_id, allow_sending_without_reply: true } },
    );
  } catch (error) {
    await ctx.reply(`❌ 举报处理失败：${humanizeTelegramError(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 管理指令
// ---------------------------------------------------------------------------

/** /admin — 管理面板入口 */
export async function cmdAdminPanel(ctx: BotContext): Promise<void> {
  let baseUrl = "";
  try {
    const { getTelegramRuntimeSettings } = await import("@/services/bot-transport");
    const settings = await getTelegramRuntimeSettings();
    baseUrl = settings.webhookBaseUrl?.trim() ?? "";
  } catch {
    /* 设置不可用时提示通用入口 */
  }
  const panel = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/admin` : "TGuard 管理后台（/admin）";
  await ctx.reply(
    `🛠 *管理面板*\n\n• 入口：${panel}\n• 凭据：管理员账号登录\n\n支持机器人管理、群组配置、验证方式与数据统计。`,
    { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } },
  );
}

/** /settings — 查看机器人当前设置摘要 */
export async function cmdSettings(ctx: BotContext): Promise<void> {
  let statsText = "";
  try {
    const stats = await getGlobalStats();
    if (stats) {
      statsText = `\n• 验证总量：${stats.total_requests}（通过率 ${stats.approval_rate.toFixed(1)}%）`;
    }
  } catch {
    /* 统计失败不阻塞设置展示 */
  }
  await ctx.reply(
    "⚙️ *机器人设置摘要*\n\n" +
      `• 验证超时：${config.bot.verificationTimeout} 秒\n` +
      `• 验证按钮文案：${config.bot.verificationButtonText}\n` +
      `• 人机验证：${config.captcha.provider}\n` +
      `• 外部 API：${config.api.enable ? "已启用" : "未启用"}\n` +
      `• 管理员数量：${config.bot.adminIds.length}${statsText}\n\n` +
      "更多配置请登录 TGuard 管理后台修改。",
    { parse_mode: "MarkdownV2" },
  );
}

/** /ban — 封禁用户（回复目标消息） */
export async function cmdBan(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/ban（回复目标消息）");
  if (!guard) return;
  try {
    await ctx.api.banChatMember(guard.chatId, guard.target.id);
    await ctx.reply(`🔨 已封禁 ${guard.target.name}（${guard.target.id}），该用户将无法再加入群组。`);
  } catch (error) {
    await ctx.reply(`❌ 封禁失败：${humanizeTelegramError(error)}\n\n请确认机器人拥有「封禁用户」管理员权限。`);
  }
}

/** /unban — 解除封禁 */
export async function cmdUnban(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/unban（回复目标消息，或直接输入用户 ID）");
  if (!guard) return;
  try {
    await ctx.api.unbanChatMember(guard.chatId, guard.target.id, { only_if_banned: true });
    await ctx.reply(`✅ 已解除 ${guard.target.name}（${guard.target.id}）的封禁，对方现在可以重新申请入群。`);
  } catch (error) {
    await ctx.reply(`❌ 解封失败：${humanizeTelegramError(error)}`);
  }
}

/** /mute — 禁言用户（可选时长，默认 60 分钟） */
export async function cmdMute(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/mute [分钟]（回复目标消息，默认 60 分钟）");
  if (!guard) return;
  const argText = typeof ctx.match === "string" ? ctx.match.trim() : "";
  const minutes = Math.min(60 * 24 * 7, Math.max(1, Number(argText) || 60));
  const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;
  try {
    await ctx.api.restrictChatMember(
      guard.chatId,
      guard.target.id,
      {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      },
      { until_date: untilDate },
    );
    await ctx.reply(`🔇 已禁言 ${guard.target.name}（${guard.target.id}）${minutes} 分钟。`);
  } catch (error) {
    await ctx.reply(`❌ 禁言失败：${humanizeTelegramError(error)}\n\n请确认机器人拥有「限制用户」管理员权限。`);
  }
}

/** /unmute — 解除禁言 */
export async function cmdUnmute(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/unmute（回复目标消息）");
  if (!guard) return;
  try {
    await ctx.api.restrictChatMember(guard.chatId, guard.target.id, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
      can_manage_topics: false,
    });
    await ctx.reply(`🔊 已解除 ${guard.target.name}（${guard.target.id}）的禁言。`);
  } catch (error) {
    await ctx.reply(`❌ 解除禁言失败：${humanizeTelegramError(error)}`);
  }
}

/** /kick — 踢出用户（封禁后立即解封，用户可重新申请入群） */
export async function cmdKick(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/kick（回复目标消息）");
  if (!guard) return;
  try {
    await ctx.api.banChatMember(guard.chatId, guard.target.id);
    await ctx.api.unbanChatMember(guard.chatId, guard.target.id);
    await ctx.reply(`👢 已将 ${guard.target.name}（${guard.target.id}）移出群组（可重新申请入群）。`);
  } catch (error) {
    await ctx.reply(`❌ 踢出失败：${humanizeTelegramError(error)}\n\n请确认机器人拥有「封禁用户」管理员权限。`);
  }
}

// 警告计数（进程内存储，重启清零；封禁阈值 3 次）
const globalForWarns = globalThis as unknown as { tguardWarnCounts?: Map<string, number> };
function warnStore(): Map<string, number> {
  if (!globalForWarns.tguardWarnCounts) {
    globalForWarns.tguardWarnCounts = new Map();
  }
  return globalForWarns.tguardWarnCounts;
}

const WARN_BAN_THRESHOLD = 3;

/** /warn — 警告用户（累计 3 次自动封禁） */
export async function cmdWarn(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/warn [原因]（回复目标消息）");
  if (!guard) return;
  const reason = typeof ctx.match === "string" ? ctx.match.trim() : "";
  const key = `${guard.chatId}:${guard.target.id}`;
  const count = (warnStore().get(key) ?? 0) + 1;
  warnStore().set(key, count);
  if (count >= WARN_BAN_THRESHOLD) {
    try {
      await ctx.api.banChatMember(guard.chatId, guard.target.id);
      warnStore().delete(key);
      await ctx.reply(
        `⚠️ ${guard.target.name}（${guard.target.id}）已被第 ${count} 次警告，达到 ${WARN_BAN_THRESHOLD} 次上限，已自动封禁。${reason ? `\n原因：${reason}` : ""}`,
      );
    } catch (error) {
      await ctx.reply(`⚠️ 警告已达上限但自动封禁失败：${humanizeTelegramError(error)}`);
    }
    return;
  }
  await ctx.reply(
    `⚠️ ${guard.target.name}（${guard.target.id}）被警告（第 ${count}/${WARN_BAN_THRESHOLD} 次）。${reason ? `\n原因：${reason}` : ""}`,
    { reply_parameters: guard.target.messageId ? { message_id: guard.target.messageId, allow_sending_without_reply: true } : undefined },
  );
}

/** /warns — 查看用户警告次数 */
export async function cmdWarns(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/warns（回复目标消息）");
  if (!guard) return;
  const count = warnStore().get(`${guard.chatId}:${guard.target.id}`) ?? 0;
  await ctx.reply(
    `📋 ${guard.target.name}（${guard.target.id}）当前警告：${count}/${WARN_BAN_THRESHOLD} 次。`,
  );
}

/** /pin — 置顶消息（回复目标消息） */
export async function cmdPin(ctx: BotContext): Promise<void> {
  const guard = await moderationGuard(ctx, "/pin（回复要置顶的消息）");
  if (!guard || !guard.target.messageId) return;
  try {
    await ctx.api.pinChatMessage(guard.chatId, guard.target.messageId, { disable_notification: true });
    await ctx.reply("📌 已置顶该消息。");
  } catch (error) {
    await ctx.reply(`❌ 置顶失败：${humanizeTelegramError(error)}\n\n请确认机器人拥有「置顶消息」管理员权限。`);
  }
}

// ---------------------------------------------------------------------------
// 注册表（按使用频率排序）
// ---------------------------------------------------------------------------

export const BUILTIN_COMMAND_REGISTRY: Record<string, BuiltinCommandHandler> = {
  start: { handler: cmdStart },
  help: { handler: cmdHelp },
  menu: { handler: cmdMenu },
  settings: { handler: cmdSettings },
  about: { handler: cmdAbout },
  id: { handler: cmdId },
  info: { handler: cmdInfo },
  ping: { handler: cmdPing },
  time: { handler: cmdTime },
  cancel: { handler: cmdCancel },
  rules: { handler: cmdRules },
  report: { handler: cmdReport },
  admin: { handler: cmdAdminPanel, adminOnly: true },
  stats: { handler: cmdStats, adminOnly: true },
  api: { handler: cmdApi, adminOnly: true, privateOnly: true },
  ban: { handler: cmdBan, adminOnly: true, groupOnly: true },
  unban: { handler: cmdUnban, adminOnly: true, groupOnly: true },
  mute: { handler: cmdMute, adminOnly: true, groupOnly: true },
  unmute: { handler: cmdUnmute, adminOnly: true, groupOnly: true },
  kick: { handler: cmdKick, adminOnly: true, groupOnly: true },
  warn: { handler: cmdWarn, adminOnly: true, groupOnly: true },
  warns: { handler: cmdWarns, adminOnly: true, groupOnly: true },
  pin: { handler: cmdPin, adminOnly: true, groupOnly: true },
};

/**
 * 注册内置指令（真实生效）。
 * items 提供时按指令库条目注册（与「启用」状态联动），库中存在但注册表未实现的
 * 内置条目 → 回退为回复其中文介绍文本；缺省注册全部官方内置指令。
 *
 * v2.1.10：registry 提供时同步填充菜单「执行指令」按钮的指令运行器注册表 ——
 * 按钮点击与手输 /指令 完全同源（同一 handler 闭包）。adminOnly 指令在
 * bot.command 路径由 adminOnly 中间件校验；菜单按钮回调不经中间件链，
 * runner 内闭包自校验（防普通用户点按钮绕过管理员权限）。
 */
export function registerBuiltinCommandHandlers(
  bot: Bot<BotContext>,
  items?: { name: string; intro?: string; description?: string }[],
  registry?: MenuCommandRegistry,
): void {
  const list: { name: string; intro?: string; description?: string }[] =
    items ?? Object.keys(BUILTIN_COMMAND_REGISTRY).map((name) => ({ name }));
  for (const item of list) {
    const entry = BUILTIN_COMMAND_REGISTRY[item.name];
    let handler: (ctx: BotContext) => Promise<void>;
    if (!entry) {
      const introText = item.intro || item.description || "内置指令";
      handler = async (ctx) => {
        await ctx.reply(`⌨️ /${item.name}\n\n${introText}`);
      };
    } else {
      handler = entry.handler;
      if (entry.privateOnly) {
        const wrapped = handler;
        handler = async (ctx) => {
          if (ctx.chat?.type !== "private") {
            await ctx.reply("⚠️ 该指令请在与机器人的私聊中使用。");
            return;
          }
          await wrapped(ctx);
        };
      }
    }
    if (registry) {
      const adminRestricted = entry?.adminOnly === true;
      const runner: MenuCommandRunner = async (ctx) => {
        if (adminRestricted && !isAdmin(ctx.from?.id)) {
          await ctx.reply("⚠️ 该指令仅管理员可用。");
          return;
        }
        await handler(ctx as BotContext);
      };
      registry.runners.set(item.name, runner);
    }
    if (entry?.adminOnly) {
      bot.command(item.name, adminOnly, handler);
    } else {
      bot.command(item.name, handler);
    }
  }
}
