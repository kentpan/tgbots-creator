import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  getGroupSettings,
  getVerificationMethod,
  listVerificationMethods,
  upsertGroupSettings,
} from "@/database/operations";

/**
 * 仿真屏群组设置页（iOS 群组信息界面）的群组验证配置读写。
 *
 * 源头复用：读取走 getGroupSettings，保存走 upsertGroupSettings ——
 * 与「群组管理」页面（/admin/groups saveGroupAction）完全同一数据管道，
 * 校验规则一致（method 合法性、code_api 必须绑定 method），保证两处配置互不漂移。
 */

const VALID_METHODS = new Set(["captcha", "code_api", "code_self"]);

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
  const methods = await listVerificationMethods();

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
          }
        : null,
      methods: methods.map((method) => ({
        id: String(method.id),
        name: method.name,
        type: method.type,
        enabled: method.enabled,
      })),
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

  const method = String(payload.method ?? "code_self");
  if (!VALID_METHODS.has(method)) {
    return NextResponse.json(
      { ok: false, error: "验证方式不合法（code_self / captcha / code_api）" },
      { status: 400 },
    );
  }
  // 与群组管理 saveGroupAction 一致：自定义验证码必须绑定具体验证方法
  const methodIdRaw = payload.method_id === null || payload.method_id === undefined ? "" : String(payload.method_id).trim();
  if (method === "code_api" && (!methodIdRaw || !/^\d+$/.test(methodIdRaw))) {
    return NextResponse.json(
      { ok: false, error: "选择自定义验证码方式时必须绑定具体验证方法" },
      { status: 400 },
    );
  }
  const methodId = methodIdRaw ? BigInt(methodIdRaw) : null;
  if (methodId !== null) {
    const methodRow = await getVerificationMethod(methodId);
    if (!methodRow) {
      return NextResponse.json({ ok: false, error: "绑定的验证方法不存在" }, { status: 400 });
    }
  }

  const existing = await getGroupSettings(chatId);
  const timeoutSeconds = Number(payload.timeout_seconds ?? existing?.timeoutSeconds ?? 300);
  const maxAttempts = Number(payload.max_attempts ?? existing?.maxAttempts ?? 3);

  await upsertGroupSettings(chatId, {
    // 群名与群组管理页同源可编辑：未传时保留现值，避免被清空
    chatTitle:
      payload.chat_title === undefined
        ? (existing?.chatTitle ?? null)
        : String(payload.chat_title ?? "").trim() || null,
    method,
    // v2.0.1 与群组管理 saveGroupAction 一致：选中即落库保留（重开弹窗回显偏好），
    // 仅 code_api 会话消费绑定方法（chat-member / verification-flow 有守卫），
    // 其他方式下仅作偏好记录，绝不影响验证行为
    methodId,
    timeoutSeconds:
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.trunc(timeoutSeconds) : 300,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.trunc(maxAttempts) : 3,
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
    enabled: payload.enabled ?? existing?.enabled ?? true,
    privacyMode: payload.privacy_mode ?? existing?.privacyMode ?? true,
    verificationChannel:
      payload.verification_channel === "dm"
        ? "dm"
        : payload.verification_channel === "group"
          ? "group"
          : payload.verification_channel === "auto"
            ? "auto"
            : existing?.verificationChannel,
    // v2.0.7 直连入群踢出开关：未传时保留现值（undefined 语义 = 不改动）
    kickDirectJoins: payload.kick_direct_joins ?? existing?.kickDirectJoins,
    // v2.1.5 群内回复输码开关：未传时保留现值（undefined 语义 = 不改动）
    replyCodeInGroup: payload.reply_code_in_group ?? existing?.replyCodeInGroup,
  });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "仿真屏保存群组验证配置",
    target: chatIdRaw,
    detail: `验证方式：${
      method === "code_api"
        ? `自定义验证码（方法 #${methodIdRaw}）`
        : method === "code_self"
          ? "自动验证码（输入验证码加群）"
          : "人机验证码"
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
        }
      : null,
  });
}
