import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getBot,
  getGroupBotAdminByBotAndChat,
  getGroupSettings,
  isSuperGroupChatId,
  resolveVerificationChannel,
} from "@/database/operations";
import { botByToken, describeSyncError, withTelegramTimeout } from "@/services/telegram-sync";
import { parseGroupDeployState } from "@/services/group-deploy";
import { acquireStableGroupInviteLink, migratedChatIdFromError } from "@/services/invite-link";

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

    let effectiveChatId = chatId;
    let migratedFromChatId: bigint | null = null;
    const initial = await Promise.allSettled([
      withTelegramTimeout(api.getMe()),
      withTelegramTimeout(api.getChat(Number(effectiveChatId))),
      withTelegramTimeout(api.getChatMember(Number(effectiveChatId), tokenBotId)),
      // v2.0.14 迁移探针（并行零成本）：只读、无需成员身份，对已升级迁移的旧
      // chat_id 返回 400 + parameters.migrate_to_chat_id（getChat/getChatMember
      // 对旧 id 反而正常返回旧实体数据，探测不到迁移）。
      withTelegramTimeout(api.getChatMemberCount(Number(effectiveChatId))),
    ]);
    const meResult = initial[0];
    let chatResult = initial[1];
    let memberResult = initial[2];
    const migrationProbe = initial[3];

    // v2.0.14 群升级迁移自适应：基础群升级超级群后旧 chat_id 的修改类调用全部
    // 400(migrate_to_chat_id)，旧群邀请链接也被 Telegram 全部作废 —— 探针命中
    // 即自动切换新 chat_id 重新校验（机器人身份以新群为准）。
    const migrationFrom = (status: PromiseSettledResult<unknown>): bigint | null => {
      if (status.status !== "rejected") return null;
      const migrated = migratedChatIdFromError(status.reason);
      return migrated !== null && migrated !== chatId ? migrated : null;
    };
    const migratedTarget =
      migrationFrom(migrationProbe) ?? migrationFrom(memberResult) ?? null;
    if (migratedTarget !== null) {
      migratedFromChatId = chatId;
      effectiveChatId = migratedTarget;
      const retried = await Promise.allSettled([
        withTelegramTimeout(api.getChat(Number(effectiveChatId))),
        withTelegramTimeout(api.getChatMember(Number(effectiveChatId), tokenBotId)),
      ]);
      chatResult = retried[0];
      memberResult = retried[1];
    }

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
    // （v2.0.14：403 "bot was kicked" 识别为被踢状态 —— 被踢会连带你此前生成的
    //   全部邀请链接一起作废，指引里明确提示）
    if (memberResult.status === "rejected") {
      const description =
        memberResult.reason instanceof Error ? memberResult.reason.message : String(memberResult.reason);
      const kicked = /kicked/i.test(description);
      return NextResponse.json({
        ok: true,
        stage: "add_bot",
        bot_username: me.username ?? null,
        chat_title: chatTitle,
        bot_status: kicked ? "kicked" : "left",
        guide: [
          kicked
            ? `机器人此前已被移出群「${chatTitle}」（${description.slice(0, 120)}）`
            : `无法读取机器人在群「${chatTitle}」中的身份（${description.slice(0, 120)}）`,
          "打开 Telegram，进入你的真实群组 → 群设置 → 「添加成员」",
          `搜索并选择 @${me.username ?? "你的机器人"}，确认添加`,
          "添加完成后回到本页，重新点击「开始部署校验」",
          ...(kicked
            ? [
                "⚠️ 机器人被移出群组时，它此前生成的邀请链接已被 Telegram 全部作废；重新部署会自动检测并生成新链接，请以最新部署的链接为准",
              ]
            : []),
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
          "⚠️ 机器人被移出群组时，它此前生成的邀请链接已被 Telegram 全部作废；重新部署会自动检测并生成新链接，请以最新部署的链接为准",
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

    // v2.0.12：Telegram 官方限制 creates_join_request 仅超级群/频道可用，
    // 基础群传该参数会直接报错 —— 按群组类型自动选择链接形态：
    // 超级群/频道 → 申请制链接（点链接出「申请加入」按钮 → chat_join_request 事件）；
    // 基础群 → 普通链接（点链接直接进群 → chat_member 事件触发补验证，私聊发码）
    //
    // v2.0.14：不再每次部署都无条件新建链接 —— 优先复用已保存的邀请链接
    // （editChatInviteLink 存活探测，is_revoked/报错视为死链才重建），并把部署
    // 状态合并写回 rights（不再整列覆盖，避免与机器人权限配置互踩）。
    let superGroup = isSuperGroupChatId(effectiveChatId);
    let linkAcquired: Awaited<ReturnType<typeof acquireStableGroupInviteLink>>;
    try {
      linkAcquired = await withTelegramTimeout(
        acquireStableGroupInviteLink({
          api,
          chatId: effectiveChatId,
          superGroup,
          botId: bot.id,
          meta: { bot_username: me.username ?? null, chat_title: chatTitle },
        }),
      );
    } catch (error) {
      // 极小概率：校验通过后、建链前群组刚好完成升级迁移 → 切换新 chat_id 重试一次
      const migrated = migratedChatIdFromError(error);
      if (migrated === null || migrated === effectiveChatId) {
        throw error;
      }
      migratedFromChatId = effectiveChatId;
      effectiveChatId = migrated;
      const [chatNow, memberNow] = await Promise.allSettled([
        withTelegramTimeout(api.getChat(Number(effectiveChatId))),
        withTelegramTimeout(api.getChatMember(Number(effectiveChatId), tokenBotId)),
      ]);
      if (chatNow.status === "fulfilled" && chatNow.value && chatNow.value.type !== "private") {
        chatTitle = ("title" in chatNow.value && chatNow.value.title) || chatTitle;
      }
      if (memberNow.status === "rejected" || memberNow.value.status !== "administrator") {
        return NextResponse.json({
          ok: true,
          stage: "add_bot",
          bot_username: me.username ?? null,
          chat_title: chatTitle,
          bot_status: memberNow.status === "rejected" ? "left" : memberNow.value.status,
          chat_id: String(effectiveChatId),
          migrated_from_chat_id: migratedFromChatId !== null ? String(migratedFromChatId) : null,
          guide: [
            `该群组刚从基础群升级为超级群（新群 ID ${effectiveChatId}），请在新群中把机器人重新设为管理员后重新部署`,
          ],
        });
      }
      superGroup = isSuperGroupChatId(effectiveChatId);
      linkAcquired = await withTelegramTimeout(
        acquireStableGroupInviteLink({
          api,
          chatId: effectiveChatId,
          superGroup,
          botId: bot.id,
          meta: { bot_username: me.username ?? null, chat_title: chatTitle },
        }),
      );
    }

    const requestHeaders = await headers();
    await logOperation(admin, {
      action: "一键部署到真实群组",
      target: bot.name,
      detail:
        `群组 ${chatTitle}（${effectiveChatId}${migratedFromChatId !== null ? ` ← 由 ${migratedFromChatId} 迁移` : ""}）` +
        `${linkAcquired.reused ? "复用已有邀请链接" : "生成新邀请链接"}并保存部署状态`,
      headers: requestHeaders,
    });

    // v2.1.1：部署指引与实际验证渠道严格一致 —— 不再硬编码「私聊发码」文案（
    // 旧文案与 v2.0.12 群内验证渠道矛盾，用户按文案预期「输码后进群」却观察到
    // 「先进群后验证」，被误判为功能损坏）。按群当前渠道设置生成本群真实流程说明。
    let verificationChannel: "group" | "dm" = isSuperGroupChatId(effectiveChatId) ? "group" : "dm";
    try {
      const settings = await getGroupSettings(effectiveChatId);
      verificationChannel = resolveVerificationChannel(settings, effectiveChatId);
    } catch {
      /* 设置读取失败时按群型默认值展示 */
    }

    const guide = superGroup
      ? verificationChannel === "group"
        ? [
            "部署完成！把入群申请链接发给买家（或配置到闲鱼自动发货）",
            "本群当前验证渠道为「群内验证」（验证渠道=自动 + 超级群，或在群组信息中显式选择）：",
            "买家点链接 → 申请入群 → 机器人自动批准进群并禁言 → 群内点击「验证」按钮在验证页面输入验证码完成验证 → 自动解禁畅聊",
            "验证码在验证页面输入，群里其他成员不可见（隐私红线）",
            "⚠️ 只能分享本系统生成的「入群申请链接」（需机器人审批）！",
            "⚠️ 严禁分享群主 Telegram 客户端里的主邀请链接/任何普通链接 —— 那种链接会绕过审批直接进群；即使有人这样进群，机器人也会要求其补验证，超时/失败将自动移出群组（需机器人有「封禁用户」权限）",
            "💡 推荐入口：t.me/<机器人用户名>?start=join_<群组chat_id>（买家先启动机器人再申请入群，验证更顺畅）",
            "💡 链接复用：重复部署不会生成新链接；机器人被移出群或群升级为超级群时旧链接会被 Telegram 作废，系统会在下次部署时自动检测并重建",
          ]
        : [
            "部署完成！把入群申请链接发给买家（或配置到闲鱼自动发货）",
            "本群当前验证渠道为「私聊验证」（在群组信息 → 验证渠道中配置）：",
            "买家点链接 → 申请入群 → 机器人私聊发送验证提示 → 输入验证码通过后自动进群",
            "验证码仅机器人与买家私聊可见，不会出现在群里（隐私模式）",
            "⚠️ 私聊验证要求买家先启动机器人（t.me/<机器人用户名>?start=join_<群组chat_id>），否则机器人无法私聊发码",
            "⚠️ 只能分享本系统生成的「入群申请链接」（需机器人审批）！严禁分享群主客户端里的主邀请链接",
          ]
      : [
          "部署完成！该群组为基础群（Telegram 限制：不支持「申请加入」审批制链接），已自动改用普通邀请链接：",
          "买家点链接 → 直接进群 → 机器人私聊发送验证码 → 回复验证码完成验证（验证失败/超时自动移出）",
          "验证码仅机器人与买家私聊可见，不会出现在群里（隐私模式）",
          "💡 基础群买家必须先启动机器人（t.me/<机器人用户名>?start=join_<群组chat_id>）才能收到私聊验证码",
          "💡 如需「申请加入」审批制入群体验，请将群组升级为超级群（Telegram 群设置 → 将群组变为可见/超级群）",
        ];
    if (linkAcquired.reused) {
      guide.unshift("✅ 该群组已有有效邀请链接，本次直接复用（未生成新链接）——历史发出的链接仍然可用");
    }
    if (migratedFromChatId !== null) {
      guide.unshift(
        `⚠️ 该群组已从基础群升级为超级群（旧群 ID ${migratedFromChatId} → 新群 ID ${effectiveChatId}），旧邀请链接已被 Telegram 全部作废`,
        "已按新群 ID 保存部署状态 —— 请以本次展示的链接为准，并把新链接发给买家（旧链接/旧群 ID 深链请撤回）",
      );
    }

    return NextResponse.json({
      ok: true,
      stage: "deployed",
      bot_username: me.username ?? null,
      chat_title: chatTitle,
      bot_status: status,
      chat_id: String(effectiveChatId),
      migrated_from_chat_id: migratedFromChatId !== null ? String(migratedFromChatId) : null,
      invite_link: linkAcquired.invite_link,
      reused: linkAcquired.reused,
      deployed_at: linkAcquired.deployed_at,
      deploy_mode: superGroup ? "join_request" : "direct",
      guide,
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
