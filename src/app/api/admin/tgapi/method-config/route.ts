import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  createVerificationMethod,
  getVerificationMethod,
  getVerificationMethodByName,
  listVerificationMethods,
  updateVerificationMethod,
} from "@/database/operations";
import { parseCodeApiConfig, verifyCodeExternally, type CodeApiConfig } from "@/services/external-verify";

/**
 * TGAPI申请 解锁门禁「外部验证 API」配置读写（v2.1.7）：
 *
 * 管理后台「TGAPI申请」机器人表单中，验证码解锁模式绑定验证方法后，
 * 可直接在此配置完整的验证 API（URL + Bearer apikey + 传参 + 响应解析 + 超时），
 * 与「验证方式」页（/admin/verification-methods）同一数据源（verification_methods.config）：
 * - 已绑定 method_id → 更新该 method 的 config；
 * - 未绑定 → 按名称复用或自动创建（固定名 TGAPI解锁核验（外部API））并回传 method_id。
 *
 * GET  = 读取验证方式列表 + 指定方法的 config（表单回显）；
 * PUT  = 保存（创建/更新）并回传刷新后的列表；
 * POST = 联调测试：用表单当前配置真实调用一次外部 API（与「验证方式」页测试同语义）。
 */

/** 未指定方法时自动创建/复用的验证方式固定名称（与仿真屏命名风格一致） */
const DEFAULT_METHOD_NAME = "TGAPI解锁核验（外部API）";

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

/** 验证方式下拉列表（全部方法带启用状态，绑定下拉与保存后刷新共用） */
async function listMethodOptions(): Promise<
  { id: number; name: string; enabled: boolean; type: string }[]
> {
  const methods = await listVerificationMethods();
  return methods.map((method) => ({
    id: Number(method.id),
    name: method.name,
    enabled: method.enabled,
    type: method.type,
  }));
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "methods:view") && !hasPermission(admin, "tgapi:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const methodIdRaw = new URL(request.url).searchParams.get("method_id") ?? "";
  let bound: Awaited<ReturnType<typeof getVerificationMethod>> = null;
  if (methodIdRaw && /^\d+$/.test(methodIdRaw)) {
    bound = await getVerificationMethod(BigInt(methodIdRaw));
  }
  return NextResponse.json({
    ok: true,
    data: {
      methods: await listMethodOptions(),
      method_id: bound ? String(bound.id) : null,
      method_name: bound?.name ?? null,
      method_enabled: bound?.enabled ?? true,
      config: bound ? parseCodeApiConfig(bound.config) : null,
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

  let payload: {
    method_id?: string | number;
    method_name?: string;
    config?: MethodApiConfigInput;
    enabled?: boolean;
    /** 调用来源（v2.1.13）：menu = 菜单设计器「外部验证 API」按钮，日志文案区分来源 */
    source?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { config, error } = buildMethodConfig(payload.config ?? {});
  if (!config) {
    return NextResponse.json({ ok: false, error: error ?? "配置不合法" }, { status: 400 });
  }
  const configJson = JSON.stringify(config, null, 2);

  // 优先更新已绑定的 method；未绑定/绑定失效时按名称复用或自动创建固定方法
  const methodIdRaw = String(payload.method_id ?? "").trim();
  let method =
    methodIdRaw && /^\d+$/.test(methodIdRaw) ? await getVerificationMethod(BigInt(methodIdRaw)) : null;
  let created = false;
  const fallbackName = String(payload.method_name ?? "").trim() || DEFAULT_METHOD_NAME;
  if (!method) {
    method = await getVerificationMethodByName(fallbackName);
    if (!method) {
      method = await createVerificationMethod({
        name: fallbackName,
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

  const requestHeaders = await headers();
  // v2.1.13：按调用来源区分日志文案（menu = 菜单设计器「外部验证 API」按钮配置）
  const source = String(payload.source ?? "").trim();
  const sourceLabel = source === "menu" ? "菜单验证" : "TGAPI解锁";
  await logOperation(admin, {
    action: created
      ? `${sourceLabel}创建外部验证API配置`
      : `${sourceLabel}更新外部验证API配置`,
    target: `method=#${String(method.id)} ${method.name}`,
    detail: `URL=${config.url}`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    data: {
      method_id: String(method.id),
      method_name: updated.name,
      method_enabled: updated.enabled,
      config,
      methods: await listMethodOptions(),
    },
  });
}

/** 联调测试：用表单当前配置（未保存时）或已绑定方法配置真实调用一次外部验证 API */
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

  let payload: { method_id?: string | number; config?: MethodApiConfigInput; code?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const code = String(payload.code ?? "").trim();
  if (!code) {
    return NextResponse.json({ ok: false, error: "请输入测试验证码" }, { status: 400 });
  }

  let config: CodeApiConfig | null = null;
  const provided = payload.config && typeof payload.config === "object" ? payload.config : null;
  if (provided && String(provided.url ?? "").trim()) {
    const built = buildMethodConfig(provided);
    if (!built.config) {
      return NextResponse.json({ ok: false, error: built.error ?? "配置不合法" }, { status: 400 });
    }
    config = built.config;
  } else {
    const methodIdRaw = String(payload.method_id ?? "").trim();
    if (!methodIdRaw || !/^\d+$/.test(methodIdRaw)) {
      return NextResponse.json(
        { ok: false, error: "请先填写外部 API 配置或绑定验证方法" },
        { status: 400 },
      );
    }
    const method = await getVerificationMethod(BigInt(methodIdRaw));
    if (!method) {
      return NextResponse.json({ ok: false, error: "绑定的验证方式不存在" }, { status: 400 });
    }
    config = parseCodeApiConfig(method.config);
    if (!config) {
      return NextResponse.json({ ok: false, error: "绑定配置不合法，请重新保存" }, { status: 400 });
    }
  }

  const result = await verifyCodeExternally(config, { userId: 0n, username: null, code });
  return NextResponse.json({
    ok: true,
    data: { verify_ok: result.ok, message: result.message, network_error: result.networkError },
  });
}
