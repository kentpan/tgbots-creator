import { NextResponse } from "next/server";

/**
 * v2.1.0 PROXY_MODE 代理透传模式 —— edge 站唯一的后端 API 文件。
 *
 * 部署形态（用户拍板架构）：服务端和数据库全放在 node 服务器上，
 * edge（Cloudflare Pages/Workers）上只有前端 + 本 proxy 代理文件。
 *
 * GitHub Actions 仓库变量/secret `PROXY_MODE` 控制该模式：
 * - `false` / 未配置 → 完整部署（D1/KV/R2 + 全部 API 路由），本文件仅兜底
 *   未匹配的 /api/* 路径返回 404（与 Next.js 默认行为一致，无副作用）；
 * - `apikey@http://47.76.132.145:4000` → 代理透传模式：
 *   ① 构建期（pages-deploy.yml）剥离 src/app/api 下其余全部路由，仅保留本文件；
 *   ② 本站收到的所有 /api/* 请求全部透传转发到代理目标 URL
 *      （`<target><原始路径><查询串>`），携带 `authorization: Bearer <apikey>` 鉴权头；
 *   ③ node 服务器端 middleware 校验该 Bearer 凭据（PROXY_MODE 同源解析），
 *      cookie/登录态、webhook secret 等业务鉴权在 node 端照常执行。
 *
 * 转发语义：
 * - 方法全透传（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）；
 * - 请求头透传（cookie / content-type / x-forwarded-* 保留，host/content-length/
 *   hop-by-hop 剥离），authorization 一律覆盖为 Bearer apikey；
 * - 请求体缓冲透传（管理 API / webhook 均为小体积 JSON）；
 * - 响应 status/headers/body 全透传，set-cookie 逐条透传（getSetCookie，
 *   避免多 cookie 被逗号合并破坏）—— 登录 cookie 无 Domain 属性（host-only），
 *   浏览器存的是 edge 站域名，后续请求经本文件透传 cookie 到 node 端校验；
 * - redirect: manual —— 3xx 原样透传，绝不在 edge 侧跟随（避免把浏览器
 *   带到内网 node 地址上）。
 *
 * 路径映射：浏览器请求 edge 的 /api/xxx → 转发 `<target>/api/xxx`（node 服务器
 * 部署的是同一项目，API 路径结构相同）。
 */

export const dynamic = "force-dynamic";

interface ProxyTarget {
  apiKey: string;
  target: string;
}

/** 解析 PROXY_MODE：`apikey@http://host:port` → { apiKey, target }；false/空/非法 → null */
function parseProxyMode(raw: string | undefined | null): ProxyTarget | null {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "false" || value === "0") return null;
  // apikey 不应包含 @：以第一个 @ 分割（target 以 http:// 开头，普通部署无 userinfo）
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const apiKey = value.slice(0, at);
  const target = value.slice(at + 1).replace(/\/+$/, "");
  if (!apiKey || !/^https?:\/\//i.test(target)) return null;
  return { apiKey, target };
}

/** hop-by-hop / 由 fetch 重新计算的头：两侧均剥离 */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

async function forward(request: Request): Promise<Response> {
  const proxy = parseProxyMode(process.env.PROXY_MODE);
  if (!proxy) {
    // 非透传模式：完整部署中业务路由存在时本文件不会被命中；剥离部署中
    // PROXY_MODE 缺失（未注入 env）时按 404 语义响应，绝不误转发
    return NextResponse.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const targetUrl = `${proxy.target}${requestUrl.pathname}${requestUrl.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("authorization", `Bearer ${proxy.apiKey}`);

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  try {
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(lower) || lower === "set-cookie") continue;
      responseHeaders.set(key, value);
    }
    // set-cookie 多值逐条透传（Headers.entries 会把多个值合并逗号 → cookie 破坏）
    const setCookies =
      typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      responseHeaders.append("set-cookie", cookie);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        error: `代理透传失败：无法连接后端服务（${proxy.target}）—— ${message}`,
      },
      { status: 502 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return forward(request);
}
export async function POST(request: Request): Promise<Response> {
  return forward(request);
}
export async function PUT(request: Request): Promise<Response> {
  return forward(request);
}
export async function PATCH(request: Request): Promise<Response> {
  return forward(request);
}
export async function DELETE(request: Request): Promise<Response> {
  return forward(request);
}
export async function HEAD(request: Request): Promise<Response> {
  return forward(request);
}
export async function OPTIONS(request: Request): Promise<Response> {
  return forward(request);
}
