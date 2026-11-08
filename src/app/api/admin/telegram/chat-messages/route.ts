import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listChatMessages } from "@/database/operations";

/**
 * 群消息台账读取（v2.1.2）：
 *
 * bot 运行时把 webhook/轮询收到的群消息（= 按 bot 权限视角：隐私模式 bot 只收到
 * 指令/回复，管理员 bot 收到全部消息）落库到 chat_messages；
 * 本接口按 chat_id（可选 bot_id 视角过滤）返回最近的消息，时间正序，
 * 供仿真屏右侧对话区展示「真实群消息」。
 *
 * 注意：Bot API 无历史消息拉取能力，台账只包含部署 v2.1.2 后 bot 收到的新消息。
 */

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const chatIdRaw = (params.get("chat_id") ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const botIdRaw = (params.get("bot_id") ?? "").trim();
  const botId = botIdRaw && /^\d+$/.test(botIdRaw) ? BigInt(botIdRaw) : null;
  const limitRaw = Number(params.get("limit") ?? "100");
  const limit = Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100;

  const messages = await listChatMessages(chatId, { botId, limit });
  return NextResponse.json({
    ok: true,
    data: {
      messages: messages.map((message) => ({
        id: String(message.id),
        message_id: message.messageId,
        bot_id: message.botId === null ? null : String(message.botId),
        user_id: message.userId === null ? null : String(message.userId),
        username: message.username,
        first_name: message.firstName,
        from_bot: message.fromBot,
        kind: message.kind,
        text: message.text,
        message_time: message.messageTime ? message.messageTime.toISOString() : null,
      })),
    },
  });
}
