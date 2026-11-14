import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getGroupSettings,
  listBots,
  upsertGroupSettings,
} from "@/database/operations";

/**
 * 仿真屏群组设置页（iOS 群组信息界面）的群组验证配置读写。
 *
 * 源头复用：读取走 getGroupSettings，保存走 upsertGroupSettings ——
 * 与「群组管理」页面（/admin/groups saveGroupAction）完全同一数据管道，
 * 校验规则一致（method 合法性、code_api 必须绑定 method），保证两处配置互不漂移。
 */

// v2.3：群级验证方式配置已停用（方式统一在机器人级 joinVerify 配置），
// 本路由只负责：群名 / 启用 / 三段文案 / 新成员审核开关 / 自动审核机器人指定。

export async function GET(request: Request): Promise<NextResponse> {

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const chatIdRaw = new URL(request.url).searchParams.get("chat_id") ?? "";
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }

  const settings = await getGroupSettings(chatId);
  // v2.3 自动审核机器人候选：bots.config.joinVerify.enabled 的机器人（Q4：只有开启了
  // 自动响应加群申请的机器人才进入下拉；群未指定时默认手动审核）
  const bots = await listBots();
  const { parseBotFeatureConfig } = await import("@/services/bot-feature-config");
  const joinVerifyCandidates = bots
    .filter((bot) => {
      const feature = parseBotFeatureConfig(bot.config, false);
      return bot.enabled && feature.joinVerify.enabled && (feature.joinVerify.mode === "direct" || feature.joinVerify.methodId);
    })
    .map((bot) => ({ id: String(bot.id), name: bot.name }));

  return NextResponse.json({
    ok: true,
    data: {
      settings: settings
        ? {
            chat_id: String(settings.chatId),
            chat_title: settings.chatTitle,
            method: settings.method,
            method_id: settings.methodId === null ? null : String(settings.methodId),
            timeout_seconds: settings.timeoutSeconds,
            max_attempts: settings.maxAttempts,
            prompt_text: settings.promptText,
            success_text: settings.successText,
            failure_text: settings.failureText,
            enabled: settings.enabled,
            privacy_mode: settings.privacyMode,
            verification_channel: settings.verificationChannel,
            kick_direct_joins: settings.kickDirectJoins,
            reply_code_in_group: settings.replyCodeInGroup,
            require_approval: settings.requireApproval,
            join_verify_bot_id:
              settings.joinVerifyBotId === null ? null : String(settings.joinVerifyBotId),
          }
        : null,
      join_verify_candidates: joinVerifyCandidates,
    },
  });
}

export async function PUT(request: Request): Promise<NextResponse> {

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "groups:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要群组管理权限）" }, { status: 403 });
  }

  let payload: {
    chat_id?: string | number;
    chat_title?: string;
    /** v2.3 群级验证方式配置已停用：字段仅保留接收以兼容旧调用方，值不再落库 */
    method?: string;
    method_id?: string | number | null;
    timeout_seconds?: number;
    max_attempts?: number;
    prompt_text?: string;
    success_text?: string;
    failure_text?: string;
    enabled?: boolean;
    privacy_mode?: boolean;
    verification_channel?: string;
    /** v2.0.7 直连入群踢出开关（默认关闭） */
    kick_direct_joins?: boolean;
    /** v2.1.5 群内回复输码快速验证（默认关闭） */
    reply_code_in_group?: boolean;
    /** v2.3 新成员审核（审批制入群）开关 */
    require_approval?: boolean;
    /** v2.3 自动审核机器人（null=手动审核） */
    join_verify_bot_id?: string | number | null;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const chatIdRaw = String(payload.chat_id ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const chatId = BigInt(chatIdRaw);

  const existing = await getGroupSettings(chatId);

  // 自动审核机器人指定：显式传 null = 手动审核；未传 = 不改动
  let joinVerifyBotIdValue: bigint | null | undefined;
  if (payload.join_verify_bot_id !== undefined) {
    const raw = payload.join_verify_bot_id === null ? "" : String(payload.join_verify_bot_id).trim();
    if (!raw) {
      joinVerifyBotIdValue = null;
    } else if (/^\d+$/.test(raw)) {
      joinVerifyBotIdValue = BigInt(raw);
    } else {
      return NextResponse.json({ ok: false, error: "自动审核机器人 ID 不合法" }, { status: 400 });
    }
  }

  await upsertGroupSettings(chatId, {
    // 群名与群组管理页同源可编辑：未传时保留现值，避免被清空
    chatTitle:
      payload.chat_title === undefined
        ? (existing?.chatTitle ?? null)
        : String(payload.chat_title ?? "").trim() || null,
    enabled: payload.enabled ?? existing?.enabled ?? true,
    promptText:
      payload.prompt_text === undefined
        ? undefined
        : String(payload.prompt_text ?? "").trim() || undefined,
    successText:
      payload.success_text === undefined
        ? undefined
        : String(payload.success_text ?? "").trim() || undefined,
    failureText:
      payload.failure_text === undefined
        ? undefined
        : String(payload.failure_text ?? "").trim() || undefined,
    // v2.3 新成员审核开关：未传时保留现值（undefined 语义 = 不改动）
    requireApproval: payload.require_approval ?? existing?.requireApproval,
    joinVerifyBotId: joinVerifyBotIdValue,
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "仿真屏保存群组配置",
    target: chatIdRaw,
    detail: `新成员审核：${payload.require_approval === undefined ? "未改动" : payload.require_approval ? "开启" : "关闭"}；自动审核机器人：${
      payload.join_verify_bot_id === undefined
        ? "未改动"
        : joinVerifyBotIdValue === null
          ? "手动审核"
          : `#${String(joinVerifyBotIdValue)}`
    }`,
    headers: requestHeaders,
  });

  const settings = await getGroupSettings(chatId);
  return NextResponse.json({
    ok: true,
    data: settings
      ? {
          chat_id: String(settings.chatId),
          chat_title: settings.chatTitle,
          prompt_text: settings.promptText,
          success_text: settings.successText,
          failure_text: settings.failureText,
          enabled: settings.enabled,
          require_approval: settings.requireApproval,
          join_verify_bot_id:
            settings.joinVerifyBotId === null ? null : String(settings.joinVerifyBotId),
        }
      : null,
  });
}
