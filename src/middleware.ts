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
 * 2. CSRF 防线：SameSite=None 扩大了 cookie 发送面，因此带 Origin 的跨站写请求
 *    （POST/PUT/PATCH/DELETE）必须同源或来自本地白名单，否则直接 403 拒绝执行
 *    （不仅是隐藏响应——恶意网站诱导受害者浏览器发起的跨站写请求会被真正拦截）。
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

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Client",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") ?? "";
  const allowed = origin !== "" && isLocalOrigin(origin);

  // 预检：白名单 origin 返回完整 CORS 头；其余 204（浏览器按失败处理）
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: allowed ? corsHeaders(origin) : undefined,
    });
  }

  // CSRF 防线：带 Origin 的写请求必须同源（host 一致）或来自本地白名单
  if (WRITE_METHODS.has(request.method) && origin) {
    const host = request.headers.get("host") ?? "";
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin && !allowed) {
      return NextResponse.json(
        { ok: false, error: "跨站写请求被拒绝" },
        { status: 403 },
      );
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
  matcher: "/api/admin/:path*",
};
