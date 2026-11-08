import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getAppSetting, setAppSetting } from "@/database/operations";

/**
 * v2.0.15 线上 Edge 站代理地址引导（「代理偏好设置」→「添加代理」一键接入）：
 *
 * 本接口必须部署在线上 Edge 站才有意义 —— node 开发环境的前端经 opsFetch 把本
 * 请求转发到线上站点（api.base_url，携带线上登录态），由线上站点：
 * 1. 自动生成本站的代理 Basic 凭据（telegram.edge_proxy_user / edge_proxy_secret，
 *    首次访问生成并落库到本站数据库，与 /api/tg-proxy 路由共享同一份）；
 * 2. 返回拼装好的代理地址：https://<user>:<secret>@<本站host>/api/tg-proxy
 *    —— 面板把它作为「线上 Edge 站代理」条目保存到 node 本地设置后，
 *    本地所有 api.telegram.org 请求即经由本站（Edge 源站）转发。
 *
 * v2.1.0 修复「一键添加的域名不是 api.base_url 配置的 https://tgbots.ccwu.cc」：
 * 本站对外 origin **优先取系统设置 api.base_url**（用户显式配置的线上站点地址），
 * 只有未配置/配置为本地内网地址时才回退请求透传头 —— 彻底杜绝历史部署实例
 * （如 fcapp.run）或多层反代把错误域名拼进代理地址。鉴权沿用管理后台登录态。
 */

/** 判断 host 是否本地/内网地址（此类 api.base_url 不能作为对外代理源站域名） */
function isLocalishHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  // 凭据（与 /api/tg-proxy 路由同一份，缺省自动生成）
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
    await setAppSetting("telegram.edge_proxy_secret", secret);
    if (!storedUser?.trim()) await setAppSetting("telegram.edge_proxy_user", user);
  }

  // 本站对外 origin（v2.1.0）：优先 api.base_url（用户显式配置的线上站点地址）；
  // 未配置/本地地址时回退反代透传头（x-forwarded-host，线上 CF Pages 会设置），
  // 再回退请求自身 URL origin（直连场景）
  let origin = "";
  const remoteBase = (await getAppSetting("api.base_url"))?.trim() ?? "";
  if (/^https?:\/\//i.test(remoteBase)) {
    try {
      const parsedRemote = new URL(remoteBase);
      if (!isLocalishHost(parsedRemote.hostname)) origin = remoteBase.replace(/\/+$/, "");
    } catch {
      /* 非法配置 → 走回退链 */
    }
  }
  if (!origin) {
    const requestHeaders = await headers();
    const forwardedHost = (requestHeaders.get("x-forwarded-host") ?? "").split(",")[0].trim();
    const forwardedProto = (requestHeaders.get("x-forwarded-proto") ?? "").split(",")[0].trim();
    origin = `${forwardedProto || "https"}://${forwardedHost}`;
    try {
      // 回退：请求自身 URL 的 origin（直连场景）
      const parsed = new URL(request.url);
      if (!forwardedHost) origin = parsed.origin;
    } catch {
      /* 保持回退值 */
    }
  }

  const base = origin.replace(/\/+$/, "");
  const parsedBase = new URL(base);
  const proxyUrl = `${parsedBase.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(secret)}@${parsedBase.host}/api/tg-proxy`;

  await logOperation(admin, {
    action: "生成线上 Edge 站代理地址",
    detail: base,
  });

  return NextResponse.json({
    ok: true,
    data: {
      base,
      proxy_url: proxyUrl,
      label: `${new URL(base).host}/api/tg-proxy`,
      has_secret: true,
    },
  });
}
