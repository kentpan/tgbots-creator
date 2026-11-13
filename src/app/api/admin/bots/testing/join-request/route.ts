import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import {
  createJoinRequest,
  createVerificationSession,
  getVerificationMethod,
  updateVerificationMethod,
} from "@/database/operations";
import { generateJoinCode, generateVerificationToken } from "@/utils/crypto";
import { parseCodeApiConfig, type CodeApiConfig } from "@/services/external-verify";
import { resolveJoinVerify } from "@/services/join-verify";

/** 仿真屏使用的固定模拟用户（与仿真屏模板变量保持一致） */
export const SIMULATED_USER_ID = 777000n;

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
 * GET /api/admin/bots/testing/join-request?chat_id=xxx&bot_id=xxx
 * 读取该机器人加群验证绑定的外部验证 API 配置，用于仿真弹窗预填。
 * 验证方式为机器人级配置（bots.config.joinVerify），不再读群级字段。
 */
export async function GET(request: Request): Promise<NextResponse> {

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const chatIdRaw = params.get("chat_id") ?? "";
  const botIdRaw = params.get("bot_id") ?? "";
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  let botId: bigint;
  try {
    botId = BigInt(botIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }

  const { getGroupSettings } = await import("@/database/operations");
  const settings = await getGroupSettings(chatId);
  const resolved = await resolveJoinVerify(botId, settings);
  const method =
    resolved?.methodDbId !== null && resolved?.methodDbId !== undefined
      ? await getVerificationMethod(resolved.methodDbId)
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
 * 模拟加群申请（机器人测试页仿真屏）。
 * 验证方式 = 机器人级加群验证配置（bots.config.joinVerify → resolveJoinVerify），
 * 会话锁定方式库 id 与最大尝试次数（与真实路径同一解析管道，保证行为一致）。
 * captcha 方式交互无法在仿真屏复现（真实验证网页），诚实返回错误，绝不假仿真。
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
  let botId: bigint;
  try {
    botId = BigInt(payload.bot_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "请先选择机器人" }, { status: 400 });
  }

  const { getGroupSettings } = await import("@/database/operations");
  const settings = await getGroupSettings(chatId);

  if (settings && !settings.enabled) {
    return NextResponse.json({ ok: false, error: "该群组验证已停用" }, { status: 400 });
  }

  // 验证方式 = 机器人级解析（与真实 chat_join_request/chat_member 路径同一管道）
  const resolved = await resolveJoinVerify(botId, settings);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, error: "该机器人未开启「加群验证」或未选择验证方式：请在机器人管理的「功能配置」弹窗中开启并选择" },
      { status: 400 },
    );
  }

  if (resolved.method === "captcha") {
    return NextResponse.json(
      { ok: false, error: "仿真屏暂不支持「人机验证（WebApp）」交互仿真：该方式依赖真实验证网页，请在真实 Telegram 中验证" },
      { status: 400 },
    );
  }

  // 弹窗携带 api_config：更新机器人绑定的方式库配置（仅 code_api 方式且已绑定）
  if (payload.api_config && resolved.method === "code_api" && resolved.methodDbId !== null) {
    const newConfig = buildMethodConfig(payload.api_config);
    if (!newConfig) {
      return NextResponse.json(
        { ok: false, error: "验证 API 配置不合法：需 http/https 地址且 Bearer API Key 非空" },
        { status: 400 },
      );
    }
    const updated = await updateVerificationMethod(resolved.methodDbId, {
      type: "code_api",
      config: JSON.stringify(newConfig),
      enabled: true,
    });
    if (!updated) {
      return NextResponse.json({ ok: false, error: "保存验证 API 配置失败" }, { status: 500 });
    }
  }

  const method =
    resolved.methodDbId !== null ? await getVerificationMethod(resolved.methodDbId) : null;

  const token = generateVerificationToken();
  const useSelfCode = resolved.method === "code_self";
  const joinCode = useSelfCode ? generateJoinCode() : null;
  const expiresAt = new Date(Date.now() + resolved.timeoutSeconds * 1000);

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
    method: resolved.method,
    expectedCode: joinCode,
    methodId: resolved.methodDbId,
    maxAttempts: resolved.maxAttempts,
  });
  if (!session) {
    return NextResponse.json({ ok: false, error: "创建验证会话失败" }, { status: 500 });
  }

  console.log(`Simulator join request created: user ${SIMULATED_USER_ID} -> chat ${chatId} (bot #${botId}, method=${resolved.method})`);

  // 隐私红线：仿真动作一律只停留在仿真屏，绝不真实发送到群组 —— 不调用 Telegram API。
  const minutes = Math.max(1, Math.round(resolved.timeoutSeconds / 60));
  const promptText =
    resolved.method === "code_self"
      ? `${settings?.promptText ?? "🔐 请回复本消息并输入验证码完成验证"}\n\n` +
        `您的入群验证码：${joinCode}\n\n` +
        `⏱ 验证码 ${minutes} 分钟内有效，请回复本消息并输入上述验证码完成验证，验证通过后将自动批准入群。请勿把验证码泄露给他人。`
      : `👋 欢迎 @preview_user 加入「${settings?.chatTitle ?? "群组"}」！\n\n` +
        `请在 ${minutes} 分钟内完成验证（外部验证码核验），验证通过后将自动批准入群。\n\n` +
        "🔒 验证过程在验证页面完成，群里其他成员不可见。";

  return NextResponse.json({
    ok: true,
    data: {
      token,
      chat_id: String(chatId),
      chat_title: settings?.chatTitle,
      username: "preview_user",
      user_id: String(SIMULATED_USER_ID),
      prompt_text: promptText,
      success_text: settings?.successText,
      failure_text: settings?.failureText,
      timeout_seconds: resolved.timeoutSeconds,
      max_attempts: resolved.maxAttempts,
      expires_at: expiresAt.toISOString(),
      method_id: resolved.methodDbId !== null ? String(resolved.methodDbId) : "",
      method_name: method?.name ?? (useSelfCode ? "自动验证码（输入验证码加群）" : "外部API核验"),
      expected_code: joinCode,
      verification_channel: settings?.verificationChannel ?? "auto",
    },
  });
}
