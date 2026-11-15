import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getGroupSettings,
  getBot,
  listBots,
  listVerificationMethods,
  getVerificationMethod,
  upsertGroupSettings,
} from "@/database/operations";

/**
 * 仿真屏群组设置页（iOS 群组信息界面）的群组验证配置读写。
 *
 * 源头复用：读取走 getGroupSettings，保存走 upsertGroupSettings ——
 * 与「群组管理」页面（/admin/groups saveGroupAction）完全同一数据管道，
 * 群组审核模式与验证方式独立保存；验证方式引用全局 verification_methods 字典。
 */

// v2.3.5：审核模式与验证方式属于群组私有配置；机器人级只决定是否具备自动响应能力。

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
  // v3.0.3：验证方式库全部方法（含停用）—— 绑定验证方法下拉与「解锁门禁配置」同一规则，
  // enabled 标记随行返回供下拉显示（启用/停用）。
  const verificationMethods = (await listVerificationMethods()).map((method) => ({ id: String(method.id), name: method.name, type: method.type, enabled: method.enabled }));
  const { parseBotFeatureConfig } = await import("@/services/bot-feature-config");
  const joinVerifyCandidates = bots
    .filter((bot) => {
      const feature = parseBotFeatureConfig(bot.config, false);
      return bot.enabled && feature.joinVerify.enabled;
    })
    .map((bot) => ({ id: String(bot.id), name: bot.name }));

  // v2.3.5 生效策略（与 services/join-verify.ts 运行时解析同语义）：
  // 群组私有列非 NULL 取群组值；NULL（历史群组未显式保存策略）回退该群绑定
  // 机器人的 bot 级 joinVerify 配置；未绑定机器人或机器人不存在则保持 NULL。
  // v3.0.3：join_verify_mode 拆分后含 group/dm 显式渠道值，历史值 verify/null 原样返回
  // （前端按 chat_type 映射显示，与 resolveJoinVerifyChannel 历史语义一致）。
  const effectiveJoinVerifyMode: "verify" | "direct" | "group" | "dm" | null = settings?.joinVerifyMode ?? null;
  let effectiveJoinVerifyMethodId: bigint | null = settings?.joinVerifyMethodId ?? null;
  if (effectiveJoinVerifyMode === null && settings?.joinVerifyBotId != null) {
    const boundBot = await getBot(settings.joinVerifyBotId);
    const feature = boundBot ? parseBotFeatureConfig(boundBot.config, false) : null;
    if (feature?.joinVerify.enabled && feature.joinVerify.methodId) {
      effectiveJoinVerifyMethodId = BigInt(feature.joinVerify.methodId);
    }
  }

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
            chat_type: settings.chatType,
            join_verify_bot_id:
              settings.joinVerifyBotId === null ? null : String(settings.joinVerifyBotId),
            join_verify_mode: effectiveJoinVerifyMode,
            join_verify_method_id: effectiveJoinVerifyMethodId === null ? null : String(effectiveJoinVerifyMethodId),
          }
        : null,
      join_verify_candidates: joinVerifyCandidates,
      verification_methods: verificationMethods,
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
    /** v3.0.3 拆分：group=群内验证 / dm=私聊验证 / direct=直接通过；verify=历史值兼容 */
    join_verify_mode?: "verify" | "direct" | "group" | "dm";
    join_verify_method_id?: string | number | null;
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

  // v3.0.3 申请处理方式拆分：group/dm/direct 显式值；未传 = 不改动（保留现值）；
  // 未知/历史值回落 verify（旧语义）
  const joinVerifyMode: "verify" | "direct" | "group" | "dm" | undefined =
    payload.join_verify_mode === undefined
      ? undefined
      : payload.join_verify_mode === "direct" || payload.join_verify_mode === "group" || payload.join_verify_mode === "dm"
        ? payload.join_verify_mode
        : "verify";
  let joinVerifyMethodId: bigint | null | undefined;
  if (payload.join_verify_method_id !== undefined) {
    const raw = payload.join_verify_method_id === null ? "" : String(payload.join_verify_method_id).trim();
    if (!raw) joinVerifyMethodId = null;
    else if (/^\d+$/.test(raw)) {
      const method = await getVerificationMethod(BigInt(raw));
      if (!method || !method.enabled) return NextResponse.json({ ok: false, error: "所选验证方式不存在或已停用" }, { status: 400 });
      joinVerifyMethodId = BigInt(raw);
    } else return NextResponse.json({ ok: false, error: "验证方式 ID 不合法" }, { status: 400 });
  }

  const effectiveRequireApproval = payload.require_approval ?? existing?.requireApproval ?? false;
  const effectiveBotId = joinVerifyBotIdValue === undefined ? (existing?.joinVerifyBotId ?? null) : joinVerifyBotIdValue;
  const effectiveMode = joinVerifyMode ?? existing?.joinVerifyMode ?? "verify";
  const effectiveMethodId = joinVerifyMethodId === undefined ? (existing?.joinVerifyMethodId ?? null) : joinVerifyMethodId;
  // v3.0.3：group/dm 与历史 verify 同为验证模式（direct 除外），必须绑定验证方式
  if (
    effectiveRequireApproval &&
    effectiveBotId !== null &&
    effectiveMode !== "direct" &&
    effectiveMethodId === null &&
    payload.join_verify_mode !== undefined
  ) {
    return NextResponse.json({ ok: false, error: "该群选择了验证码验证，请先绑定一种验证方式；如需免验证请选择「直接通过申请」" }, { status: 400 });
  }

  await upsertGroupSettings(chatId, {
    // 群名与群组管理页同源可编辑：未传时保留现值，避免被清空
    chatTitle:
      payload.chat_title === undefined
        ? (existing?.chatTitle ?? null)
        : String(payload.chat_title ?? "").trim() || null,
    enabled: payload.enabled ?? existing?.enabled ?? true,
    // v3.0.2 三段验证文案 tri-state：未传 = 保留现值；空串 = 清空保存（运行时不发送，
    // 语义为「置空=不发送」而非回落默认）；非空 = 写入（支持多行）。
    promptText:
      payload.prompt_text === undefined
        ? undefined
        : String(payload.prompt_text ?? "").trim(),
    successText:
      payload.success_text === undefined
        ? undefined
        : String(payload.success_text ?? "").trim(),
    failureText:
      payload.failure_text === undefined
        ? undefined
        : String(payload.failure_text ?? "").trim(),
    // v2.3 新成员审核开关：未传时保留现值（undefined 语义 = 不改动）
    requireApproval: payload.require_approval ?? existing?.requireApproval,
    joinVerifyBotId: joinVerifyBotIdValue,
    joinVerifyMode: joinVerifyMode ?? existing?.joinVerifyMode,
    joinVerifyMethodId,
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "仿真屏保存群组配置",
    target: chatIdRaw,
    detail: `新成员审核：${payload.require_approval === undefined ? "未改动" : payload.require_approval ? "开启" : "关闭"}；审核模式：${payload.join_verify_mode ?? "未改动"}；验证方式：${payload.join_verify_method_id ?? "未改动"}；自动审核机器人：${
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
          join_verify_mode: settings.joinVerifyMode,
          join_verify_method_id: settings.joinVerifyMethodId === null ? null : String(settings.joinVerifyMethodId),
        }
      : null,
  });
}
