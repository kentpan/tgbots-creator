import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, getGroupBotAdminByBotAndChat, upsertGroupBotAdmin } from "@/database/operations";
import { botByToken, describeSyncError, withTelegramTimeout } from "@/services/telegram-sync";
import { parseGroupDeployState } from "@/services/group-deploy";

/**
 * 一键部署校验：把仿真屏配置好的加群验证机器人真实部署到指定群组。
 *
 * 自动校验链（v2.0.3：前三步并行，总耗时从串行 3 次之和降到单次最大值）：
 * 1. getMe            —— Bot Token 有效性
 * 2. getChat          —— 群组真实存在且机器人可见
 * 3. getChatMember    —— 机器人是否已在群里 / 是否管理员 / 是否有「邀请用户」权限
 *                        （机器人 user id 直接取自 Token 前段，无需等待 getMe）
 * 4. createChatInviteLink(creates_join_request) —— 生成入群申请链接并保存（校验通过后串行执行）
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

  const api = botByToken(bot.token).api;
  try {
    // v2.0.3 优化：原实现 getMe → getChat → getChatMember 三次串行调用（每次经代理 3~13s，
    // 总耗时可达 40s+）。实际上 getChatMember 需要的机器人 user id 就编码在 Token 前段
    // （Telegram Bot Token 格式：<bot_user_id>:<secret>，官方文档明确），三个调用互不依赖，
    // 全部并行发起 —— 总耗时从三次之和降到单次最大值（约省 2/3）。
    const tokenBotId = Number(bot.token.split(":")[0]);
    const [meResult, chatResult, memberResult] = await Promise.allSettled([
      withTelegramTimeout(api.getMe()),
      withTelegramTimeout(api.getChat(Number(chatId))),
      withTelegramTimeout(api.getChatMember(Number(chatId), tokenBotId)),
    ]);

    // Token 有效性（getMe）：失败直接报错（后续校验无意义）
    if (!meResult || meResult.status === "rejected") {
      throw meResult?.reason ?? new Error("getMe 失败");
    }
    const me = meResult.value;

    // 群信息：失败容忍（大概率机器人不在群，后续 getChatMember 给出准确 stage）
    let chatTitle = `群组 ${chatId}`;
    if (chatResult.status === "fulfilled" && chatResult.value && chatResult.value.type !== "private") {
      chatTitle = ("title" in chatResult.value && chatResult.value.title) || chatTitle;
    }

    // 机器人群成员身份：失败 = 机器人不在群/群不可见 → 拉进群指引
    if (memberResult.status === "rejected") {
      const description =
        memberResult.reason instanceof Error ? memberResult.reason.message : String(memberResult.reason);
      return NextResponse.json({
        ok: true,
        stage: "add_bot",
        bot_username: me.username ?? null,
        chat_title: chatTitle,
        bot_status: "left",
        guide: [
          `无法读取机器人在群「${chatTitle}」中的身份（${description.slice(0, 120)}）`,
          "打开 Telegram，进入你的真实群组 → 群设置 → 「添加成员」",
          `搜索并选择 @${me.username ?? "你的机器人"}，确认添加`,
          "添加完成后回到本页，重新点击「开始部署校验」",
        ],
      });
    }
    const member = memberResult.value;
    const status = member.status;

    if (status === "left" || status === "kicked") {
      return NextResponse.json({
        ok: true,
        stage: "add_bot",
        bot_username: me.username ?? null,
        chat_title: chatTitle,
        bot_status: status,
        guide: [
          "打开 Telegram，进入你的真实群组 → 群设置 → 「添加成员」",
          `搜索并选择 @${me.username ?? "你的机器人"}，确认添加`,
          "添加完成后回到本页，重新点击「开始部署校验」",
        ],
      });
    }

    if (status !== "administrator") {
      return NextResponse.json({
        ok: true,
        stage: "promote_admin",
        bot_username: me.username ?? null,
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

    const canInvite = member.can_invite_users === true;
    if (!canInvite) {
      return NextResponse.json({
        ok: true,
        stage: "grant_permission",
        bot_username: me.username ?? null,
        chat_title: chatTitle,
        bot_status: status,
        guide: [
          `机器人已是「${chatTitle}」管理员，但缺少「邀请用户 via 链接」权限`,
          "群设置 → 管理员 → 点击机器人 → 开启「邀请用户 via 链接」",
          "保存后回到本页，重新点击「开始部署校验」",
        ],
      });
    }

    const invite = await withTelegramTimeout(
      api.createChatInviteLink(Number(chatId), {
        creates_join_request: true,
        name: "TGuard 加群验证",
      }),
    );

    const deployedAt = new Date().toISOString();
    await upsertGroupBotAdmin({
      botId: bot.id,
      chatId,
      rights: JSON.stringify({
        can_invite_users: true,
        invite_link: invite.invite_link,
        invite_link_name: invite.name ?? null,
        deployed_at: deployedAt,
        deploy_mode: "join_request",
        bot_username: me.username ?? null,
        chat_title: chatTitle,
      }),
      status: "active",
    });

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
      bot_username: me.username ?? null,
      chat_title: chatTitle,
      bot_status: status,
      invite_link: invite.invite_link,
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
  } catch (error) {
    return NextResponse.json({ ok: false, error: describeSyncError(error) }, { status: 200 });
  }
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
