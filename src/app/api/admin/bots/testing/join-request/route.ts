import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import {
  createJoinRequest,
  createVerificationMethod,
  createVerificationSession,
  getBot,
  getGroupSettings,
  getVerificationMethod,
  getVerificationMethodByName,
  updateVerificationMethod,
  upsertGroupSettings,
  type GroupSettingsRow,
} from "@/database/operations";
import { generateJoinCode, generateVerificationToken } from "@/utils/crypto";
import { parseCodeApiConfig, type CodeApiConfig } from "@/services/external-verify";
import { buildGroupPromptPlainText, buildOptionCodes } from "@/services/group-verification";

/** 仿真屏使用的固定模拟用户（与仿真屏模板变量保持一致） */
export const SIMULATED_USER_ID = 777000n;

/** 仿真屏自动创建/复用的验证方式固定名称（verification_methods.name 全局唯一） */
const SIMULATOR_METHOD_NAME = "加群验证码核验（外部API）";

/** 弹窗提交的验证 API 配置（与 CodeApiConfig 对应，body_template 由后端按卡密字段名生成） */
interface JoinApiConfigInput {
  url?: string;
  api_key?: string;
  http_method?: string;
  code_field?: string;
  success_status?: number;
  success_field?: string;
  success_value?: string;
  timeout_seconds?: number;
}

function isValidHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** 由弹窗配置构建持久化到 verification_methods.config 的 JSON */
function buildMethodConfig(input: JoinApiConfigInput): CodeApiConfig | null {
  const url = String(input.url ?? "").trim();
  const apiKey = String(input.api_key ?? "").trim();
  const codeField = (String(input.code_field ?? "").trim() || "code").replace(/"/g, "");
  if (!isValidHttpUrl(url)) return null;
  if (!apiKey) return null;
  const httpMethod = String(input.http_method ?? "POST").toUpperCase() === "GET" ? "GET" : "POST";
  return {
    url,
    api_key: apiKey,
    http_method: httpMethod,
    code_field: codeField,
    // POST 请求体：{ "<卡密字段名>": "{{code}}" }，{{code}} 提交时替换为买家输入的卡密
    ...(httpMethod === "POST" ? { body_template: JSON.stringify({ [codeField]: "{{code}}" }) } : {}),
    success_status: typeof input.success_status === "number" && input.success_status > 0 ? input.success_status : 200,
    success_field: String(input.success_field ?? "").trim() || "success",
    success_value: String(input.success_value ?? "").trim() || "true",
    timeout_seconds:
      typeof input.timeout_seconds === "number" && input.timeout_seconds > 0
        ? Math.min(input.timeout_seconds, 60)
        : 10,
  };
}

/**
 * GET /api/admin/bots/testing/join-request?chat_id=xxx
 * 读取该群组当前绑定的外部验证 API 配置，用于「模拟加群申请」弹窗预填。
 */
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
  const method =
    settings?.methodId !== null && settings?.methodId !== undefined
      ? await getVerificationMethod(settings.methodId)
      : null;
  const config = method && method.type === "code_api" ? parseCodeApiConfig(method.config) : null;

  return NextResponse.json({
    ok: true,
    data: {
      method_id: method ? String(method.id) : null,
      method_name: method?.name ?? null,
      config,
    },
  });
}

/**
 * 模拟加群申请（机器人测试页仿真屏，弹窗配置式）。
 * 与真实 chat_join_request 处理（bot/handlers/chat-member.ts）完全一致：
 * 创建 join_requests（request_type=simulator，便于在加群申请列表中区分来源）
 * + verification_sessions（method=code_api），返回群组配置的验证提示文案。
 *
 * 弹窗可携带 api_config：发起前将该配置持久化到群组绑定的验证方式
 * （不存在时自动创建「加群验证码核验（外部API）」并绑定），仿真与真实验证共用同一配置。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { chat_id?: string | number; api_config?: JoinApiConfigInput; bot_id?: string | number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let chatId: bigint;
  try {
    chatId = BigInt(payload.chat_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }

  // 弹窗配置校验（先行，避免先建方法再失败）
  let newConfig: CodeApiConfig | null = null;
  if (payload.api_config) {
    newConfig = buildMethodConfig(payload.api_config);
    if (!newConfig) {
      return NextResponse.json(
        { ok: false, error: "验证 API 配置不合法：需 http/https 地址且 Bearer API Key 非空" },
        { status: 400 },
      );
    }
  }

  let settings: GroupSettingsRow | null = await getGroupSettings(chatId);
  if (settings && !settings.enabled) {
    return NextResponse.json({ ok: false, error: "该群组验证已停用" }, { status: 400 });
  }

  if (newConfig) {
    // v2.0.1：method_id 允许在任意验证方式下作为「偏好」落库（弹窗回显），
    // 仅 method=code_api 时才视为「已绑定」。若不加守卫，code_self 群组
    // 携带 api_config 模拟加群会误改用户绑定的外部方法（如 #3 核验 API）配置。
    const boundMethodId =
      settings?.method === "code_api" &&
      settings?.methodId !== null &&
      settings?.methodId !== undefined
        ? settings.methodId
        : null;
    const existingMethod =
      boundMethodId !== null
        ? await getVerificationMethod(boundMethodId)
        : // 群组未绑定：按固定名称复用全局已有方法（name 全局唯一，
          // 直接 INSERT 会 UNIQUE constraint failed: verification_methods.name）
          await getVerificationMethodByName(SIMULATOR_METHOD_NAME);
    if (existingMethod) {
      // 更新验证方式配置（仿真与真实验证共用）
      const updated = await updateVerificationMethod(existingMethod.id, {
        type: "code_api",
        config: JSON.stringify(newConfig),
        enabled: true,
      });
      if (!updated) {
        return NextResponse.json({ ok: false, error: "保存验证 API 配置失败" }, { status: 500 });
      }
      if (boundMethodId === null) {
        // 复用的方法原本未绑定到本群组：补绑定
        await upsertGroupSettings(chatId, {
          chatTitle: settings?.chatTitle ?? null,
          method: "code_api",
          methodId: existingMethod.id,
          timeoutSeconds: settings?.timeoutSeconds,
          maxAttempts: settings?.maxAttempts,
          promptText: settings?.promptText,
          successText: settings?.successText,
          failureText: settings?.failureText,
        });
      }
    } else {
      // 全局不存在同名方法：首次创建并绑定
      const created = await createVerificationMethod({
        name: SIMULATOR_METHOD_NAME,
        type: "code_api",
        config: JSON.stringify(newConfig),
        enabled: true,
      });
      if (!created) {
        return NextResponse.json({ ok: false, error: "创建验证方式失败" }, { status: 500 });
      }
      await upsertGroupSettings(chatId, {
        chatTitle: settings?.chatTitle ?? null,
        method: "code_api",
        methodId: created.id,
        timeoutSeconds: settings?.timeoutSeconds,
        maxAttempts: settings?.maxAttempts,
        promptText: settings?.promptText,
        successText: settings?.successText,
        failureText: settings?.failureText,
      });
    }
    settings = await getGroupSettings(chatId);
  }

  if (!settings) {
    return NextResponse.json({ ok: false, error: "该群组尚未配置验证设置" }, { status: 404 });
  }

  // v2.1.0 验证渠道：group=群内验证（默认真实流程）/ dm=私聊验证（旧版仿真行为）
  const channel: "group" | "dm" = settings.verifyChannel === "dm" ? "dm" : "group";
  const origin = new URL(request.url).origin;

  // v1.1.7：code_self（自动验证码）仿真 —— 与真实 bootstrap（chat-member.ts）一致：
  // 生成验证码随会话落库；群内渠道下再生成 4 选 1 候选按钮（含正确码），
  // 提交校验走同一 evaluateSubmittedCode 管道，行为逐字一致
  if (settings.method === "code_self") {
    const joinCode = generateJoinCode();
    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + settings.timeoutSeconds * 1000);
    const optionCodes = channel === "group" ? buildOptionCodes(joinCode) : null;

    const joinRequest = await createJoinRequest({
      userId: SIMULATED_USER_ID,
      chatId,
      username: "preview_user",
      firstName: "预览",
      lastName: "用户",
      verificationToken: token,
      requestType: "simulator",
    });
    if (!joinRequest) {
      return NextResponse.json({ ok: false, error: "创建模拟加群申请失败" }, { status: 500 });
    }
    const session = await createVerificationSession({
      token,
      userId: SIMULATED_USER_ID,
      chatId,
      expiresAt,
      method: "code_self",
      expectedCode: joinCode,
      channel,
      optionCodes,
    });
    if (!session) {
      return NextResponse.json({ ok: false, error: "创建验证会话失败" }, { status: 500 });
    }
    console.log(
      `Simulator join request created (code_self, channel=${channel}): user ${SIMULATED_USER_ID} -> chat ${chatId}`,
    );

    // 提示文案与真实私聊消息（verification-prompt.ts buildCodeSelfPromptHTML）逐字一致（纯文本形态）
    const minutes = Math.max(1, Math.round(settings.timeoutSeconds / 60));
    const promptText =
      `${settings.promptText ?? "🔐 请回复本消息并输入验证码完成验证"}\n\n` +
      `您的入群验证码：${joinCode}\n\n` +
      `⏱ 验证码 ${minutes} 分钟内有效，请回复本消息并输入上述验证码完成验证，验证通过后将自动批准入群。请勿把验证码泄露给他人。`;

    const groupPromptText =
      channel === "group"
        ? buildGroupPromptPlainText({
            chatId,
            userId: SIMULATED_USER_ID,
            displayName: "预览 用户",
            chatTitle: settings.chatTitle,
            method: "code_self",
            expiresAt,
            optionCodes,
          })
        : null;

    return NextResponse.json({
      ok: true,
      data: {
        token,
        chat_id: String(chatId),
        chat_title: settings.chatTitle,
        username: "preview_user",
        user_id: String(SIMULATED_USER_ID),
        prompt_text: promptText,
        success_text: settings.successText,
        failure_text: settings.failureText,
        timeout_seconds: settings.timeoutSeconds,
        max_attempts: settings.maxAttempts,
        expires_at: expiresAt.toISOString(),
        method_id: "",
        method_name: "自动验证码（输入验证码加群）",
        expected_code: joinCode,
        verify_channel: channel,
        option_codes: optionCodes,
        group_prompt_text: groupPromptText,
        verify_url: null,
      },
    });
  }

  if (settings.method !== "code_api" || settings.methodId === null) {
    return NextResponse.json(
      { ok: false, error: "该群组未启用验证码类验证方式（自动验证码/外部API），无法进行验证码仿真" },
      { status: 400 },
    );
  }
  const method = await getVerificationMethod(settings.methodId);
  if (!method || !method.enabled) {
    return NextResponse.json({ ok: false, error: "该群组绑定的验证方式不可用" }, { status: 400 });
  }

  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + settings.timeoutSeconds * 1000);

  const joinRequest = await createJoinRequest({
    userId: SIMULATED_USER_ID,
    chatId,
    username: "preview_user",
    firstName: "预览",
    lastName: "用户",
    verificationToken: token,
    requestType: "simulator",
  });
  if (!joinRequest) {
    return NextResponse.json({ ok: false, error: "创建模拟加群申请失败" }, { status: 500 });
  }

  const session = await createVerificationSession({
    token,
    userId: SIMULATED_USER_ID,
    chatId,
    expiresAt,
    method: "code_api",
    channel,
  });
  if (!session) {
    return NextResponse.json({ ok: false, error: "创建验证会话失败" }, { status: 500 });
  }

  console.log(
    `Simulator join request created (code_api, channel=${channel}): user ${SIMULATED_USER_ID} -> chat ${chatId}`,
  );

  // 隐私红线：仿真动作一律只停留在仿真屏，绝不真实发送到群组；
  // 群内渠道的「群内验证消息」由仿真屏按 group_prompt_text + verify_url 渲染气泡。
  const verifyUrl = channel === "group" ? `${origin}/verify?token=${token}` : null;

  return NextResponse.json({
    ok: true,
    data: {
      token,
      chat_id: String(chatId),
      chat_title: settings.chatTitle,
      username: "preview_user",
      user_id: String(SIMULATED_USER_ID),
      prompt_text: settings.promptText,
      success_text: settings.successText,
      failure_text: settings.failureText,
      timeout_seconds: settings.timeoutSeconds,
      max_attempts: settings.maxAttempts,
      expires_at: expiresAt.toISOString(),
      method_id: String(settings.methodId),
      method_name: method.name,
      verify_channel: channel,
      option_codes: null,
      group_prompt_text:
        channel === "group"
          ? buildGroupPromptPlainText({
              chatId,
              userId: SIMULATED_USER_ID,
              displayName: "预览 用户",
              chatTitle: settings.chatTitle,
              method: "code_api",
              expiresAt,
              optionCodes: null,
            })
          : null,
      verify_url: verifyUrl,
    },
  });
}
