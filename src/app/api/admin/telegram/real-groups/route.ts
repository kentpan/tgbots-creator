import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, listGroupBotAdmins, listGroupSettings } from "@/database/operations";
import { fetchRealGroups } from "@/services/telegram-sync";
import { registerTelegramChat } from "@/services/chat-registry";

/**
 * 统一「真实群组」获取通道（v1.1.1）：
 *
 * 全站唯一实现 —— 管理后台任何需要「机器人真实所在群组」的地方
 * （机器人测试页 / 编辑机器人弹窗 / 后续新功能）都调用本接口。
 *
 * GET  ?bot_id=X → 只读数据库已登记群组（group_bot_admins 关联 + group_settings 群名），
 *                   不发起任何 Telegram 请求；页面/弹窗打开时用本接口即时展示现有数据。
 * POST { bot_id } → 手动同步：fetchRealGroups 三源合并
 *                   （getUpdates + 数据库关联 + getChat/getChatMember 验证），
 *                   并把验证通过的群组登记到 chat-registry（不覆盖已有验证配置）；
 *                   经 Telegram 确认失效的群组（群不存在 / 机器人已 left/kicked）
 *                   会移除 group_bot_admins 关联行（网络错误/超时不删，防误删）。
 *
 * 前端约定：打开页面/弹窗只调 GET（零 Telegram 消耗）；只有用户点「同步真实群组」
 * 按钮才调 POST 实时校验。
 */

interface GroupEntry {
  chat_id: string;
  chat_title: string;
  source: string;
  is_new: boolean;
}

interface GroupsPayload {
  ok: boolean;
  error?: string;
  data?: {
    bot_username: string | null;
    groups: GroupEntry[];
    stale_chat_ids?: string[];
    note: string | null;
  };
}

/** GET：读取该机器人已登记的群组（纯数据库，不请求 Telegram） */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const botIdText = new URL(request.url).searchParams.get("bot_id") ?? "";
  let botId: bigint;
  try {
    botId = BigInt(botIdText);
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }

  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  const links = (await listGroupBotAdmins()).filter(
    (link) => link.botId === botId && link.status === "active",
  );
  // v2.0.3：一次取全部群组配置建 Map，消除循环内逐条 getGroupSettings 的 N+1 串行查询
  const settingsList = await listGroupSettings();
  const titleByChat = new Map(
    settingsList.map((setting) => [String(setting.chatId), setting.chatTitle ?? ""]),
  );
  const groups: GroupEntry[] = links.map((link) => ({
    chat_id: String(link.chatId),
    chat_title: titleByChat.get(String(link.chatId)) ?? "",
    source: "cache",
    is_new: false,
  }));

  const payload: GroupsPayload = {
    ok: true,
    data: { bot_username: bot.username ?? null, groups, note: null },
  };
  return NextResponse.json(payload);
}

/** POST：手动同步（真实调用 Telegram API 三源合并发现群组） */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { bot_id?: string | number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let botId: bigint;
  try {
    botId = BigInt(payload.bot_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }

  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  const result = await fetchRealGroups(bot.token);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error ?? "同步失败" }, { status: 200 });
  }

  const synced: { chat_id: string; chat_title: string; source: string; is_new: boolean }[] = [];
  for (const chat of result.chats) {
    let chatId: bigint;
    try {
      chatId = BigInt(chat.chatId);
    } catch {
      continue;
    }
    const { isNew } = await registerTelegramChat({
      chatId,
      chatTitle: chat.chatTitle,
      botToken: bot.token,
    });
    synced.push({
      chat_id: chat.chatId,
      chat_title: chat.chatTitle,
      source: chat.source,
      is_new: isNew,
    });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "同步真实群组",
    target: bot.name,
    detail: `发现 ${synced.length} 个真实群组（新增 ${synced.filter((item) => item.is_new).length} 个${result.staleChatIds.length ? `，失效链接 ${result.staleChatIds.length} 个` : ""}）`,
    headers: requestHeaders,
  });

  const notes: string[] = [];
  if (synced.length === 0) {
    notes.push(
      "未发现机器人所在的群组：把机器人拉进目标群组并设为管理员（管理员可收到全部群消息），在群里发一条消息或重新拉一次机器人，数秒后点「同步真实群组」即可发现。",
    );
  }
  if (result.staleChatIds.length > 0) {
    notes.push(
      `已移除失效群组关联 ${result.staleChatIds.length} 个：${result.staleChatIds.join("、")}`,
    );
  }

  return NextResponse.json({
    ok: true,
    data: {
      bot_username: result.botUsername,
      groups: synced,
      stale_chat_ids: result.staleChatIds,
      note: notes.length > 0 ? notes.join(" ") : null,
    },
  });
}
