import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, getGroupSettings, listInviteLinks, deleteInviteLink, markInviteLinkRevoked, updateInviteLinkRemark, updateInviteLinkConfig, upsertInviteLink } from "@/database/operations";
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
 *   - action=create  → v3.0.2 调用 Telegram createChatInviteLink 真实创建新邀请链接
 *                      （备注 remark 用于区分来源渠道；申请制形态跟随群组 requireApproval）
 *                      并落库台账 —— 部署链路已不再自动建链，创建统一收敛到本入口
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

/** v3.0.4 解析分享时长（秒）：null/0 = 不限时长；上限 1 年，防误填 */
function parseExpireSeconds(raw: unknown): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === 0 || raw === "0") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return "invalid";
  if (raw > 60 * 60 * 24 * 365) return "invalid";
  return Math.floor(raw);
}

/** v3.0.4 解析分享次数：null = 不限次数；Telegram 限制 1-99999 */
function parseMemberLimit(raw: unknown): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === 0 || raw === "0") return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 99999) return "invalid";
  return raw;
}

/** v3.0.4 当前群组私密/公开（公开群有 username）；失败返回 null（未知） */
async function resolveChatIsPrivate(api: ReturnType<typeof botByToken>["api"], chatId: bigint): Promise<boolean | null> {
  try {
    const chatInfo = await api.getChat(Number(chatId));
    return !("username" in chatInfo && chatInfo.username);
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

  // v3.0.4 当前群组信息（创建/编辑弹窗展示用）：
  // - 私密/公开：优先用 bot token 实时 getChat（公开群有 username），
  //   失败/无 token 时回退台账最新快照；
  // - 新成员审核：group_settings.requireApproval（群级总开关）。
  const groupSettings = await getGroupSettings(chatId);
  const requireApproval = groupSettings?.requireApproval ?? false;
  let chatIsPrivate: boolean | null = null;
  if (botId !== null) {
    try {
      const bot = await getBot(botId);
      if (bot?.token) {
        const chatInfo = await botByToken(bot.token).api.getChat(Number(chatId));
        chatIsPrivate = !("username" in chatInfo && chatInfo.username);
      }
    } catch {
      /* getChat 失败回退台账快照 */
    }
  }
  if (chatIsPrivate === null) {
    const snapshot = links.find((link) => link.chatIsPrivate !== null);
    chatIsPrivate = snapshot?.chatIsPrivate ?? null;
  }

  return NextResponse.json({
    ok: true,
    data: {
      chat_info: {
        is_private: chatIsPrivate,
        require_approval: requireApproval,
      },
      links: links.map((link) => ({
        id: String(link.id),
        bot_id: link.botId === null ? null : String(link.botId),
        chat_id: String(link.chatId),
        link: link.link,
        name: link.name,
        remark: link.remark,
        creates_join_request: link.createsJoinRequest,
        is_revoked: link.isRevoked,
        source: link.source,
        expire_date: link.expireDate ? link.expireDate.toISOString() : null,
        member_limit: link.memberLimit,
        chat_is_private: link.chatIsPrivate,
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
    action?: "create" | "revoke" | "delete" | "add" | "update_remark" | "edit";
    link_id?: string;
    link?: string;
    name?: string;
    /** v3.0.2 渠道备注（create/add 时填写；update_remark 时编辑，用于区分来源渠道） */
    remark?: string;
    /** v3.0.4 分享时长（秒；null/0 = 不限时长） */
    expire_seconds?: number | null;
    /** v3.0.4 分享次数上限（null/0 = 不限次数；Telegram 限制 1-99999） */
    member_limit?: number | null;
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

  // —— v3.0.2 真实创建邀请链接（部署不再自动建链，创建统一收敛到本入口）——
  if (action === "create") {
    const bot = await getBot(botId);
    if (!bot || !bot.token) {
      return NextResponse.json({ ok: false, error: "机器人不存在或 Token 缺失" }, { status: 404 });
    }
    const remark = (payload.remark ?? "").trim();
    const expireSeconds = parseExpireSeconds(payload.expire_seconds);
    if (expireSeconds === "invalid") {
      return NextResponse.json({ ok: false, error: "分享时长不合法（0 = 不限，最长 1 年）" }, { status: 400 });
    }
    const memberLimit = parseMemberLimit(payload.member_limit);
    if (memberLimit === "invalid") {
      return NextResponse.json({ ok: false, error: "分享次数不合法（0 = 不限，1-99999）" }, { status: 400 });
    }
    const expireDate = expireSeconds !== null ? new Date(Date.now() + expireSeconds * 1000) : null;
    try {
      const api = botByToken(bot.token).api;
      // 申请制形态跟随群组「新成员审核」开关；群组未登记时默认普通链接
      const groupSettings = await getGroupSettings(chatId);
      const requireApproval = groupSettings?.requireApproval ?? false;
      const invite = await api.createChatInviteLink(Number(chatId), {
        ...(requireApproval ? { creates_join_request: true } : {}),
        ...(remark ? { name: remark } : {}),
        // Bot API expire_date 为 Unix 时间戳（秒）
        ...(expireDate ? { expire_date: Math.floor(expireDate.getTime() / 1000) } : {}),
        ...(memberLimit !== null ? { member_limit: memberLimit } : {}),
      });
      const chatIsPrivate = await resolveChatIsPrivate(api, chatId);
      await upsertInviteLink({
        botId,
        chatId,
        link: invite.invite_link,
        name: invite.name ?? (remark || "管理端创建"),
        remark: remark || null,
        createsJoinRequest: invite.creates_join_request === true,
        source: "manual",
        expireDate: invite.expire_date ? new Date(invite.expire_date * 1000) : expireDate,
        memberLimit: invite.member_limit ?? memberLimit,
        chatIsPrivate,
      });
      await logOperation(admin, {
        action: "创建邀请链接",
        target: `chat=${chatId} bot=${botId}`,
        detail:
          `${invite.invite_link}${remark ? `（备注：${remark}）` : ""}` +
          `${expireDate ? `（时长：至 ${expireDate.toLocaleString()}）` : "（不限时长）"}` +
          `${memberLimit !== null ? `（次数：${memberLimit}）` : "（不限次数）"}`,
        headers: requestHeaders,
      });
      return NextResponse.json({
        ok: true,
        data: { message: "邀请链接已创建并登记台账", link: invite.invite_link, remark: remark || null },
      });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: `创建邀请链接失败：${describeSyncError(error)}` },
        { status: 502 },
      );
    }
  }

  // —— v3.0.4 编辑已有链接的分享配置（备注/时长/次数；Telegram editChatInviteLink）——
  // 注意：Telegram 限制已设置的到期时间/次数只能改值，无法清除（选「不限」不会生效）。
  if (action === "edit") {
    const linkIdRaw = (payload.link_id ?? "").trim();
    if (!linkIdRaw || !/^\d+$/.test(linkIdRaw)) {
      return NextResponse.json({ ok: false, error: "链接记录 ID 不合法" }, { status: 400 });
    }
    const links = await listInviteLinks(chatId, botId);
    const target = links.find((item) => String(item.id) === linkIdRaw);
    if (!target) {
      return NextResponse.json({ ok: false, error: "链接记录不存在（可能已被删除）" }, { status: 404 });
    }
    const bot = await getBot(botId);
    if (!bot || !bot.token) {
      return NextResponse.json({ ok: false, error: "机器人不存在或 Token 缺失" }, { status: 404 });
    }
    const remark = (payload.remark ?? "").trim();
    const expireSeconds = parseExpireSeconds(payload.expire_seconds);
    if (expireSeconds === "invalid") {
      return NextResponse.json({ ok: false, error: "分享时长不合法（最长 1 年）" }, { status: 400 });
    }
    const memberLimit = parseMemberLimit(payload.member_limit);
    if (memberLimit === "invalid") {
      return NextResponse.json({ ok: false, error: "分享次数不合法（1-99999）" }, { status: 400 });
    }
    const expireDate = expireSeconds !== null ? new Date(Date.now() + expireSeconds * 1000) : null;
    try {
      const api = botByToken(bot.token).api;
      const edited = await api.editChatInviteLink(Number(chatId), target.link, {
        ...(remark ? { name: remark } : {}),
        ...(expireDate ? { expire_date: Math.floor(expireDate.getTime() / 1000) } : {}),
        ...(memberLimit !== null ? { member_limit: memberLimit } : {}),
      });
      const chatIsPrivate = await resolveChatIsPrivate(api, chatId);
      await updateInviteLinkConfig(target.id, {
        remark,
        expireDate: edited.expire_date ? new Date(edited.expire_date * 1000) : expireDate,
        memberLimit: edited.member_limit ?? memberLimit,
        name: remark || null,
      });
      await logOperation(admin, {
        action: "编辑邀请链接",
        target: `chat=${chatId} bot=${botId}`,
        detail:
          `${target.link}${remark ? `（备注：${remark}）` : ""}` +
          `${expireDate ? `（时长：至 ${expireDate.toLocaleString()}）` : ""}` +
          `${memberLimit !== null ? `（次数：${memberLimit}）` : ""}`,
        headers: requestHeaders,
      });
      return NextResponse.json({
        ok: true,
        data: { message: "邀请链接配置已更新", link: target.link, remark: remark || null },
      });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: `编辑邀请链接失败：${describeSyncError(error)}（Telegram 限制：已设置的时长/次数只能改值，无法清除）` },
        { status: 502 },
      );
    }
  }

  // —— 手动登记历史链接 ——
  if (action === "add") {
    const link = (payload.link ?? "").trim();
    if (!/^https:\/\/t\.me\/(\+|joinchat\/)[A-Za-z0-9_-]+$/.test(link)) {
      return NextResponse.json(
        { ok: false, error: "链接格式不合法：需要 https://t.me/+xxxx 或 https://t.me/joinchat/xxxx 形式的邀请链接" },
        { status: 400 },
      );
    }
    const remark = (payload.remark ?? "").trim();
    await upsertInviteLink({
      botId,
      chatId,
      link,
      name: (payload.name ?? "").trim() || "手动登记",
      remark: remark || null,
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

  // —— v3.0.3 编辑备注（台账覆盖写入；Telegram 侧链接名称 best-effort 同步）——
  if (action === "update_remark") {
    const remark = (payload.remark ?? "").trim();
    try {
      const bot = await getBot(botId);
      if (bot?.token) {
        const api = botByToken(bot.token).api;
        // 只对机器人自己创建的链接有效（Telegram 限制）；死链/非本 bot 创建的报错不影响台账
        await api.editChatInviteLink(Number(chatId), target.link, {
          ...(remark ? { name: remark } : {}),
        });
      }
    } catch (error) {
      console.warn(
        `[invite-links] Telegram-side link rename skipped (chat=${chatId}, link=${target.link}):`,
        error instanceof Error ? error.message : error,
      );
    }
    const updated = await updateInviteLinkRemark(target.id, remark);
    if (!updated) {
      return NextResponse.json({ ok: false, error: "链接记录不存在（可能已被删除）" }, { status: 404 });
    }
    await logOperation(admin, {
      action: "编辑邀请链接备注",
      target: `chat=${chatId} bot=${botId}`,
      detail: `${target.link} → ${remark || "（空）"}`,
      headers: requestHeaders,
    });
    return NextResponse.json({ ok: true, data: { message: "备注已更新", remark: remark || null } });
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
