import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBot } from "@/database/operations";
import { botByToken, withTelegramTimeout } from "@/services/telegram-sync";

/**
 * 群组设置浮层真实状态快照（v2.2.7）—— 展示时实时调用 Telegram getChat 取回
 * 该群组的真实配置，供仿真屏「群组设置」七行渲染（绝对不使用硬编码假数据）：
 *
 * - 群组类型：type + active_usernames → 超级群组/群组 · 公开/私密
 * - 聊天记录：has_visible_history（新成员是否可见历史消息，Bot API 7.3+，管理员可用）
 * - 表情回应：available_reactions（缺省=全部允许；空=已停用；非空=限指定表情）
 *   + max_reaction_count（每条消息可设反应上限）
 * - 外观：background_custom_emoji_id / profile_background_custom_emoji_id
 * - 话题：is_forum
 * - 邀请链接行沿用台账真实计数（Bot API 无列出全部链接的方法，台账即真实记录）
 *
 * 说明：ChatFullInfo 是按 chat type 划分的联合类型，且机器人面向的 Telegram API
 * 会按群形态选择性返回字段 —— 这里按真实 JSON 响应字段读取（has_visible_history/
 * available_reactions 等仅在超级群返回），缺省即按 Telegram 官方语义处理。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view") && !hasPermission(admin, "groups:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const botIdText = params.get("bot_id") ?? "";
  const chatIdText = params.get("chat_id") ?? "";
  let botId: bigint;
  let chatId: bigint;
  try {
    botId = BigInt(botIdText);
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }
  if (!/^-?\d+$/.test(chatIdText.trim())) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  chatId = BigInt(chatIdText.trim());
  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  try {
    const chat = await withTelegramTimeout(botByToken(bot.token).api.getChat(Number(chatId)));
    // 按真实 JSON 响应字段读取（联合类型变体差异 + 未来新增字段的兼容读取）
    const raw = chat as unknown as Record<string, unknown>;
    const str = (key: string): string | null =>
      typeof raw[key] === "string" && (raw[key] as string).length > 0 ? (raw[key] as string) : null;
    const strArray = (key: string): string[] => (Array.isArray(raw[key]) ? (raw[key] as string[]) : []);
    const idValue = typeof raw.id === "number" ? raw.id : Number(chatId);
    return NextResponse.json({
      ok: true,
      chat: {
        id: String(idValue),
        type: String(raw.type ?? "unknown"),
        title: str("title"),
        username: str("username"),
        // 现役公开用户名（公开群非空；私密群为空数组/缺省）
        active_usernames: strArray("active_usernames"),
        // 话题（论坛模式）开关（超级群组专用，缺省=未开启）
        is_forum: raw.is_forum === true,
        // 新成员是否可见历史消息（管理员可读；缺省=可见）
        has_visible_history: raw.has_visible_history !== false,
        // 表情回应：undefined=全部允许；数组空=已停用；非空=限指定表情
        has_available_reactions: raw.available_reactions !== undefined,
        available_reactions_count: Array.isArray(raw.available_reactions) ? raw.available_reactions.length : null,
        max_reaction_count: typeof raw.max_reaction_count === "number" ? raw.max_reaction_count : null,
        // 外观：自定义表情背景（回复头/资料背景）
        has_custom_appearance: Boolean(raw.background_custom_emoji_id) || Boolean(raw.profile_background_custom_emoji_id),
        has_protected_content: raw.has_protected_content === true,
      },
    });
  } catch (error) {
    // 真实失败原因原样返回（群不可达/机器人被移出/网络失败），前端如实展示
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 200 },
    );
  }
}
