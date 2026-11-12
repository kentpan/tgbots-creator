import { NextResponse } from "next/server";
import { extractTgWebLoginCode, normalizeApplyPhone } from "@/services/tgapi-flow-text";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  createNewTgApp,
  loginStepGetStelCookie,
  requestTgCodeGetRandomHash,
  scrapeTgExistingApp,
  type TgAppInfo,
  type TgOrgScrapeResult,
} from "@/services/my-telegram-org";
import {
  createTgApiApplySession,
  getTgApiApplySession,
  removeTgApiApplySession,
  updateTgApiApplySession,
} from "@/services/tgapi-apply-session";
import { TGAPI_DEFAULT_APP, deriveTgApiShortName } from "@/services/tgapi-config";
import { isValidTgApiPlatformValue } from "@/services/menu-config";

/**
 * TGAPI申请 管理端「多步骤申请向导」API（v2.1.8）。
 *
 * my.telegram.org 的登录码发送到对应手机号 Telegram 账号的「Telegram 服务通知」
 * 会话（应用内消息，非短信），因此任意手机号均可申请，无需接码平台 ——
 * 管理员在该 Telegram 账号里读到验证码后填入向导即可。
 *
 * 复用 my-telegram-org.ts 四步抓取实现（与 TGAPI 机器人同一链路）：
 * - send_code：POST /auth/send_password → random_hash（服务端落申请会话，返回 sessionId）
 * - verify   ：POST /auth/login → stel_token → GET /apps
 *              ├─ 已有 APP → 直接返回 APP 信息（向导跳结果步骤）
 *              └─ 无 APP   → 会话保存 appHash，前端进入 APP 信息步骤
 * - create   ：POST /apps/create（title/description）→ 重新抓取 → 返回 APP 信息
 *
 * 全部动作要求 tgapi:view 权限（与「TGAPI申请」页面一致）。
 */

/** 向导步骤会话 id 的合法格式（crypto.randomUUID 去连字符后的 hex） */
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;

/** APP 名称/描述的表单约束（与 my.telegram.org 表单一致，同机器人对话流程） */
const APP_TITLE_MAX_LENGTH = 32;
const APP_DESCRIPTION_MAX_LENGTH = 200;

interface ApplyRoutePayload {
  action?: string;
  session_id?: string;
  phone?: string;
  code?: string;
  app_title?: string;
  app_description?: string;
  app_platform?: string;
}

/** 统一的失败响应（错误已记录服务端日志） */
function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** 掩码手机号（日志用：保留前 6 位） */
function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 6)}****` : phone;
}

/** 抓取 /apps 的封装（保持与机器人链路同一调用点，便于全链路追踪） */
async function scrapeApps(stelToken: string): Promise<TgOrgScrapeResult> {
  return scrapeTgExistingApp(stelToken);
}

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return fail("未登录", 401);
  }
  if (!hasPermission(admin, "tgapi:view")) {
    return fail("无权限（需要 TGAPI申请 页面权限 tgapi:view）", 403);
  }

  let payload: ApplyRoutePayload;
  try {
    payload = (await request.json()) as ApplyRoutePayload;
  } catch {
    return fail("请求体不是合法 JSON", 400);
  }
  const action = String(payload.action ?? "").trim();
  const requestHeaders = await headers();

  // ---------------------------------------------------------------------------
  // Step 1：发送验证码（POST /auth/send_password）
  // ---------------------------------------------------------------------------
  if (action === "send_code") {
    const phone = normalizeApplyPhone(payload.phone);
    if (!phone) {
      return fail("手机号不合法：请输入国际格式（如 +8613800138000）", 400);
    }
    try {
      const randomHash = await requestTgCodeGetRandomHash(phone);
      const sessionId = createTgApiApplySession(phone, randomHash);
      await logOperation(admin, {
        action: "TGAPI申请向导发送验证码",
        target: `phone=${maskPhone(phone)}`,
        detail: "my.telegram.org /auth/send_password",
        headers: requestHeaders,
      });
      return NextResponse.json({
        ok: true,
        data: { session_id: sessionId, phone },
      });
    } catch (error) {
      console.error(`TGAPI apply wizard send_code failed: phone=${maskPhone(phone)}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      return fail(`发送验证码失败：${message.slice(0, 300)}`, 502);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2：校验验证码登录（POST /auth/login → GET /apps）
  // ---------------------------------------------------------------------------
  if (action === "verify") {
    const sessionId = String(payload.session_id ?? "").trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return fail("申请会话无效，请从第一步重新开始", 400);
    }
    const session = getTgApiApplySession(sessionId);
    if (!session || session.stelToken) {
      return fail("申请会话已过期或已完成，请从第一步重新开始", 400);
    }
    // 向导输入框可直接粘贴 Telegram 服务通知整条消息（与机器人转发同一提取实现）
    const code = extractTgWebLoginCode(String(payload.code ?? ""));
    if (!code) {
      return fail("无法从输入中识别验证码：请输入 Telegram 收到的登录码数字", 400);
    }
    let login: Awaited<ReturnType<typeof loginStepGetStelCookie>>;
    try {
      login = await loginStepGetStelCookie(session.phone, session.randomHash, code);
    } catch (error) {
      console.error(`TGAPI apply wizard login failed: phone=${maskPhone(session.phone)}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      return fail(`登录请求失败：${message.slice(0, 300)}`, 502);
    }
    if (!login.ok) {
      console.log(
        `TGAPI apply wizard login rejected: admin=${admin.user.username ?? String(admin.user.id)} phone=${maskPhone(session.phone)} reason=${login.error.slice(0, 120)}`,
      );
      return NextResponse.json({
        ok: true,
        data: { login_ok: false, error: login.error },
      });
    }

    let scraped: TgOrgScrapeResult | null = null;
    try {
      scraped = await scrapeApps(login.cookie);
    } catch (error) {
      console.error(`TGAPI apply wizard /apps scrape failed: phone=${maskPhone(session.phone)}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      return fail(`登录成功但抓取 APP 信息失败：${message.slice(0, 300)}`, 502);
    }

    await updateTgApiApplySession(sessionId, {
      stelToken: login.cookie,
      appHash: scraped.ok ? null : scraped.appHash,
    });
    await logOperation(admin, {
      action: "TGAPI申请向导登录成功",
      target: `phone=${maskPhone(session.phone)}`,
      detail: scraped.ok ? "已有 APP" : "尚未创建 APP",
      headers: requestHeaders,
    });
    if (scraped.ok && scraped.info) {
      // 已有 APP：会话使命结束（无需创建）
      removeTgApiApplySession(sessionId);
      return NextResponse.json({
        ok: true,
        data: { login_ok: true, status: "existing", app: scraped.info },
      });
    }
    return NextResponse.json({
      ok: true,
      data: { login_ok: true, status: "no_app" },
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3：创建 APP（POST /apps/create → GET /apps 复核）
  // ---------------------------------------------------------------------------
  if (action === "create") {
    const sessionId = String(payload.session_id ?? "").trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return fail("申请会话无效，请从第一步重新开始", 400);
    }
    const session = getTgApiApplySession(sessionId);
    if (!session || !session.stelToken) {
      return fail("申请会话已过期或未完成登录，请从第一步重新开始", 400);
    }
    const title = String(payload.app_title ?? "").trim();
    const description = String(payload.app_description ?? "").trim();
    if (!title || title.length > APP_TITLE_MAX_LENGTH) {
      return fail(`APP 名称不合法：请输入 1-${APP_TITLE_MAX_LENGTH} 个字符`, 400);
    }
    if (!description || description.length > APP_DESCRIPTION_MAX_LENGTH) {
      return fail(`APP 描述不合法：请输入 1-${APP_DESCRIPTION_MAX_LENGTH} 个字符`, 400);
    }
    const appPlatform = String(payload.app_platform ?? "").trim();
    if (!isValidTgApiPlatformValue(appPlatform)) {
      return fail("APP 平台不合法：请从平台清单中选择", 400);
    }
    // shortname 由 title 派生（my.telegram.org 要求字母开头 5-32 位），不合法回落默认
    const shortName = deriveTgApiShortName(title, TGAPI_DEFAULT_APP.appShortName);

    try {
      // 会话中已有创建表单 hash 可直接创建；否则重新抓取（可能期间已在别处创建过 APP）
      let appHash = session.appHash ?? "";
      if (!appHash) {
        const scraped = await scrapeApps(session.stelToken);
        if (scraped.ok && scraped.info) {
          removeTgApiApplySession(sessionId);
          return NextResponse.json({
            ok: true,
            data: { status: "existing", app: scraped.info },
          });
        }
        appHash = scraped.appHash;
      }
      if (!appHash) {
        return fail("未能获取 my.telegram.org 创建表单 hash，请重新走一遍向导", 502);
      }
      await createNewTgApp({
        stelToken: session.stelToken,
        tgAppHash: appHash,
        appTitle: title,
        appShortName: shortName,
        appUrl: TGAPI_DEFAULT_APP.appUrl,
        appPlatform,
        appDescription: description,
      });
    } catch (error) {
      console.error(`TGAPI apply wizard create failed: phone=${maskPhone(session.phone)}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      return fail(`创建 APP 失败：${message.slice(0, 300)}`, 502);
    }

    // 创建后重新抓取复核（与机器人链路一致：stars have failed us 兜底）
    let info: TgAppInfo | null = null;
    try {
      const scraped = await scrapeApps(session.stelToken);
      info = scraped.ok ? scraped.info : null;
    } catch (error) {
      console.error(`TGAPI apply wizard final scrape failed: phone=${maskPhone(session.phone)}:`, error);
    }
    removeTgApiApplySession(sessionId);
    if (!info) {
      return fail("创建请求已提交，但复核抓取未拿到 APP 信息（可能创建未生效），请稍后重试", 502);
    }
    await logOperation(admin, {
      action: "TGAPI申请向导创建APP成功",
      target: `phone=${maskPhone(session.phone)}`,
      detail: `app_id=${info.appId} title="${title}" shortname=${shortName}`,
      headers: requestHeaders,
    });
    return NextResponse.json({
      ok: true,
      data: { status: "created", app: info },
    });
  }

  return fail(`未知操作：${action || "(空)"}`, 400);
}
