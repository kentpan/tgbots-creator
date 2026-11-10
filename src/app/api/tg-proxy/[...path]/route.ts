import { NextResponse } from "next/server";
import { getAppSetting, setAppSetting } from "@/database/operations";
import { telegramUpstreamRoot, telegramProxyFetch } from "@/lib/telegram/transport";

// 代理转发路由：必须每次动态执行，绝不静态优化/缓存（否则首个规范化 308 会被缓存复放）
export const dynamic = "force-dynamic";

/**
 * v2.0.15 线上 Edge 站 Telegram API 代理（本项目自身作为代理站）：
 *
 * 「机器人测试页 → 代理偏好设置」添加「线上 Edge 站代理」后，本地 node 开发环境
 * 发往 api.telegram.org 的全部请求（getUpdates / sendMessage / deploy 校验 / …）
 * 都会被传输层改写为 <edge 站>/api/tg-proxy/https://api.telegram.org/bot…/<method>，
 * 由本路由在线上转发到真正的 Telegram 上游 —— node 沙盒无需直连 Telegram，
 * 与线上部署共享同一条出口链路。
 *
 * 形态：URL 前缀式代理（与 kent 网关同构）：
 *   /api/tg-proxy/https://api.telegram.org/bot<token>/<method>?query
 * - 路径段里会出现 "https:" + "" + "api.telegram.org"（Next 可能折叠双斜杠），
 *   重建时把开头 `https:/` 归一化回 `https://`；也兼容 ?upstream=<url> 直传。
 *
 * 鉴权：Basic（Authorization 头，由代理地址中的 userinfo 自动注入），
 * 凭据存于本站 app_settings：telegram.edge_proxy_user（默认 tgbots）/
 * telegram.edge_proxy_secret（首次访问自动生成 32hex）。防开放代理被滥用。
 *
 * 上游白名单：仅允许转发到 Telegram 上游（telegramUpstreamRoot）的
 * /bot<token>/<method> 或 /file/bot<token>/... 路径，其余一律 403。
 *
 * 运行时：edge（CF Pages）与 node 通用 —— 只用 fetch/URL/Headers/atob/crypto.getRandomValues；
 * 转发上游用调用时的 globalThis.fetch：
 * - edge（CF Pages）：未装载代理补丁 → 原生直连 Telegram（官方一等运行时）；
 * - node（本地沙盒）：全局补丁已装载 → 转发请求被改写走系统配置的 Telegram 代理链路
 *   （与本项目其它出站请求同链路，沙盒直连被墙时依然可达）。
 *   回环风险：仅当 node 把代理地址指向自身 /api/tg-proxy 才会成环（无意义配置，不考虑）。
 */

/** 上游白名单：是否 Bot API 路径（/bot<token>/<method> 或 /file/bot<token>/...） */
function isBotApiPath(pathname: string): boolean {
  return /^\/(file\/)?bot[^/]+\/[A-Za-z0-9_]+/.test(pathname);
}

/** 从 catch-all 路径段重建上游 URL：`https:/x` → `https://x`（双斜杠被折叠的形态） */
function rebuildUpstreamUrl(segments: string[]): string | null {
  const raw = segments.map((segment) => decodeURIComponent(segment)).join("/");
  if (!raw) return null;
  const normalized = raw.replace(/^(https?):\/+/i, "$1://");
  try {
     
    new URL(normalized);
  } catch {
    return null;
  }
  return normalized;
}

/** Basic 鉴权凭据（edge/node 通用：crypto.getRandomValues 生成密钥，缺省自动落库） */
async function ensureProxyCredentials(): Promise<{ user: string; secret: string }> {
  const [storedUser, storedSecret] = await Promise.all([
    getAppSetting("telegram.edge_proxy_user"),
    getAppSetting("telegram.edge_proxy_secret"),
  ]);
  const user = storedUser?.trim() || "tgbots";
  let secret = storedSecret?.trim() ?? "";
  if (!secret) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    secret = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    try {
      await setAppSetting("telegram.edge_proxy_secret", secret);
      if (!storedUser?.trim()) await setAppSetting("telegram.edge_proxy_user", user);
    } catch {
      // 只读库（极端场景）：本次请求仍按生成值放行，下次请求重试落库
    }
  }
  return { user, secret };
}

function verifyBasicAuth(request: Request, expected: { user: string; secret: string }): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  let decoded: string;
  try {
    decoded = atob(match[1].trim());
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return decoded.slice(0, separator) === expected.user && decoded.slice(separator + 1) === expected.secret;
}

/** 应转发给上游的头（白名单：content-type / accept；剥离 hop-by-hop 与鉴权头） */
function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  return headers;
}

async function handle(request: Request, segments: string[]): Promise<Response> {
  // ① 鉴权：Basic 凭据（代理地址 userinfo 注入）
  const credentials = await ensureProxyCredentials();
  if (!verifyBasicAuth(request, credentials)) {
    return NextResponse.json(
      { ok: false, error: "代理鉴权失败：请在管理后台「代理偏好设置」重新添加线上 Edge 站代理" },
      { status: 401, headers: { "WWW-Authenticate": 'Basic realm="tg-proxy"' } },
    );
  }

  // ② 解析上游 URL：catch-all 路径重建优先；?upstream= 查询参数形态兼容（不回拼到上游）
  const requestUrl = new URL(request.url);
  const upstreamParam = requestUrl.searchParams.get("upstream");
  const upstreamHref =
    upstreamParam && /^https?:\/\//i.test(upstreamParam)
      ? upstreamParam
      : rebuildUpstreamUrl(segments ?? []);
  if (!upstreamHref) {
    return NextResponse.json(
      { ok: false, error: "代理路径不合法：应为 /api/tg-proxy/https://api.telegram.org/bot…/<method>" },
      { status: 400 },
    );
  }

  // ③ 上游白名单：仅 Telegram Bot API
  let upstream: URL;
  try {
    upstream = new URL(upstreamHref);
  } catch {
    return NextResponse.json({ ok: false, error: "上游地址不合法" }, { status: 400 });
  }
  const allowedOrigin = new URL(telegramUpstreamRoot()).origin;
  if (upstream.origin !== allowedOrigin || !isBotApiPath(upstream.pathname)) {
    return NextResponse.json(
      { ok: false, error: `仅允许转发 ${allowedOrigin} 的 Bot API 请求` },
      { status: 403 },
    );
  }

  // ④ 转发（method/body 透传；上游无需 Authorization —— token 在路径中）
  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders(request),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  try {
    // 显式用传输层代理 fetch（勿用 globalThis.fetch —— Next dev 路由上下文拿到的不是
    // instrumentation 装载的补丁版，沙盒/内网环境直连被墙时会全部失败）：
    // - node：改写走系统配置的 Telegram 代理链路（与本项目其它出站同链路，含重试+直连回退）；
    // - edge：原生直连优先，系统代理作回退（v2.0.4 边缘出站加固链路）
    const upstreamFetch = telegramProxyFetch();
    const upstreamResponse = await upstreamFetch(upstream.toString(), init);
    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    responseHeaders.set("cache-control", "no-store");
    // 3xx 透传 Location（上游链路偶发路径规范化重定向时不至于变成盲重定向）
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const location = upstreamResponse.headers.get("location");
      if (location) responseHeaders.set("location", location);
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("[tg-proxy] upstream failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        ok: false,
        error: `代理转发失败：${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }
}

type RouteContext = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return handle(request, path ?? []);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return handle(request, path ?? []);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return handle(request, path ?? []);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return handle(request, path ?? []);
}
