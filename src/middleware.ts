import { NextRequest, NextResponse } from "next/server";

/**
 * v2.0.12 管理后台 API 中间件（/api/admin/*）：
 *
 * 1. 跨站实操转发支持（CORS）：本地 node 管理后台的「机器人测试」页面会把
 *    一键部署/加群申请/提交验证码等实操请求直接发往线上站点（api.base_url），
 *    浏览器跨站 fetch 携带线上登录 cookie（SameSite=None）需要本中间件配合：
 *    - 仅对本地来源白名单（localhost / 127.0.0.1 / [::1]，任意端口）回 CORS 头；
 *    - 预检 OPTIONS 请求放行并返回允许的方法/请求头。
 *
 *    v2.0.16 修复「打开群组信息面板报 Failed to fetch」：
 *    - 预检 Allow-Methods 此前只有 GET/POST/OPTIONS，漏了 PUT/PATCH/DELETE ——
 *      群组设置/机器人权限/代理偏好保存（PUT）的预检永远失败（即使本地白名单来源）；
 *    - 预检允许头改为回显 Access-Control-Request-Headers（此前固定白名单，
 *      前端新增头就会预检失败）；
 *    - 实操转发通道（请求头 X-Admin-Client: web，opsFetch 专用）也回 CORS 头：
 *      预览面板/沙盒环境访问本地管理后台时 Origin 不是 localhost，此前预检
 *      无 CORS 头 → 浏览器直接抛 "Failed to fetch"（群组信息面板/权限面板全挂）。
 *      安全边界：经典 CSRF 表单无法携带自定义头；携带本头的跨站写请求仍受
 *      管理后台登录态保护，且全部记入操作日志。
 *
 * 2. CSRF 防线：SameSite=None 扩大了 cookie 发送面，因此带 Origin 的跨站写请求
 *    （POST/PUT/PATCH/DELETE）必须同源或来自本地白名单，否则直接 403 拒绝执行
 *    （不仅是隐藏响应——恶意网站诱导受害者浏览器发起的跨站写请求会被真正拦截）。
 *
 *    v2.0.15 同源判定加固（修复「同步真实群组」等按钮误报跨站写请求被拒绝）：
 *    管理后台常被反代/预览面板多层转发，外层代理可能改写 Host（Origin 与后端
 *    收到的 Host 不一致），导致原本同源的请求被误判为跨站。补两条同源通道：
 *    - Sec-Fetch-Site（现代浏览器自动附加、JS 不可伪造）：same-origin /
 *      same-site / none 直接视为同源——浏览器按真实来源计算，天然免疫代理改写；
 *    - x-forwarded-host 回退：Origin host 与反向代理透传的原始 Host 一致即同源。
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" || url.protocol === "https:"
    ) && (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string, requestedHeaders?: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    // v2.0.16：补齐 PUT/PATCH/DELETE（群组设置/机器人权限/代理偏好保存都是 PUT）
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    // v2.0.16：回显预检请求头（此前固定白名单，前端新增头会导致预检失败）
    "Access-Control-Allow-Headers": requestedHeaders?.trim() || "Content-Type, X-Admin-Client, X-Local-Fallback",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** 浏览器自动附加的请求上下文头（JS fetch 不可伪造）：同站/同源/用户直接导航均视为可信 */
function isTrustedFetchSite(request: NextRequest): boolean {
  const site = (request.headers.get("sec-fetch-site") ?? "").toLowerCase();
  return site === "same-origin" || site === "same-site" || site === "none";
}

/** Origin host 是否与反代透传的原始 Host（x-forwarded-host，可含端口）一致 */
function matchesForwardedHost(origin: string, request: NextRequest): boolean {
  const forwarded = (request.headers.get("x-forwarded-host") ?? "").split(",")[0].trim();
  if (!forwarded) return false;
  try {
    return new URL(origin).host === forwarded;
  } catch {
    return false;
  }
}

/**
 * v2.1.0 PROXY_MODE 代理透传鉴权：
 * node 服务器（完整部署，数据库/服务端所在）配置环境变量 PROXY_MODE=apikey@<target>
 * 后，edge 站唯一的 /api/[...path] 代理文件会把全部 API 请求透传到本服务器，
 * 并覆盖 authorization 头为 `Bearer <apikey>` —— 本函数校验该凭据：
 * - 请求带 authorization 头 → 必须等于 `Bearer <apikey>`，否则 401（防伪造转发）；
 * - 不带 authorization → 照常放行（管理后台登录态 cookie / webhook secret 等
 *   业务鉴权不受影响，本地直连管理后台保持可用）。
 * edge 站自身也注入同一 PROXY_MODE（Pages env_vars），其收到的带 authorization
 * 请求同样被校验后再经代理文件转发，两端凭据一致。
 */
function verifyProxyBearer(request: NextRequest): NextResponse | null {
  const raw = (process.env.PROXY_MODE ?? "").trim();
  if (!raw || raw.toLowerCase() === "false" || raw === "0") return null; // 未启用透传鉴权
  const apiKey = raw.slice(0, Math.max(0, raw.indexOf("@")));
  if (!apiKey) return null;
  const auth = (request.headers.get("authorization") ?? "").trim();
  if (!auth) return null; // 不带凭据的请求走业务鉴权（登录态/webhook secret）
  if (auth !== `Bearer ${apiKey}`) {
    return NextResponse.json(
      { ok: false, error: "代理透传鉴权失败：authorization 凭据不匹配" },
      { status: 401 },
    );
  }
  return null;
}

export function middleware(request: NextRequest) {
  // v2.1.0 PROXY_MODE 透传 Bearer 鉴权（带 authorization 头的请求才校验）
  const proxyDenied = verifyProxyBearer(request);
  if (proxyDenied) return proxyDenied;

  const origin = request.headers.get("origin") ?? "";
  // v2.0.16 实操转发通道（opsFetch 专用头）：携带本头的跨站请求也回 CORS 头，
  // 预览面板/沙盒等非 localhost 来源访问本地管理后台不再 "Failed to fetch"。
  const opsChannel = request.headers.get("x-admin-client") === "web";
  const allowed = origin !== "" && (isLocalOrigin(origin) || opsChannel);

  // 预检：白名单 origin 返回完整 CORS 头；其余 204（浏览器按失败处理）
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: allowed ? corsHeaders(origin, request.headers.get("access-control-request-headers")) : undefined,
    });
  }

  // CSRF 防线（v2.1.0 起仅作用于 /api/admin/*，与 matcher 扩展前口径一致）：
  // 带 Origin 的写请求必须同源（host 一致）或来自本地白名单。
  // v2.0.15：同源判定补 Sec-Fetch-Site 与 x-forwarded-host 两条通道，
  // 反代/预览面板改写 Host 不再误杀同源写请求；真正的跨站写请求
  // （Sec-Fetch-Site: cross-site 且 Origin 不在白名单）依旧 403。
  // 非管理路径（webhook/外部验证接口等）的调用方是无浏览器上下文的
  // 服务器端程序（无 Origin），保持放行，不扩大拦截面。
  if (WRITE_METHODS.has(request.method) && origin && request.nextUrl.pathname.startsWith("/api/admin")) {
    if (!allowed && !isTrustedFetchSite(request) && !matchesForwardedHost(origin, request)) {
      const host = request.headers.get("host") ?? "";
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        return NextResponse.json(
          { ok: false, error: "跨站写请求被拒绝" },
          { status: 403 },
        );
      }
    }
  }

  const response = NextResponse.next();
  if (allowed) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      response.headers.set(key, value);
    }
  }
  return response;
}

export const config = {
  // v2.1.0：从 /api/admin/* 扩展到全部 /api/* —— PROXY_MODE 透传鉴权需要覆盖
  // webhook / 外部验证接口等全部后端入口（仅对带 authorization 头的请求生效，
  // 不带凭据的请求行为与此前完全一致）
  matcher: "/api/:path*",
};
