import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, getGroupBotAdminByBotAndChat, upsertGroupBotAdmin } from "@/database/operations";
import { callBotApi, describeBotApiError } from "@/services/telegram-sync";
import { registerTelegramChat } from "@/services/chat-registry";
import { parseGroupDeployState } from "@/services/group-deploy";

/**
 * 一键部署校验：把仿真屏配置好的加群验证机器人真实部署到指定群组。
 *
 * 自动校验链（串行，逐级给出准确的 stage 与指引）：
 * 1. getMe            —— Bot Token 有效性
 * 2. getChat          —— 群组真实存在且机器人可见（失败容忍，仅用于取真实群名）
 * 3. getChatMember    —— 机器人是否已在群里 / 是否管理员 / 是否有「邀请用户」权限
 * 4. createChatInviteLink(creates_join_request) —— 生成入群申请链接并保存
 *
 * 全部调用走 transport 层的原生 Bot API 通道（callBotApi → tgRawCall）：edge/workerd
 * 下不经过 grammY 的 Node 专属请求形态（https.Agent / keep-alive / abort-controller
 * polyfill），与「同步真实群组」使用完全同一条出站链路，出错时也能给出准确定位。
 *
 * Telegram 官方限制：机器人无法通过 API 把自己拉进群、也无法自我提升为管理员，
 * 因此步骤「拉进群」「设为管理员」必须由群管理员在 Telegram 客户端手动完成；
 * 校验不通过时返回对应 stage 和喂饭级操作指引。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { bot_id?: string | number; chat_id?: string | number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let botId: bigint;
  let chatId: bigint;
  try {
    botId = BigInt(payload.bot_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }
  try {
    chatId = BigInt(payload.chat_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "群组 ID 不合法" }, { status: 400 });
  }

  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  const tokenBotId = Number(bot.token.split(":")[0]);
  const tokenBotIdValid = Number.isSafeInteger(tokenBotId) && tokenBotId > 0;

  // 1) Token 有效性
  const me = await callBotApi<{ id?: number; username?: string }>(bot.token, "getMe");
  if (me.payload?.ok !== true) {
    return NextResponse.json(
      { ok: false, error: describeBotApiError(me.payload, me.transportError, "getMe") },
      { status: 200 },
    );
  }
  const meUser = me.payload.result ?? {};
  const botUserId = tokenBotIdValid ? tokenBotId : Number(meUser.id);
  if (!Number.isSafeInteger(botUserId) || botUserId <= 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "无法确定机器人 user id（Token 格式异常且 getMe 未返回 id），无法校验群成员身份，请在机器人配置中重新保存 Token",
      },
      { status: 200 },
    );
  }

  // 2) 群组信息（失败容忍：机器人可能还没进群，后续 getChatMember 会给出准确 stage）
  let chatTitle = `群组 ${chatId}`;
  const chat = await callBotApi<{ type?: string; title?: string }>(bot.token, "getChat", {
    chat_id: String(chatId),
  });
  if (chat.payload?.ok === true && chat.payload.result?.type !== "private") {
    chatTitle = chat.payload.result?.title?.trim() || chatTitle;
  } else if (chat.payload === null) {
    console.warn(`[deploy] getChat(${chatId}) 网络失败：${chat.transportError}`);
  } else {
    console.warn(
      `[deploy] getChat(${chatId}) 失败：${chat.payload.error_code ?? "?"} ${chat.payload.description ?? "未知错误"}`,
    );
  }

  // 3) 机器人群成员身份
  const member = await callBotApi<{ status?: string; can_invite_users?: boolean }>(
    bot.token,
    "getChatMember",
    { chat_id: String(chatId), user_id: botUserId },
  );
  if (member.payload === null) {
    // 网络层失败 ≠ 机器人不在群：必须如实报错，否则会把网络问题误导成「去拉机器人进群」
    return NextResponse.json(
      { ok: false, error: `校验机器人群内身份失败：${member.transportError ?? "网络不可达"}` },
      { status: 200 },
    );
  }
  if (member.payload.ok !== true) {
    const code = member.payload.error_code;
    if (code !== 400 && code !== 403) {
      return NextResponse.json(
        { ok: false, error: describeBotApiError(member.payload, null, "getChatMember") },
        { status: 200 },
      );
    }
    const description = member.payload.description ?? "未知错误";
    return NextResponse.json({
      ok: true,
      stage: "add_bot",
      bot_username: meUser.username ?? null,
      chat_title: chatTitle,
      bot_status: "left",
      guide: [
        `无法读取机器人在群「${chatTitle}」中的身份（${description.slice(0, 120)}）`,
        "打开 Telegram，进入你的真实群组 → 群设置 → 「添加成员」",
        `搜索并选择 @${meUser.username ?? "你的机器人"}，确认添加`,
        "添加完成后回到本页，重新点击「开始部署校验」",
      ],
    });
  }

  const status = member.payload.result?.status ?? "left";
  if (status === "left" || status === "kicked") {
    return NextResponse.json({
      ok: true,
      stage: "add_bot",
      bot_username: meUser.username ?? null,
      chat_title: chatTitle,
      bot_status: status,
      guide: [
        "打开 Telegram，进入你的真实群组 → 群设置 → 「添加成员」",
        `搜索并选择 @${meUser.username ?? "你的机器人"}，确认添加`,
        "添加完成后回到本页，重新点击「开始部署校验」",
      ],
    });
  }

  if (status !== "administrator") {
    return NextResponse.json({
      ok: true,
      stage: "promote_admin",
      bot_username: meUser.username ?? null,
      chat_title: chatTitle,
      bot_status: status,
      guide: [
        `机器人已在群「${chatTitle}」中，但还不是管理员`,
        "群设置 → 管理员 → 「添加管理员」→ 选择机器人",
        "权限勾选「邀请用户 via 链接」（必需，用于生成入群申请链接和审批入群）",
        "保存后回到本页，重新点击「开始部署校验」",
      ],
    });
  }

  if (member.payload.result?.can_invite_users !== true) {
    return NextResponse.json({
      ok: true,
      stage: "grant_permission",
      bot_username: meUser.username ?? null,
      chat_title: chatTitle,
      bot_status: status,
      guide: [
        `机器人已是「${chatTitle}」管理员，但缺少「邀请用户 via 链接」权限`,
        "群设置 → 管理员 → 点击机器人 → 开启「邀请用户 via 链接」",
        "保存后回到本页，重新点击「开始部署校验」",
      ],
    });
  }

  // 4) 生成入群申请链接（creates_join_request：必须经机器人审批才能进群）
  const invite = await callBotApi<{ invite_link?: string; name?: string }>(
    bot.token,
    "createChatInviteLink",
    { chat_id: String(chatId), creates_join_request: "true", name: "TGuard 加群验证" },
  );
  if (invite.payload?.ok !== true || !invite.payload.result?.invite_link) {
    return NextResponse.json(
      {
        ok: false,
        stage: "create_invite",
        error: describeBotApiError(invite.payload, invite.transportError, "createChatInviteLink"),
      },
      { status: 200 },
    );
  }
  const inviteLink = invite.payload.result.invite_link;

  const deployedAt = new Date().toISOString();
  try {
    // 先登记群组：补齐 group_settings 群名 + 本 Token 全部机器人条目的关联
    // （registerTelegramChat 不覆盖既有验证配置，也不清空既有部署/权限数据）
    await registerTelegramChat({ chatId, chatTitle, botToken: bot.token });
    await upsertGroupBotAdmin({
      botId: bot.id,
      chatId,
      rights: JSON.stringify({
        can_invite_users: true,
        invite_link: inviteLink,
        invite_link_name: invite.payload.result.name ?? null,
        deployed_at: deployedAt,
        deploy_mode: "join_request",
        bot_username: meUser.username ?? null,
        chat_title: chatTitle,
      }),
      status: "active",
    });
  } catch (error) {
    console.error(`[deploy] 保存部署状态失败（bot=${bot.id}, chat=${chatId}）:`, error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        stage: "persist",
        error: `入群申请链接已生成（${inviteLink}），但保存部署状态失败（数据库）：${detail}`,
      },
      { status: 200 },
    );
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "一键部署到真实群组",
    target: bot.name,
    detail: `群组 ${chatTitle}（${chatId}）生成入群申请链接并保存部署状态`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    stage: "deployed",
    bot_username: meUser.username ?? null,
    chat_title: chatTitle,
    bot_status: status,
    invite_link: inviteLink,
    deployed_at: deployedAt,
    guide: [
      "部署完成！把入群申请链接发给买家（或配置到闲鱼自动发货）",
      "买家点链接 → 申请入群 → 机器人私聊发送验证提示 → 输入验证码通过后自动进群",
      "验证码仅机器人与买家私聊可见，不会出现在群里（隐私模式）",
      "⚠️ 只能分享本系统生成的「入群申请链接」（需机器人审批）！",
      "⚠️ 严禁分享群主 Telegram 客户端里的主邀请链接/任何普通链接 —— 那种链接会绕过审批直接进群；即使有人这样进群，机器人也会私聊要求其补验证，超时/失败将自动移出群组（需机器人有「封禁用户」权限）",
      "💡 推荐入口：t.me/<机器人用户名>?start=join_<群组chat_id>（买家先启动机器人再申请入群，验证更顺畅）",
    ],
  });
}

/** 读取已保存的部署状态（group_bot_admins.rights 中的 deploy 字段） */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const url = new URL(request.url);
  const botId = BigInt(url.searchParams.get("bot_id") ?? "0");
  const chatId = BigInt(url.searchParams.get("chat_id") ?? "0");
  if (!botId || !chatId) {
    return NextResponse.json({ ok: false, error: "参数不完整" }, { status: 400 });
  }
  const row = await getGroupBotAdminByBotAndChat(botId, chatId);
  if (!row) {
    return NextResponse.json({ ok: true, data: null });
  }
  return NextResponse.json({ ok: true, data: parseGroupDeployState(row.rights) });
}
