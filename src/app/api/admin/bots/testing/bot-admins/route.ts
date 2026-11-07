import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getBot,
  getGroupBotAdminByBotAndChat,
  listGroupBotAdmins,
  updateBotRecord,
  upsertGroupBotAdmin,
} from "@/database/operations";
import {
  INVALID_TOKEN_GUIDE,
  PROMOTE_SELF_GUIDE,
  actualRightsFromMember,
  findPromoterBot,
  formatRights,
} from "@/services/bot-group-admin-sync";
import { BOT_ADMIN_RIGHT_KEYS, type BotAdminRights } from "@/services/bot-admin-rights";
import {
  botByToken,
  describeSyncError,
  getMeCached,
  withTelegramTimeout,
} from "@/services/telegram-sync";
import { GrammyError } from "grammy";
import { assertRemoteExecution } from "@/services/remote-ops-guard";

/**
 * 仿真屏「机器人权限配置」页（iOS 管理员权限界面）的读写。
 *
 * 源头复用：与「群组管理 → 机器人管理员」弹窗（bots/actions.ts setBotGroupAdminAction）
 * 完全同一管道 —— 本文件与该弹窗共用 src/services/bot-group-admin-sync.ts 的唯一实现：
 * botByToken 轻量 API 客户端 → getMe 缓存 → getChatMember 读真实身份 →
 * 已是管理员按实际权限落库 / 非管理员经「提升者」bot promoteChatMember 真实提升 →
 * upsertGroupBotAdmin 落库；Telegram 错误返回明确 JSON（绝不抛 500 HTML）。
 */

type Rights = BotAdminRights;

export async function GET(request: Request): Promise<NextResponse> {

  // v2.0.12 node 环境兜底：已配置线上站点时禁止本地直连执行（前端 opsFetch 已自动转发线上）
  const blocked = await assertRemoteExecution(request);
  if (blocked) return blocked;
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const url = new URL(request.url);
  const chatIdRaw = url.searchParams.get("chat_id") ?? "";
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }

  const admins = await listGroupBotAdmins(chatId);
  const entries: {
    id: string;
    bot_id: string;
    bot_name: string | null;
    bot_username: string | null;
    rights: Rights;
    status: string;
  }[] = [];
  for (const row of admins) {
    const bot = await getBot(row.botId);
    let rights: Rights = {};
    try {
      const parsed = JSON.parse(row.rights || "{}") as Record<string, unknown>;
      for (const key of BOT_ADMIN_RIGHT_KEYS) {
        rights[key] = parsed[key] === true;
      }
    } catch (error) {
      // rights JSON 损坏必须显式暴露，绝不能静默当空对象（会误导权限展示与覆盖保存）
      console.error(`bot-admins GET: rights JSON 解析失败 (id=${row.id}):`, error);
      return NextResponse.json(
        { ok: false, error: `机器人管理员权限数据损坏（记录 #${row.id}），请查看服务端日志` },
        { status: 500 },
      );
    }
    entries.push({
      id: String(row.id),
      bot_id: String(row.botId),
      bot_name: bot?.name ?? null,
      bot_username: bot?.username ?? null,
      rights,
      status: row.status,
    });
  }

  return NextResponse.json({ ok: true, data: { admins: entries } });
}

export async function PUT(request: Request): Promise<NextResponse> {

  // v2.0.12 node 环境兜底：已配置线上站点时禁止本地直连执行（前端 opsFetch 已自动转发线上）
  const blocked = await assertRemoteExecution(request);
  if (blocked) return blocked;
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "groups:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要群组管理权限）" }, { status: 403 });
  }

  let payload: { chat_id?: string | number; bot_id?: string | number; rights?: Record<string, boolean> };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const chatIdRaw = String(payload.chat_id ?? "").trim();
  const botIdRaw = String(payload.bot_id ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw) || !botIdRaw || !/^\d+$/.test(botIdRaw)) {
    return NextResponse.json({ ok: false, error: "参数不完整（chat_id / bot_id）" }, { status: 400 });
  }
  const chatId = BigInt(chatIdRaw);
  const chatIdNum = Number(chatId);
  const botId = BigInt(botIdRaw);

  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  const incoming = payload.rights ?? {};
  const rights: Rights = {};
  for (const key of BOT_ADMIN_RIGHT_KEYS) {
    rights[key] = incoming[key] === true;
  }

  // 与 setBotGroupAdminAction 完全同源（同一服务实现）：真实读取/提升 + 以实际权限落库
  let botUsername: string | null = bot.username ?? null;
  let savedRights: Rights = rights;
  let notice = "";
  try {
    const api = botByToken(bot.token).api;
    const me = await withTelegramTimeout(getMeCached(api, bot.token));
    botUsername = me.username ?? botUsername;

    let member: Awaited<ReturnType<typeof api.getChatMember>>;
    try {
      member = await withTelegramTimeout(api.getChatMember(chatIdNum, me.id));
    } catch (error) {
      // 机器人不在群/群不可见：与弹窗同语义 —— 保存本地配置 + 指引
      savedRights = rights;
      await upsertGroupBotAdmin({ botId: bot.id, chatId, rights: JSON.stringify(rights) });
      await updateBotRecord(bot.id, { username: me.username });
      const detail = describeSyncError(error).slice(0, 120);
      notice = `已保存权限配置，但机器人成员状态读取失败（${detail}）。请确认机器人已在群内并设为管理员：${PROMOTE_SELF_GUIDE}`;
      const requestHeaders = await headers();
      await logOperation(admin, {
        action: "仿真屏设置机器人管理员权限（本地保存）",
        target: `${bot.name} → ${chatIdRaw}`,
        detail: notice,
        headers: requestHeaders,
      });
      return NextResponse.json({
        ok: true,
        data: { bot_id: String(bot.id), bot_name: bot.name, bot_username: botUsername, rights: savedRights, notice },
      });
    }

    if (member.status === "administrator") {
      // 已是管理员：以 Telegram 实际权限为准保存（真实同步）
      const actual = actualRightsFromMember(member);
      savedRights = actual;
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
          savedRights = actual;
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
  } catch (error) {
    console.error(`bot-admins PUT: Telegram 同步失败 (bot=${bot.name}, chat=${chatIdRaw}):`, error);
    // Telegram 调用失败（Token 无效/网络超时/机器人不在群）必须返回明确 JSON 错误，
    // 绝不能抛 500 HTML（客户端无法解析，用户看不到原因）
    const detail =
      error instanceof GrammyError && error.error_code === 401
        ? INVALID_TOKEN_GUIDE
        : describeSyncError(error);
    return NextResponse.json({ ok: false, error: detail }, { status: 200 });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "仿真屏设置机器人管理员权限",
    target: `${bot.name} → ${chatIdRaw}`,
    detail: notice,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    data: {
      bot_id: String(bot.id),
      bot_name: bot.name,
      bot_username: botUsername,
      rights: savedRights,
      notice,
      chat_id: chatIdRaw,
    },
  });
}
