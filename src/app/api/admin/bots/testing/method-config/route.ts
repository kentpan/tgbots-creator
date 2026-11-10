import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getGroupSettings,
  getVerificationMethod,
  getVerificationMethodByName,
  createVerificationMethod,
  updateVerificationMethod,
  upsertGroupSettings,
} from "@/database/operations";
import { parseCodeApiConfig, verifyCodeExternally, type CodeApiConfig } from "@/services/external-verify";

/**
 * 仿真屏群设置「外部验证 API」配置读写（v2.1.2）：
 *
 * 用户在仿真屏群组设置（验证渠道面板）选择「外部API」验证方式后，可直接在此
 * 配置完整的验证 API（URL + Bearer apikey + 传参 + 响应解析 + 超时），
 * 与「验证方式」页（/admin/verification-methods）同一数据源（verification_methods.config）：
 * - 群组已绑定 method → 更新该 method 的 config；
 * - 未绑定 → 自动创建（复用既有「加群验证码核验（外部API）」，与模拟加群申请弹窗一致）
 *   并绑定到群组。
 *
 * POST = 联调测试：用群绑定配置真实调用一次外部 API（与「验证方式」页的测试动作同语义）。
 */

/** 仿真屏自动创建/复用的验证方式固定名称（verification_methods.name 全局唯一，与 join-request 一致） */
const SIMULATOR_METHOD_NAME = "加群验证码核验（外部API）";

/** 表单提交的验证 API 配置（与 CodeApiConfig 对应） */
interface MethodApiConfigInput {
  url?: string;
  api_key?: string;
  http_method?: string;
  code_field?: string;
  body_template?: string;
  success_status?: number;
  success_field?: string;
  success_value?: string;
  timeout_seconds?: number;
}

function isValidHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** 由表单配置构建持久化到 verification_methods.config 的 JSON（校验失败返回 null + 原因） */
function buildMethodConfig(input: MethodApiConfigInput): { config: CodeApiConfig | null; error: string | null } {
  const url = String(input.url ?? "").trim();
  const apiKey = String(input.api_key ?? "").trim();
  const codeField = (String(input.code_field ?? "").trim() || "code").replace(/"/g, "");
  if (!isValidHttpUrl(url)) return { config: null, error: "验证 API 地址不合法（需 http/https 开头）" };
  if (!apiKey) return { config: null, error: "请填写 Bearer API Key" };
  const httpMethod = String(input.http_method ?? "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const successStatus = Number(input.success_status);
  const timeoutSeconds = Number(input.timeout_seconds);
  const bodyTemplate = typeof input.body_template === "string" ? input.body_template.trim() : "";
  return {
    config: {
      url,
      api_key: apiKey,
      http_method: httpMethod,
      code_field: codeField,
      // POST 且未提供模板时按卡密字段名生成默认请求体 { "<字段名>": "{{code}}" }
      ...(httpMethod === "POST" && bodyTemplate
        ? { body_template: bodyTemplate }
        : httpMethod === "POST"
          ? { body_template: JSON.stringify({ [codeField]: "{{code}}" }) }
          : {}),
      success_status: Number.isFinite(successStatus) && successStatus > 0 ? Math.trunc(successStatus) : 200,
      success_field: String(input.success_field ?? "").trim() || "success",
      success_value: String(input.success_value ?? "").trim() || "true",
      timeout_seconds:
        Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? Math.min(Math.max(Math.trunc(timeoutSeconds), 5), 60)
          : 10,
    },
    error: null,
  };
}

async function resolveChatId(request: Request): Promise<bigint | null> {
  const chatIdRaw = new URL(request.url).searchParams.get("chat_id") ?? "";
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw.trim())) return null;
  try {
    return BigInt(chatIdRaw.trim());
  } catch {
    return null;
  }
}

/** 读取群绑定 method（type=code_api），未绑定时返回 null */
async function loadBoundMethod(chatId: bigint) {
  const settings = await getGroupSettings(chatId);
  const method =
    settings?.methodId !== null && settings?.methodId !== undefined
      ? await getVerificationMethod(settings.methodId)
      : null;
  if (method && method.type === "code_api") return method;
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const chatId = await resolveChatId(request);
  if (chatId === null) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const method = await loadBoundMethod(chatId);
  const config = method ? parseCodeApiConfig(method.config) : null;
  return NextResponse.json({
    ok: true,
    data: {
      method_id: method ? String(method.id) : null,
      method_name: method?.name ?? null,
      method_enabled: method?.enabled ?? true,
      config,
    },
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "methods:manage")) {
    return NextResponse.json(
      { ok: false, error: "无权限（需要验证方式管理权限 methods:manage）" },
      { status: 403 },
    );
  }

  let payload: { chat_id?: string | number; config?: MethodApiConfigInput; method_name?: string; enabled?: boolean };
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

  const { config, error } = buildMethodConfig(payload.config ?? {});
  if (!config) {
    return NextResponse.json({ ok: false, error: error ?? "配置不合法" }, { status: 400 });
  }
  const configJson = JSON.stringify(config, null, 2);

  // 优先更新群组已绑定的 method；未绑定/绑定失效时复用或创建仿真屏固定 method 并绑定
  let method = await loadBoundMethod(chatId);
  let created = false;
  if (!method) {
    method = await getVerificationMethodByName(SIMULATOR_METHOD_NAME);
    if (!method) {
      method = await createVerificationMethod({
        name: SIMULATOR_METHOD_NAME,
        type: "code_api",
        config: configJson,
        enabled: true,
      });
      created = true;
    }
    if (!method) {
      return NextResponse.json({ ok: false, error: "创建验证方式失败" }, { status: 500 });
    }
  }

  const updated = await updateVerificationMethod(method.id, {
    type: "code_api",
    config: configJson,
    ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
  });
  if (!updated) {
    return NextResponse.json({ ok: false, error: "保存验证方式失败" }, { status: 500 });
  }

  // 绑定到群组（与群组管理 / 仿真屏群设置保存同一数据管道）
  const existing = await getGroupSettings(chatId);
  await upsertGroupSettings(chatId, {
    method: "code_api",
    methodId: method.id,
    ...(existing
      ? {}
      : {
          chatTitle: null,
          timeoutSeconds: 300,
          maxAttempts: 3,
        }),
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: created ? "仿真屏创建外部验证API配置" : "仿真屏更新外部验证API配置",
    target: `chat=${chatIdRaw} method=#${String(method.id)}`,
    detail: `URL=${config.url}`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    data: {
      method_id: String(method.id),
      method_name: method.name ?? SIMULATOR_METHOD_NAME,
      config,
    },
  });
}

/** 联调测试：用群绑定配置真实调用一次外部验证 API */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "methods:manage")) {
    return NextResponse.json(
      { ok: false, error: "无权限（需要验证方式管理权限 methods:manage）" },
      { status: 403 },
    );
  }

  let payload: { chat_id?: string | number; code?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const chatIdRaw = String(payload.chat_id ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw)) {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }
  const code = String(payload.code ?? "").trim();
  if (!code) {
    return NextResponse.json({ ok: false, error: "请输入测试验证码" }, { status: 400 });
  }

  const method = await loadBoundMethod(BigInt(chatIdRaw));
  if (!method) {
    return NextResponse.json(
      { ok: false, error: "该群组尚未绑定外部验证API方式，请先保存配置" },
      { status: 400 },
    );
  }
  const config = parseCodeApiConfig(method.config);
  if (!config) {
    return NextResponse.json({ ok: false, error: "绑定配置不合法，请重新保存" }, { status: 400 });
  }
  const result = await verifyCodeExternally(config, { userId: 0n, username: null, code });
  return NextResponse.json({
    ok: true,
    data: { ok: result.ok, message: result.message, network_error: result.networkError },
  });
}
