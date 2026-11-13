/**
 * GET /api/admin/tgapi/proxy — 读取 TGAPI代理配置
 * POST /api/admin/tgapi/proxy — 保存 TGAPI代理配置
 *
 * TGAPI代理: 将 my.telegram.org 申请四步调用经 tgapi-proxy-toolkit 代理转发,
 * 鉴权用 Bearer APIKEY 或 Basic user:pass(与代理端 APIKEYS / CF_PROXY_USERS 共用)。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { setAppSetting } from "@/database/operations";
import { getTgapiProxyConfig } from "@/services/tgapi-proxy";

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const config = await getTgapiProxyConfig();
  return NextResponse.json({ ok: true, data: { config } });
}

interface ProxySavePayload {
  enabled?: boolean;
  proxyUrl?: string;
  authType?: "bearer" | "basic";
  bearerKey?: string;
  basicUser?: string;
  basicPass?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  let body: ProxySavePayload = {};
  try {
    body = (await req.json()) as ProxySavePayload;
  } catch (e) {
    return NextResponse.json({ ok: false, error: "请求体不是有效 JSON: " + (e instanceof Error ? e.message : String(e)) }, { status: 400 });
  }
  const enabled = body.enabled ? "1" : "0";
  const proxyUrl = String(body.proxyUrl ?? "").trim().replace(/\/+$/, "");
  const authType = body.authType === "basic" ? "basic" : "bearer";
  await setAppSetting("tgapi_proxy_enabled", enabled);
  await setAppSetting("tgapi_proxy_url", proxyUrl);
  await setAppSetting("tgapi_proxy_auth_type", authType);
  await setAppSetting("tgapi_proxy_bearer_key", String(body.bearerKey ?? ""));
  await setAppSetting("tgapi_proxy_basic_user", String(body.basicUser ?? ""));
  await setAppSetting("tgapi_proxy_basic_pass", String(body.basicPass ?? ""));
  const config = await getTgapiProxyConfig();
  return NextResponse.json({ ok: true, data: { config }, message: "TGAPI代理配置已保存" });
}
