import type { Context } from "grammy";
import { appendChatMessage, listBots } from "@/database/operations";

/**
 * 群消息台账（v2.1.2）：Bot API 没有历史消息拉取能力（无 getChatHistory），
 * 机器人「看得见」的消息只能通过 webhook/轮询的 message / channel_post 更新实时获得 ——
 * 这恰好就是「按 bot 权限」视角：隐私模式 bot 只收到指令/回复，管理员 bot 收到全部消息。
 *
 * 本模块把运行时收到的群消息文本落库（chat_messages），供仿真屏右侧对话区展示真实群消息。
 * 设计约束（不拖累验证/指令主链路）：
 * - 只存群/超级群消息，私聊与频道评论等不落库（仿真屏只展示群组）；
 * - 失败静默（console.warn），绝不抛错打断 update 处理链；
 * - (chat_id, bot_id, message_id) 唯一去重，webhook 重复投递幂等；
 * - 每群保留最近 200 条（appendChatMessage 内置低频清理）。
 */

/** 从 grammY 消息中提取展示文本（文本/说明/贴纸表情等，取不到文本的消息标记类型名） */
function extractMessageText(message: Record<string, unknown>): string | null {
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  if (typeof message.caption === "string" && message.caption.trim()) return message.caption;
  if (typeof message.poll === "object" && message.poll !== null) {
    const question = (message.poll as { question?: unknown }).question;
    if (typeof question === "string") return `📊 ${question}`;
  }
  // 媒体类消息：以类型标记占位，至少让管理员在仿真屏知道群里发生了什么
  if (message.photo) return "[图片]";
  if (message.video) return "[视频]";
  if (message.voice) return "[语音]";
  if (message.video_note) return "[视频圆]";
  if (message.document) return "[文件]";
  if (message.sticker) {
    const emoji = (message.sticker as { emoji?: unknown }).emoji;
    return typeof emoji === "string" ? `[贴纸 ${emoji}]` : "[贴纸]";
  }
  if (message.animation) return "[GIF]";
  if (message.audio) return "[音乐]";
  if (message.location) return "[位置]";
  if (message.contact) return "[联系人]";
  if (message.new_chat_members) return "—— 新成员加入群组 ——";
  if (message.left_chat_member) return "—— 成员离开群组 ——";
  if (message.new_chat_title) return `—— 群名改为「${String(message.new_chat_title)}」——`;
  if (message.pinned_message) return "—— 置顶了一条消息 ——";
  if (message.group_chat_created || message.supergroup_chat_created) return "—— 群组创建 ——";
  return null;
}

/**
 * 落库一条群消息（chat-tracking 的 message/channel_post handler 调用）。
 * token 用于归属 bot_id（listBots 60s 缓存，热路径成本可忽略）；
 * 找不到 bot 条目时 bot_id 落 NULL（仍按 chat_id 可查）。
 */
export async function recordChatMessageFromUpdate(input: {
  token: string;
  chatId: bigint;
  chatType: string;
  message: Record<string, unknown>;
  kind: "message" | "channel_post";
}): Promise<void> {
  try {
    // 仅群/超级群消息入库（仿真屏只展示群组；私聊验证消息走 verification_sessions）
    if (input.chatType !== "group" && input.chatType !== "supergroup") return;

    const from = input.message.from as
      | { id?: unknown; username?: unknown; first_name?: unknown; is_bot?: unknown }
      | undefined;
    const messageId =
      typeof input.message.message_id === "number" && Number.isFinite(input.message.message_id)
        ? Math.trunc(input.message.message_id)
        : null;
    const dateSeconds = input.message.date;
    const messageTime =
      typeof dateSeconds === "number" && Number.isFinite(dateSeconds)
        ? new Date(dateSeconds * 1000)
        : null;

    // 频道帖子无 from（channel 身份）；from_bot 识别机器人自身消息
    const userId =
      from && typeof from.id === "number" && Number.isFinite(from.id) ? BigInt(Math.trunc(from.id)) : null;
    const fromBot = from?.is_bot === true;
    const username = typeof from?.username === "string" ? from.username : null;
    const firstName = typeof from?.first_name === "string" ? from.first_name : null;

    // 归属 bot_id：同 token 多条目取第一条（Telegram 侧同一 bot，视角一致）
    let botId: bigint | null = null;
    try {
      const bots = await listBots();
      const hit = bots.find((item) => item.token === input.token);
      botId = hit ? hit.id : null;
    } catch {
      botId = null;
    }

    const text = extractMessageText(input.message);
    // 无文本可提取且无归属人的消息跳过（减少噪音写入）
    if (text === null && userId === null) return;

    await appendChatMessage({
      botId,
      chatId: input.chatId,
      messageId,
      userId,
      username,
      firstName,
      fromBot,
      kind: input.kind,
      text,
      messageTime,
    });
  } catch (error) {
    console.warn(
      `[chat-log] store message failed (chat=${input.chatId}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** chat-tracking 便捷封装：从 grammY Context 提取并落库 */
export async function recordChatMessageFromContext(
  ctx: Context,
  token: string,
  kind: "message" | "channel_post",
): Promise<void> {
  const chat = ctx.chat;
  const message = (kind === "channel_post" ? ctx.channelPost : ctx.message) as
    | Record<string, unknown>
    | undefined;
  if (!chat || !message) return;
  await recordChatMessageFromUpdate({
    token,
    chatId: BigInt(chat.id),
    chatType: chat.type,
    message,
    kind,
  });
}
