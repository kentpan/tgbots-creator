"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { setAppSetting, getAppSetting, getAllAppSettings } from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import {
  PRIVACY_SETTING_KEY,
  TRANSPORT_SETTING_KEYS,
  normalizeGlobalTransport,
} from "@/lib/telegram/runtime-mode";
import { applyGlobalTransportToAll } from "@/services/bot-transport";

/** 保存全局传输模式（轮询/Webhook/自动）与 Webhook Base URL，并即时应用到全部机器人 */
export async function saveTelegramTransportGlobalAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const mode = normalizeGlobalTransport(String(formData.get("mode") ?? ""));
  const baseUrlRaw = String(formData.get("webhookBaseUrl") ?? "").trim();
  let baseUrl = baseUrlRaw;
  if (mode === "webhook" && !baseUrl) {
    // 留空 → 自动取当前站点地址（管理后台所在域名即部署公网地址）。
    // 反代链路事实（2026-11-04 逐跳实测）：TLS 在最外层入口代理终结后，应用侧经
    // Caddy 转发收到的 x-forwarded-proto 恒为 http（Caddy 用 {scheme} 整头覆盖），
    // 直接按该值拼 URL 必然得到 http:// 而撞上下方 https 校验 —— 「留空自动获取」
    // 因此从未生效过。修正规则（确定性推导，无任何异常兜底）：
    // ① proto 取 x-forwarded-proto 第一个值（链条最外层），缺失默认 https；
    // ② 主机为非本地地址而 proto=http → TLS 必然终结在更外层（沙盒预览 /
    //    Cloudflare / Ingress 等），按公网 https 还原（Telegram Webhook 仅收 https）；
    // ③ 探测结果仍非公网 https（本机/内网地址无法被 Telegram 回调）→ 回退到
    //    上次保存的公网地址（留空语义 = 「自动取可用的当前站点地址」）。
    const requestHeaders = await headers();
    const forwardedHost = requestHeaders.get("x-forwarded-host");
    const host = (forwardedHost ? forwardedHost.split(",")[0] : requestHeaders.get("host") ?? "").trim();
    const forwardedProto = requestHeaders.get("x-forwarded-proto") ?? requestHeaders.get("x-forwarded-scheme") ?? "";
    let proto = (forwardedProto.split(",")[0] ?? "").trim() || "https";
    const hostWithoutPort = host.replace(/:\d+$/, "").toLowerCase();
    const isLocalHost =
      !hostWithoutPort ||
      hostWithoutPort === "localhost" ||
      hostWithoutPort === "::1" ||
      hostWithoutPort === "[::1]" ||
      hostWithoutPort === "0.0.0.0" ||
      /^127\.\d+\.\d+\.\d+$/.test(hostWithoutPort) ||
      /^10\.\d+\.\d+\.\d+$/.test(hostWithoutPort) ||
      /^192\.168\.\d+\.\d+$/.test(hostWithoutPort) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostWithoutPort) ||
      hostWithoutPort.endsWith(".local");
    if (host) {
      if (proto === "http" && !isLocalHost) proto = "https";
      baseUrl = `${proto}://${host}`;
    }
    if (!/^https:\/\/.+/.test(baseUrl)) {
      const storedBaseUrl = ((await getAppSetting(TRANSPORT_SETTING_KEYS.webhookBaseUrl)) ?? "").trim();
      if (/^https:\/\/.+/.test(storedBaseUrl)) baseUrl = storedBaseUrl;
    }
  }
  if (mode === "webhook" && !/^https:\/\/.+/.test(baseUrl)) {
    redirectWithError("webhook-base-url-https");
  }

  await setAppSetting(TRANSPORT_SETTING_KEYS.mode, mode);
  await setAppSetting(TRANSPORT_SETTING_KEYS.webhookBaseUrl, baseUrl);
  await applyGlobalTransportToAll();

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存全局传输模式",
    detail: `模式：${mode}${mode === "webhook" ? `；Base URL：${baseUrl}` : ""}（已应用到全部机器人）`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/bots");
  redirectWithOk("transport");
}

/** 保存全局隐私模式（bot 不收群内普通消息），并热更新全部运行实例 */
export async function savePrivacyGlobalAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const enabled = formData.get("enabled") === "1";
  await setAppSetting(PRIVACY_SETTING_KEY, enabled ? "true" : "false");
  await applyGlobalTransportToAll();

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存全局隐私模式",
    detail: enabled ? "开启（bot 不收群内普通消息，指令严格匹配）" : "关闭（bot 收全部群消息，指令宽松匹配）",
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  revalidatePath("/admin/bots");
  redirectWithOk("privacy");
}

/** 客户端卡片读取当前全局配置（避免整页刷新） */
export async function getTelegramGlobalConfigAction(): Promise<{
  mode: string;
  webhookBaseUrl: string;
  privacyEnabled: boolean;
}> {
  await requirePermission("settings:view");
  const settings = await getAllAppSettings();
  return {
    mode: normalizeGlobalTransport(settings[TRANSPORT_SETTING_KEYS.mode]),
    webhookBaseUrl: settings[TRANSPORT_SETTING_KEYS.webhookBaseUrl] ?? "",
    privacyEnabled:
      settings[PRIVACY_SETTING_KEY] === undefined ? true : settings[PRIVACY_SETTING_KEY] !== "false",
  };
}

function redirectWithOk(kind: string): never {
  redirect(`/admin/settings?tg_saved=${kind}`);
}

function redirectWithError(kind: string): never {
  redirect(`/admin/settings?tg_error=${kind}`);
}
