import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, listInviteLinks, deleteInviteLink, markInviteLinkRevoked, upsertInviteLink } from "@/database/operations";
import { botByToken, describeSyncError } from "@/services/telegram-sync";

/**
 * 邀请链接台账（v2.1.2）：
 *
 * Bot API 没有「列出机器人创建的全部邀请链接」的方法，历史上验证超时补发、
 * 部署管道等路径创建的链接从未落库，管理后台无从查看也无法撤销。
 * v2.1.2 起 bot 运行时 transformer（invite-link-tracking）把每次
 * createChatInviteLink 成功创建的链接统一落库到 invite_links 台账。
 *
 * GET  ?chat_id=&bot_id= → 列出台账记录（纯数据库，不请求 Telegram）
 * POST { chat_id, bot_id, action }：
 *   - action=revoke  → 调用 Telegram revokeChatInviteLink 真正作废链接 + 台账标记已撤销
 *   - action=delete  → 仅删除台账记录（Telegram 侧不动，链接仍然有效时请先用 revoke）
 *   - action=add     → 手动登记链接（用户从 Telegram 客户端「邀请链接」列表粘贴历史链接，
 *                      登记后即可在后台对其执行撤销）
 */

function parseChatId(raw: string): bigint | null {
  if (!raw || !/^-?\d+$/.test(raw.trim())) return null;
  try {
    return BigInt(raw.trim());
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "groups:view") && !hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const chatId = parseChatId(params.get("chat_id") ?? "");
  if (chatId === null) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const botIdRaw = (params.get("bot_id") ?? "").trim();
  const botId = botIdRaw && /^\d+$/.test(botIdRaw) ? BigInt(botIdRaw) : null;

  const links = await listInviteLinks(chatId, botId);
  return NextResponse.json({
    ok: true,
    data: {
      links: links.map((link) => ({
        id: String(link.id),
        bot_id: link.botId === null ? null : String(link.botId),
        chat_id: String(link.chatId),
        link: link.link,
        name: link.name,
        creates_join_request: link.createsJoinRequest,
        is_revoked: link.isRevoked,
        source: link.source,
        created_time: link.createdTime.toISOString(),
        updated_time: link.updatedTime.toISOString(),
      })),
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "groups:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要群组管理权限）" }, { status: 403 });
  }

  let payload: {
    chat_id?: string;
    bot_id?: string;
    action?: "revoke" | "delete" | "add";
    link_id?: string;
    link?: string;
    name?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const chatId = parseChatId(payload.chat_id ?? "");
  if (chatId === null) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const botIdRaw = (payload.bot_id ?? "").trim();
  if (!botIdRaw || !/^\d+$/.test(botIdRaw)) {
    return NextResponse.json({ ok: false, error: "请先选择机器人" }, { status: 400 });
  }
  const botId = BigInt(botIdRaw);
  const action = payload.action ?? "";

  const requestHeaders = await headers();

  // —— 手动登记历史链接 ——
  if (action === "add") {
    const link = (payload.link ?? "").trim();
    if (!/^https:\/\/t\.me\/(\+|joinchat\/)[A-Za-z0-9_-]+$/.test(link)) {
      return NextResponse.json(
        { ok: false, error: "链接格式不合法：需要 https://t.me/+xxxx 或 https://t.me/joinchat/xxxx 形式的邀请链接" },
        { status: 400 },
      );
    }
    await upsertInviteLink({
      botId,
      chatId,
      link,
      name: (payload.name ?? "").trim() || "手动登记",
      createsJoinRequest: true,
      source: "manual",
    });
    await logOperation(admin, {
      action: "手动登记邀请链接",
      target: `chat=${chatId} bot=${botId}`,
      detail: link,
      headers: requestHeaders,
    });
    return NextResponse.json({ ok: true, data: { message: "链接已登记，可执行撤销" } });
  }

  const linkIdRaw = (payload.link_id ?? "").trim();
  if (!linkIdRaw || !/^\d+$/.test(linkIdRaw)) {
    return NextResponse.json({ ok: false, error: "链接记录 ID 不合法" }, { status: 400 });
  }
  const links = await listInviteLinks(chatId, botId);
  const target = links.find((item) => String(item.id) === linkIdRaw);
  if (!target) {
    return NextResponse.json({ ok: false, error: "链接记录不存在（可能已被删除）" }, { status: 404 });
  }

  // —— 撤销（Telegram 侧真正作废 + 台账标记）——
  if (action === "revoke") {
    const bot = await getBot(botId);
    if (!bot || !bot.token) {
      return NextResponse.json({ ok: false, error: "机器人不存在或 Token 缺失" }, { status: 404 });
    }
    try {
      const api = botByToken(bot.token).api;
      await api.revokeChatInviteLink(Number(chatId), target.link);
      await markInviteLinkRevoked(target.id);
      await logOperation(admin, {
        action: "撤销邀请链接",
        target: `chat=${chatId} bot=${botId}`,
        detail: target.link,
        headers: requestHeaders,
      });
      return NextResponse.json({
        ok: true,
        data: { message: "链接已在 Telegram 侧撤销（立即失效，已持有者无法再使用）" },
      });
    } catch (error) {
      const message = describeSyncError(error);
      const lowered = message.toLowerCase();
      // Telegram 确认「链接本就不存在/已撤销/非本 bot 创建」→ 台账同样标记失效，避免反复重试
      if (
        lowered.includes("invite link") ||
        lowered.includes("invite_hash") ||
        lowered.includes("not found") ||
        lowered.includes("already revoked")
      ) {
        await markInviteLinkRevoked(target.id);
        await logOperation(admin, {
          action: "撤销邀请链接（Telegram 侧已失效）",
          target: `chat=${chatId} bot=${botId}`,
          detail: target.link,
          headers: requestHeaders,
        });
        return NextResponse.json({
          ok: true,
          data: { message: `Telegram 返回链接已失效（${message}），台账已标记为失效` },
        });
      }
      return NextResponse.json({ ok: false, error: `撤销失败：${message}` }, { status: 502 });
    }
  }

  // —— 删除台账记录 ——
  if (action === "delete") {
    await deleteInviteLink(target.id);
    await logOperation(admin, {
      action: "删除邀请链接台账记录",
      target: `chat=${chatId} bot=${botId}`,
      detail: target.link,
      headers: requestHeaders,
    });
    return NextResponse.json({ ok: true, data: { message: "台账记录已删除（Telegram 侧状态不受影响）" } });
  }

  return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
}
