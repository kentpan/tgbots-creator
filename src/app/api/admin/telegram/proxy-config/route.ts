import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getAppSetting, setAppSetting } from "@/database/operations";
import {
  DEFAULT_TELEGRAM_PROXY_URL,
  invalidateTelegramProxyConfig,
  TELEGRAM_PROXY_SETTING_KEYS,
} from "@/lib/telegram/transport";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";

/**
 * v2.0.15 代理偏好设置（机器人测试页仿真屏「代理偏好设置」面板专用 API）：
 *
 * 「系统设置」中的 Telegram 代理配置（telegram.proxy_enabled / telegram.proxy_url）
 * 迁移到仿真屏的 APP 风格「代理偏好设置」面板，本接口是其唯一读写通道：
 * - GET  → 返回代理开关 / 用于通话 / 代理条目列表 / 当前生效代理地址；
 * - PUT  → 保存开关与条目，立即失效传输层缓存（下一次 Bot API 请求即生效，无需重启）。
 *
 * 代理条目（telegram.proxy_entries，JSON 数组）：面板「添加代理」产生的地址簿，
 * 每项 { id, label, url, type }，type=edge=线上 Edge 站代理 / prefix=URL 前缀代理。
 * telegram.proxy_url 始终等于当前选中条目的 url（传输层读取的键，保持兼容）。
 *
 * 注意：本接口操作的是「当前运行时」的数据库 —— node 开发环境改本地 SQLite
 * （前端同源 fetch），线上 edge 改 D1（面板经 opsFetch 跨站转发时同源执行）。
 */

export interface ProxyEntry {
  id: string;
  label: string;
  url: string;
  /** edge=线上 Edge 站代理；prefix=URL 前缀代理 */
  type: "edge" | "prefix";
  created_at: string;
}

const FOR_CALLS_KEY = "telegram.proxy_for_calls";
const ENTRIES_KEY = "telegram.proxy_entries";
const MAX_ENTRIES = 20;

export function normalizeEntries(raw: string | null): ProxyEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ProxyEntry => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Partial<ProxyEntry>;
        return typeof entry.id === "string" && typeof entry.url === "string" && entry.url.trim().length > 0;
      })
      .map((entry): ProxyEntry => ({
        id: entry.id,
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label : entry.url,
        url: entry.url.trim(),
        type: entry.type === "edge" ? ("edge" as const) : ("prefix" as const),
        created_at: typeof entry.created_at === "string" ? entry.created_at : "",
      }))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** 代理地址展示标签：剥离 userinfo 凭据，仅显示主机+路径 */
export function proxyDisplayLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const [enabledRaw, urlRaw, forCallsRaw, entriesRaw, edgeBaseRaw] = await Promise.all([
    getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.enabled),
    getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.url),
    getAppSetting(FOR_CALLS_KEY),
    getAppSetting(ENTRIES_KEY),
    getAppSetting("api.base_url"),
  ]);

  const activeUrl = urlRaw?.trim() ?? "";
  const enabled = enabledRaw !== "false"; // 未设置时默认开启（与传输层默认一致）
  let entries = normalizeEntries(entriesRaw);
  // 兼容旧数据：从未在面板管理过条目但系统设置里已配置代理地址 → 派生为唯一条目
  if (entries.length === 0 && activeUrl) {
    entries = [
      {
        id: "legacy-active",
        label: proxyDisplayLabel(activeUrl),
        url: activeUrl,
        type: "prefix" as const,
        created_at: "",
      },
    ];
  }

  // v2.0.16：代理已开启但未选中任何条目（active_url 为空）时，传输层回退到内置默认代理。
  // 面板展示与真实行为保持一致：把地址等于内置默认代理的条目标为生效（打上 ✓）。
  const effectiveActiveUrl =
    activeUrl ||
    (enabled ? entries.find((entry) => entry.url === DEFAULT_TELEGRAM_PROXY_URL)?.url ?? DEFAULT_TELEGRAM_PROXY_URL : "");

  return NextResponse.json({
    ok: true,
    data: {
      runtime: isEdgeRuntime() ? "edge" : "node",
      enabled,
      // v2.0.16：用于通话默认关闭（仅作为 APP 样式还原偏好项，未设置时不再默认开启）
      for_calls: forCallsRaw === "true",
      active_url: effectiveActiveUrl,
      entries,
      edge_base_url: edgeBaseRaw?.trim() ?? "",
    },
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: {
    enabled?: boolean;
    for_calls?: boolean;
    active_url?: string | null;
    entries?: ProxyEntry[];
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const updates: string[] = [];

  if (typeof payload.enabled === "boolean") {
    await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.enabled, payload.enabled ? "true" : "false");
    updates.push(TELEGRAM_PROXY_SETTING_KEYS.enabled);
  }
  if (typeof payload.for_calls === "boolean") {
    await setAppSetting(FOR_CALLS_KEY, payload.for_calls ? "true" : "false");
    updates.push(FOR_CALLS_KEY);
  }
  if (Array.isArray(payload.entries)) {
    const entries = payload.entries
      .filter((entry) => entry && typeof entry.url === "string" && entry.url.trim())
      .slice(0, MAX_ENTRIES)
      .map((entry) => ({
        id: typeof entry.id === "string" && entry.id ? entry.id : `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label : proxyDisplayLabel(entry.url),
        url: entry.url.trim(),
        type: entry.type === "edge" ? ("edge" as const) : ("prefix" as const),
        created_at: typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString(),
      }));
    await setAppSetting(ENTRIES_KEY, JSON.stringify(entries));
    updates.push(ENTRIES_KEY);
  }
  // active_url：null/undefined = 不变更；"" = 清空（直连）；非空 = 选中条目地址
  if (payload.active_url !== undefined && payload.active_url !== null) {
    const activeUrl = String(payload.active_url).trim();
    if (activeUrl && !/^https?:\/\//i.test(activeUrl)) {
      return NextResponse.json({ ok: false, error: "代理地址需以 http(s):// 开头" }, { status: 400 });
    }
    await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.url, activeUrl);
    updates.push(TELEGRAM_PROXY_SETTING_KEYS.url);
  }

  // 立即生效：失效传输层 15s 配置缓存
  invalidateTelegramProxyConfig();

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "更新代理偏好设置",
    detail: updates.join(", ") || "无变更",
    headers: requestHeaders,
  });

  return NextResponse.json({ ok: true });
}
