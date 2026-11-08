import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { applyProxyPrefix, splitProxyAuth, telegramUpstreamRoot } from "@/lib/telegram/transport";

/**
 * v2.0.15 代理连通性测试（「代理偏好设置」面板 ⓘ 按钮）：
 *
 * 服务端按代理条目地址发起一次真实探测：走 <代理前缀>/bot<ping-token>/getMe，
 * Telegram 对无效 token 返回 401 —— 只要 HTTP 层有响应就代表代理链路连通，
 * 耗时即面板展示的 ping 毫秒数；网络层失败（超时/断网/DNS）才判为连接失败。
 *
 * 探测 URL 的 origin 是代理站（不是 api.telegram.org），不会被本机全局代理补丁
 * 二次改写 —— node 环境下探测走的正是用户配置的代理链路本身，结果真实可信。
 */

const PING_TIMEOUT_MS = 15000;

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { url?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const proxyUrl = (payload.url ?? "").trim();
  if (!proxyUrl || !/^https?:\/\//i.test(proxyUrl)) {
    return NextResponse.json({ ok: false, error: "代理地址不合法（需 http/https 开头）" }, { status: 400 });
  }

  // 与传输层同一拆分规则：URL 内嵌凭据 → Basic 头（undici 禁止 URL 内嵌凭据）
  const parts = splitProxyAuth(proxyUrl);
  if (!parts) {
    return NextResponse.json({ ok: false, error: "代理地址解析失败（含非法字符）" }, { status: 400 });
  }

  const probeUrl = `${applyProxyPrefix(parts.cleanPrefix, telegramUpstreamRoot())}/bot000000000:ping_connectivity_test/getMe`;
  const requestHeaders = new Headers();
  if (parts.authHeader) requestHeaders.set("Authorization", parts.authHeader);

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`探测超时（${PING_TIMEOUT_MS / 1000}s）`)), PING_TIMEOUT_MS);
    const response = await fetch(probeUrl, { headers: requestHeaders, signal: controller.signal });
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    // HTTP 有响应（含 401）= 代理链路连通；顺便回传上游状态码辅助诊断
    return NextResponse.json({ ok: true, data: { ms: elapsed, http_status: response.status } });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const reason = error instanceof Error ? error.message : String(error);
    await logOperation(admin, {
      action: "代理连通性测试失败",
      detail: `${reason}（${elapsed}ms）`,
      headers: await headers(),
    });
    return NextResponse.json({ ok: true, data: { ms: elapsed, error: reason } });
  }
}
