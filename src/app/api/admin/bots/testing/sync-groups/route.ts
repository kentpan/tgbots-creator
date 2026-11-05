import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot } from "@/database/operations";
import { fetchRealGroups } from "@/services/telegram-sync";
import { registerTelegramChat } from "@/services/chat-registry";

/**
 * 同步真实群组：通过 bot token 调用 Telegram getMe + getUpdates，
 * 拉取机器人真实所在的群组（真实 chat_id / 群名）并登记到群组配置。
 * 已存在的群组只刷新群名，绝不覆盖已有验证配置（见 chat-registry）。
 */
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

  const synced: { chat_id: string; chat_title: string; is_new: boolean }[] = [];
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
    synced.push({ chat_id: chat.chatId, chat_title: chat.chatTitle, is_new: isNew });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "同步真实群组",
    target: bot.name,
    detail: `发现 ${synced.length} 个真实群组（新增 ${synced.filter((item) => item.is_new).length} 个）`,
    headers: requestHeaders,
  });

  const notes: string[] = [];
  if (synced.length === 0) {
    notes.push(
      "未发现机器人所在的群组：机器人需在群内产生过事件（被加入群组/收到加群申请/群消息），或已在管理端保存过该群组。机器人运行期间收到群事件会自动登记真实群组。",
    );
  }
  if (result.warnings.length > 0) {
    notes.push(`同步诊断：${result.warnings.join("；")}`);
  }

  return NextResponse.json({
    ok: true,
    data: {
      bot_username: result.botUsername,
      groups: synced,
      warnings: result.warnings,
      note: notes.length > 0 ? notes.join(" ") : null,
    },
  });
}
