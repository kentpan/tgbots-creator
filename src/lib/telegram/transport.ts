/**
 * Telegram API 统一传输层（server-only）
 *
 * 代理支持（权威依据 grammY 官方文档《代理支持》 https://grammy.dev/zh/advanced/proxy）：
 * - grammY 通过 ApiClientOptions 注入自定义请求执行方式实现代理（官方示例：
 *   Deno 用 Deno.createHttpClient proxy；Node 用 baseFetchConfig.agent + socks/https-proxy-agent）。
 *   标准代理 agent 无法表达「URL 前缀转发」型代理，故本层采用同一扩展点的
 *   client.fetch 注入（ApiClientOptions.fetch，官方文档记载的自定义 fetch 入口）。
 * - 仅 Node 环境启用代理；Cloudflare Pages/Workers（edge/serverless）出站恒直连
 *   （grammY 官方托管文档将 CF Workers 列为一等运行时，无需代理）。
 *   v2.0.2 修复：此前仅 ensureTelegramProxyConfig 跳过 edge 的配置加载，但
 *   proxyState 默认 enabled:true，telegramProxyFetch 无 runtime 判断 —— edge 出站
 *   也会被改写到代理前缀。现在 proxyFetch 入口处非 Node 运行时恒直连透传。
 *
 * apiRoot 恒为上游 Bot API 地址（TELEGRAM_API_ROOT 可覆盖，默认 https://api.telegram.org）。
 * Node 环境访问 api.telegram.org 不通时的代理方案在本层实现（telegramProxyFetch）：
 * - 拦截发往上游 Bot API 的请求，改写为「<代理前缀><上游 origin>/bot<token>/<method>」
 *   并注入 Basic 鉴权头（代理地址中的 userinfo；undici 禁止 URL 内嵌凭据，必须走请求头）
 * - 代理开关/地址存于管理后台系统设置（telegram.proxy_enabled / telegram.proxy_url），
 *   Node 环境默认开启内置代理；15s 内存缓存，保存设置立即失效 —— 无需重启
 * - 代理请求网络层失败（超时/断网）自动用新连接重试一次，仍失败回退直连；
 *   直连连续 2 次失败（网络不可达环境）后熔断 10 分钟，期间不再白等直连超时
 *   （v1.2.0：实测沙箱直连 api.telegram.org 被墙，原实现每次失败路径多等 8s）
 *
 * v2.0.4 edge（Cloudflare Pages/Workers workerd）出站加固：
 * - grammY 的 node 平台层（out/platform.node.js）会给每次 fetch 注入 Node 专属
 *   init（agent: node:https.Agent / compress / duplex），shim.node.js 又以
 *   abort-controller npm polyfill 构造 signal —— 这些对象经 workerd 原生 fetch
 *   转发属于未定义行为（实测本地 wrangler 可容忍，线上边缘 workerd 版本更新、
 *   校验更严，出现过「Network connection lost.」级别的直连失败）。
 *   因此 edge 路径对 init 做**白名单重建**：仅保留 method/headers/body，
 *   signal 一律经 toNativeSignal 桥接为原生 AbortSignal。
 * - edge 回退链：直连 →（失败）→ 系统设置代理（开启且配置了地址时）→（失败）→
 *   直连重试一次（全新连接）。直连仍是 edge 的默认与首选（v2.0.2 语义不变），
 *   代理只在直连网络层失败后作为救命通道出现。
 * - 失败诊断：整条链路的每次尝试（路径/耗时/错误消息）附着到最终抛出的错误
 *   （tgOutbound 字段），describeSyncError 会将其转成人话附在管理端错误信息里，
 *   线上不再只剩一句「网络不可达」。
 *
 * v2.1.0 多代理回退链（Node 出站）：
 * - 代理不再只有「选中条目」一条路：系统设置 telegram.proxy_entries 里的全部条目
 *   组成回退链（选中条目最优先 → 其余条目依次兜底 → 全部失败才直连回退）。
 * - 粘性游标：某条目失败后自动前进到下一候选；新候选成功后后续请求直接从它开始
 *   （用户改选条目时游标归零）。线上 Edge 站代理端点未部署/故障时，本地开发不再
 *   每个请求都失败刷屏，自动落到可用条目（如 kent 网关）。
 * - 失败告警按条目 60s 限流，杜绝轮询场景的日志刷屏；诊断 attempts 增加 via
 *   （命中的代理条目名）。
 *
 * v2.2.5 代理开关门禁 + 统一日志：
 * - .env 的 PROXY_ENABLED=true/false 是全站唯一外层总开关（Node 环境）：
 *   必须 PROXY_ENABLED==="true" 且系统设置中的代理开关同时开启才全局走代理；
 *   edge（Cloudflare Pages/Workers）无 .env 文件，仅认系统设置中的开关。
 * - 代理鉴权头可配置：系统设置 telegram.proxy_header_name（默认 Authorization）
 *   + telegram.proxy_apikey（如 "Bearer abc123"）；未配置 apikey 时沿用代理地址
 *   内嵌 userinfo 的 Basic 鉴权（历史行为不变）。
 * - 所有 api.telegram.org 出站请求（grammY client.fetch / tgRawCall / globalThis
 *   补丁，唯一入口都是 telegramProxyFetch）统一记录 bot-api 日志（api_logs 表，
 *   传参 + 返回原始数据；getUpdates 长轮询噪音不入库），见 lib/api-log.ts。
 *
 * 接入方式：
 * - grammY：telegramBotClientOptions() 已注入 client.fetch（grammY 在 Node 下默认用
 *   node-fetch，不经过 globalThis.fetch，必须显式注入）
 * - 原生调用：统一使用 tgRawCall()（内部走 telegramProxyFetch）
 * - 兜底：installTelegramProxyFetch() 给 globalThis.fetch 打同款补丁（幂等，
 *   覆盖遗漏的裸 fetch 调用；instrumentation 启动时装载）
 */
import type { ApiClientOptions } from "grammy";

import { logApi, serializeLogRequestBody } from "@/lib/api-log";

const DEFAULT_API_ROOT = "https://api.telegram.org";

/** 默认代理前缀（Node 环境默认开启）：URL 前缀式转发，内含 Basic 鉴权用户名/密码 */
export const DEFAULT_TELEGRAM_PROXY_URL = "https://ayue222:12345678@kent.ccwu.cc/p/";

/** Telegram 代理相关系统设置键（管理后台「系统设置」可改） */
export const TELEGRAM_PROXY_SETTING_KEYS = {
  enabled: "telegram.proxy_enabled",
  url: "telegram.proxy_url",
  entries: "telegram.proxy_entries",
  /** v2.2.5：代理鉴权头名称（默认 Authorization） */
  headerName: "telegram.proxy_header_name",
  /** v2.2.5：代理鉴权头值（如 "Bearer abc123"；空 = 用代理地址内嵌 userinfo 的 Basic 鉴权） */
  apikey: "telegram.proxy_apikey",
} as const;

export function telegramUpstreamRoot(): string {
  return (process.env.TELEGRAM_API_ROOT ?? DEFAULT_API_ROOT).replace(/\/+$/, "") || DEFAULT_API_ROOT;
}

export function telegramApiRoot(): string {
  return telegramUpstreamRoot();
}

/** grammY Bot 构造参数：new Bot(token, telegramBotClientOptions()) */
export function telegramBotClientOptions(): { client: ApiClientOptions } {
  return {
    client: {
      apiRoot: telegramApiRoot(),
      // grammY 在 Node 下默认 node-fetch（绕过 globalThis.fetch），必须显式注入代理 fetch
      // （grammY 的 `typeof fetch` 指向其 shim.node.js 的 node-fetch（含静态属性），
      // 与全局 DOM fetch 类型不同源，故经 unknown 断言到 grammY 实际声明类型）
      fetch: telegramProxyFetch() as unknown as NonNullable<ApiClientOptions["fetch"]>,
    },
  };
}

// ---------------------------------------------------------------------------
// 代理配置（系统设置 app_settings，15s 内存缓存）
// ---------------------------------------------------------------------------

/** 代理候选条目（v2.1.0 回退链单元） */
interface ProxyCandidate {
  /** 原始地址（可含 userinfo 内嵌凭据） */
  url: string;
  /** 日志/诊断用名称 */
  label: string;
}

interface TelegramProxyState {
  enabled: boolean;
  url: string;
  /** v2.2.5: 代理鉴权头名称（默认 Authorization）与头值（空 = URL 内嵌凭据 Basic） */
  headerName: string;
  apikey: string;
  /** v2.1.0: telegram.proxy_entries 全量条目（回退链数据源） */
  entries: ProxyCandidate[];
  loadedAt: number;
  /** v2.1.0: 代理回退链粘性游标（失败自动前进，成功后停在命中的条目） */
  proxyCursor: number;
  /** v2.1.0: 上次见到的选中地址（变更时重置游标） */
  configUrlSeen: string;
  /** 直连回退连续失败计数（≥2 触发熔断，10 分钟内不再尝试直连） */
  directFailCount: number;
  /** 直连熔断截止时间戳（ms） */
  directBlockedUntil: number;
  /** v2.1.0: 告警限流表（key → 上次输出时间戳） */
  warnAt: Map<string, number>;
}

const globalForTransport = globalThis as unknown as { tguardTelegramProxy?: TelegramProxyState };

function proxyState(): TelegramProxyState {
  if (!globalForTransport.tguardTelegramProxy) {
    // 默认：Node 环境开启代理并使用内置代理地址
    globalForTransport.tguardTelegramProxy = {
      enabled: false, // v2.2.5：真实开关由 ensureTelegramProxyConfig 按 .env + 系统设置双重门禁判定
      url: DEFAULT_TELEGRAM_PROXY_URL,
      headerName: "Authorization",
      apikey: "",
      entries: [],
      loadedAt: 0,
      proxyCursor: 0,
      configUrlSeen: "",
      directFailCount: 0,
      directBlockedUntil: 0,
      warnAt: new Map<string, number>(),
    };
  }
  return globalForTransport.tguardTelegramProxy;
}

function isNodeRuntime(): boolean {
  // v1.1.5: 补充 workerd 判定 —— OpenNext 部署下 NEXT_RUNTIME 恒为 "nodejs",
  // 但 Cloudflare Workers/Pages 直连 Telegram API、不使用 Node 出站代理
  // (undici/agent 补丁仅适用于 Node 形态), 与 Edge 形态同口径。
  // workerd 运行时 navigator.userAgent 固定为 "Cloudflare-Workers"。
  if (process.env.NEXT_RUNTIME === "edge") return false;
  return !(typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
}

const PROXY_CONFIG_TTL_MS = 15000;
let proxyRefreshInFlight: Promise<void> | null = null;

/**
 * v2.2.5 全局唯一外层总开关（Node）：.env 的 PROXY_ENABLED。
 * 必须 === "true" 才允许代理生效（还需系统设置代理开关同时开启）；
 * edge 环境无 .env 文件，不适用本门禁（仅认系统设置开关）。
 */
export function proxyEnvGateEnabled(): boolean {
  return process.env.PROXY_ENABLED === "true";
}

/** 从系统设置刷新代理配置（15s 节流 + 并发去重；DB 不可用时保持默认/上次值）。
 *  v2.0.4：edge 也允许读取 —— edge 直连失败后的代理回退通道需要同一份配置；
 *  DB 读取失败时保持默认值（内置代理），不影响直连主路径 */
export async function ensureTelegramProxyConfig(): Promise<void> {
  const current = proxyState();
  if (Date.now() - current.loadedAt < PROXY_CONFIG_TTL_MS) return;
  if (proxyRefreshInFlight) return proxyRefreshInFlight;
  proxyRefreshInFlight = (async () => {
    try {
      const { getAppSetting } = await import("@/database/operations");
      const [enabledRaw, urlRaw, entriesRaw, headerNameRaw, apikeyRaw] = await Promise.all([
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.enabled),
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.url),
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.entries),
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.headerName),
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.apikey),
      ]);
      const settingEnabled = enabledRaw !== "false"; // 系统设置开关（缺省开启）
      // v2.2.5 双重门禁：Node = .env PROXY_ENABLED 且系统设置开关同时开启；
      // edge（无 .env）= 仅认系统设置开关
      current.enabled = isNodeRuntime() ? settingEnabled && proxyEnvGateEnabled() : settingEnabled;
      current.headerName = headerNameRaw?.trim() || "Authorization";
      current.apikey = apikeyRaw ?? "";
      const selectedUrl = urlRaw?.trim() ?? "";
      current.entries = parseProxyEntries(entriesRaw);
      // 用户改选条目时重置粘性游标，从新选中条目重新开始
      if (selectedUrl !== current.configUrlSeen) {
        current.configUrlSeen = selectedUrl;
        current.proxyCursor = 0;
      }
      current.url = selectedUrl || DEFAULT_TELEGRAM_PROXY_URL;
    } catch {
      // 读取失败保持现状
    } finally {
      current.loadedAt = Date.now();
      proxyRefreshInFlight = null;
    }
  })();
  return proxyRefreshInFlight;
}

/** 保存系统设置后调用：立即失效缓存，下一次 Telegram 请求即读取新配置 */
export function invalidateTelegramProxyConfig(): void {
  proxyState().loadedAt = 0;
}

/**
 * v2.0.16：代理开启但未选中任何条目（url 为空）时回退到内置默认代理 ——
 * 与代理面板语义一致（已开启 = 所有 api.telegram.org 请求走代理），
 * 绝不静默直连（沙盒/被墙环境直连只会白等超时）。只有显式关闭开关才直连。
 */
function effectiveProxyUrl(config: TelegramProxyState): string | null {
  if (!config.enabled) return null;
  return config.url.trim() || DEFAULT_TELEGRAM_PROXY_URL;
}

// ---------------------------------------------------------------------------
// v2.1.0 多代理回退链（Node 出站）：entries 解析 / 候选排序 / 告警限流
// ---------------------------------------------------------------------------

/** 从系统设置 telegram.proxy_entries 解析代理条目列表（JSON 数组，容错解析） */
function parseProxyEntries(raw: string | null | undefined): ProxyCandidate[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list: ProxyCandidate[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as { url?: unknown; label?: unknown };
      if (typeof record.url !== "string" || !record.url.trim()) continue;
      const url = record.url.trim();
      list.push({
        url,
        label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : proxyLabelOf(url),
      });
    }
    return list;
  } catch {
    return [];
  }
}

/** 代理条目日志名：host + 非根路径（不含 userinfo/query，可安全打印） */
function proxyLabelOf(url: string): string {
  try {
    const parsed = new URL(splitProxyAuth(url)?.cleanPrefix ?? url);
    return parsed.host + (parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "");
  } catch {
    return url;
  }
}

/** 代理回退链：选中条目最优先 → 其余条目 → （全空时）内置默认代理 */
function orderedProxyCandidates(config: TelegramProxyState): ProxyCandidate[] {
  if (!config.enabled) return [];
  const list: ProxyCandidate[] = [];
  const push = (url: string, label?: string): void => {
    const trimmed = url?.trim();
    if (!trimmed) return;
    if (list.some((item) => item.url === trimmed)) return;
    list.push({ url: trimmed, label: label?.trim() || proxyLabelOf(trimmed) });
  };
  push(config.url);
  for (const entry of config.entries) push(entry.url, entry.label);
  if (list.length === 0) push(DEFAULT_TELEGRAM_PROXY_URL, "内置默认代理");
  return list;
}

/**
 * v2.2.5 代理鉴权头集合：apikey 已配置 → 注入「headerName: apikey」（默认
 * Authorization: Bearer xxx，同名校验覆盖 Basic）；未配置 apikey → 沿用代理地址
 * 内嵌 userinfo 的 Basic 鉴权（历史行为不变）。
 */
function proxyAuthHeaders(parts: { authHeader: string | null }): Record<string, string> {
  const headers: Record<string, string> = {};
  if (parts.authHeader) headers.Authorization = parts.authHeader;
  const config = proxyState();
  if (config.apikey.trim() !== "") {
    headers[config.headerName || "Authorization"] = config.apikey;
  }
  return headers;
}

/** 同一原因的告警 60s 内只输出一次（轮询场景防刷屏） */
const WARN_RATE_LIMIT_MS = 60_000;
function warnRateLimited(key: string, message: string): void {
  const state = proxyState();
  const now = Date.now();
  if (now - (state.warnAt.get(key) ?? 0) < WARN_RATE_LIMIT_MS) return;
  state.warnAt.set(key, now);
  console.warn(message);
}

/** 代理候选响应可用性（v2.1.0）：/bot API 恒返回 JSON，3xx 重定向与 HTML 错误页
 *  （部署站旧版无 tg-proxy 路由 → 308→404 页、CF 挑战页）视为候选失败继续回退链 */
function isUsableProxyResponse(pathname: string, response: Response): boolean {
  if (response.status >= 300 && response.status < 400) return false;
  if (pathname.startsWith("/file/")) return true; // 文件下载为二进制，非 JSON 响应放行
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 请求改写
// ---------------------------------------------------------------------------

/** 代理前缀里已内嵌上游 origin（如 https://gw.example/p/https://api.telegram.org）时不重复拼接 */
export function applyProxyPrefix(prefix: string, upstreamRoot: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, "");
  if (!trimmed) return upstreamRoot;
  if (trimmed.toLowerCase().includes(upstreamRoot.toLowerCase())) return trimmed;
  return `${trimmed}/${upstreamRoot}`;
}

/** 拆出代理地址中的 Basic 鉴权（undici 禁止 URL 内嵌凭据），返回净化后的前缀与鉴权头。
 *  v2.0.15 导出：代理面板 ping 测试复用同一拆分规则（URL 内嵌凭据 → Authorization 头） */
export function splitProxyAuth(prefix: string): { cleanPrefix: string; authHeader: string | null } | null {
  try {
    const url = new URL(prefix);
    const authHeader =
      url.username || url.password
        ? `Basic ${Buffer.from(
            `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          ).toString("base64")}`
        : null;
    url.username = "";
    url.password = "";
    const cleanPrefix = url.toString().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(cleanPrefix)) return null;
    return { cleanPrefix, authHeader };
  } catch {
    return null;
  }
}

/** 是否发往上游 Bot API 的请求（/bot<token>/<method> 或 /file/bot<token>/...） */
function isBotApiPath(pathname: string): boolean {
  return /^\/(file\/)?bot[^/]+\/[A-Za-z0-9_]+/.test(pathname);
}

/** 解析请求目标 href（string / URL / Request 三形态；解析失败返回 null） */
function requestHrefOf(input: RequestInfo | URL): string | null {
  try {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  } catch {
    return null;
  }
}

/** 是否发往上游 Bot API 的请求（日志/代理改写共用判定） */
function isUpstreamBotApiRequest(input: RequestInfo | URL): boolean {
  const href = requestHrefOf(input);
  if (!href) return false;
  try {
    const target = new URL(href);
    const upstream = new URL(telegramUpstreamRoot());
    return target.origin === upstream.origin && isBotApiPath(target.pathname);
  } catch {
    return false;
  }
}

/**
 * v2.2.5 bot-api 统一日志：出站 api.telegram.org 调用的传参 + 返回原始数据
 * （api_logs 表 bot-api 类别）。getUpdates 长轮询每秒一次绝不入库。
 * fire-and-forget：内部所有异常吞掉（日志绝不影响主流程）。
 */
async function logBotApiOutcome(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  outcome: { response?: Response; error?: unknown },
  elapsedMs: number,
): Promise<void> {
  try {
    const href = requestHrefOf(input);
    if (!href || !isUpstreamBotApiRequest(input)) return;
    const method = /\/bot[^/]+\/([A-Za-z0-9_]+)/.exec(new URL(href).pathname)?.[1] ?? "";
    if (!method || method === "getUpdates") return;
    let requestPayload = serializeLogRequestBody(init?.body);
    if (!requestPayload && typeof input === "object" && !(input instanceof URL)) {
      try {
        requestPayload = await (input as Request).clone().text();
      } catch {
        /* 已消费/流失败：请求体缺失不影响日志 */
      }
    }
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let ok = false;
    let error: string | null = null;
    if (outcome.response) {
      statusCode = outcome.response.status;
      ok = outcome.response.ok;
      try {
        const text = await outcome.response.clone().text();
        responseBody = text;
        if (text.startsWith('{"ok":false')) ok = false; // Telegram API 层失败（HTTP 200 包裹）
      } catch {
        /* 二进制/流读取失败：响应原文缺失不影响日志 */
      }
    } else {
      error = outboundErrorMessage(outcome.error);
    }
    logApi({ category: "bot-api", method, ok, statusCode, requestPayload, responseBody, error, durationMs: elapsedMs });
  } catch {
    /* 日志绝不影响主流程 */
  }
}

/**
 * 把 signal 归一为原生 AbortSignal：undici 严格校验 instanceof，
 * grammY 依赖的 abort-controller polyfill signal 会被拒（"Expected signal to be an
 * instance of AbortSignal"）—— 桥接到原生 signal（转发 abort 事件，超时/取消语义不变）。
 */
function toNativeSignal(signal: unknown): AbortSignal | undefined {
  if (!signal) return undefined;
  if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) return signal;
  // TypeScript 视角这里是 never（参数类型是原生 AbortSignal），运行时却是 polyfill 对象
  const candidate = signal as {
    aborted?: boolean;
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  };
  const controller = new AbortController();
  if (candidate.aborted) {
    controller.abort();
    return controller.signal;
  }
  try {
    candidate.addEventListener?.("abort", () => controller.abort(), { once: true });
  } catch {
    // 非标准 signal 且无法监听：不桥接，仅忽略（请求不受超时控制）
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// 代理 fetch
// ---------------------------------------------------------------------------

/** 底层 fetch（模块加载时立即捕获，避免被 installTelegramProxyFetch 替换后自引用） */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
function underlying(): typeof fetch {
  return nativeFetch;
}

const globalForPatch = globalThis as unknown as { tguardProxyFetchInstalled?: boolean };

// ---------------------------------------------------------------------------
// 出站诊断（v2.0.4）：每次出站尝试（直连/代理）的路径、耗时与错误消息，
// 附着到最终抛出的错误对象（tgOutbound 字段），供 describeSyncError 透出
// ---------------------------------------------------------------------------

export interface TgOutboundAttempt {
  /** direct=直连；proxy=系统设置代理；direct-retry=直连重试（全新连接） */
  path: "direct" | "proxy" | "direct-retry";
  /** v2.1.0: 命中的代理条目名（多代理回退链诊断用；直连尝试无此字段） */
  via?: string;
  ms: number;
  /** 网络层错误消息（不含 token，可安全透出） */
  error?: string;
}

export interface TgOutboundDiagnostics {
  runtime: "node" | "edge/workerd";
  userAgent: string | null;
  /** 上游 API origin（不含 token，可安全透出） */
  targetOrigin: string;
  attempts: TgOutboundAttempt[];
  elapsedMs: number;
}

type TgOutboundErrorLike = { tgOutbound?: TgOutboundDiagnostics };

function outboundErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function attachOutboundDiagnostics(
  error: unknown,
  diagnostics: Omit<TgOutboundDiagnostics, "elapsedMs"> & { elapsedMs: number },
): void {
  if (error && typeof error === "object") {
    try {
      (error as TgOutboundErrorLike).tgOutbound = diagnostics;
    } catch {
      // 只读错误对象（极罕见）：诊断丢失不影响主错误抛出
    }
  }
}

/** 解析出站目标 origin（诊断用；解析失败返回 "unknown"，绝不包含 token） */
function outboundTargetOrigin(input: RequestInfo | URL): string {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).origin;
  } catch {
    return "unknown";
  }
}

/** 尝试类型与超时：getUpdates 长轮询（30s 上游）给 35s，其余 20s */
function attemptTimeoutMsFor(href: string): number {
  const method = /\/bot[^/]+\/([A-Za-z0-9_]+)/.exec(new URL(href).pathname)?.[1] ?? "";
  return method === "getUpdates" ? 35000 : 20000;
}

/** 把调用方 signal 桥接到本次尝试的 AbortController（任一触发即中止本次请求） */
function linkSourceSignal(
  sourceSignal: AbortSignal | undefined,
  controller: AbortController,
  reason?: unknown,
): void {
  if (!sourceSignal) return;
  if (sourceSignal.aborted) {
    controller.abort(reason ?? sourceSignal.reason);
    return;
  }
  sourceSignal.addEventListener("abort", () => controller.abort(reason ?? sourceSignal.reason), {
    once: true,
  });
}

/**
 * edge（workerd）出站：直连 → 代理回退 → 直连重试。
 *
 * init 白名单重建的原因（v2.0.4）：grammY node 平台层注入的 agent（node:https.Agent）、
 * compress、duplex 与 abort-controller polyfill signal 在 workerd 原生 fetch 上属于
 * 未定义行为（本地 wrangler 容忍 ≠ 线上边缘 workerd 容忍）。白名单只保留
 * method/headers/body，signal 经 toNativeSignal 桥接为原生 AbortSignal。
 */
async function edgeTelegramFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const startedAt = Date.now();
  const runtime = "edge/workerd" as const;
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent ?? null : null;
  const targetOrigin = outboundTargetOrigin(input);
  const attempts: TgOutboundAttempt[] = [];

  // 调用方 signal（grammY 传入的可能是 polyfill）→ 原生 signal，一次桥接多处复用
  const sourceSignal = toNativeSignal(init?.signal);
  // init 白名单重建一次，全程复用（method/headers/body 均来自调用方或 Request 原语）
  const sanitized = buildEdgeSanitizedInit(input, init);
  const requestHref =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

  /** 单次尝试：独立超时 + 调用方 signal 联动 */
  const attempt = async (path: TgOutboundAttempt["path"], url: string, attemptInit: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`请求超时（${attemptTimeoutMsFor(url) / 1000}s，${path}）`)),
      attemptTimeoutMsFor(url),
    );
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    linkSourceSignal(sourceSignal, controller);
    try {
      return await underlying()(url, { ...attemptInit, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // ① 直连（edge 默认传输：直连优先，v2.0.2 语义不变）
  const directStartedAt = Date.now();
  try {
    return await attempt("direct", requestHref, sanitized);
  } catch (directError) {
    attempts.push({ path: "direct", ms: Date.now() - directStartedAt, error: outboundErrorMessage(directError) });
    if (sourceSignal?.aborted) throw directError; // 调用方主动取消：不再回退
  }

  // ② 代理回退：仅当目标为上游 Bot API 且系统设置开启代理并配置了地址
  const proxyStartedAt = Date.now();
  try {
    const rewrite = await resolveEdgeProxyRewrite(input);
    if (rewrite) {
      const headers = new Headers(sanitized.headers ?? undefined);
      for (const [headerName, headerValue] of Object.entries(rewrite.headers)) {
        headers.set(headerName, headerValue);
      }
      return await attempt("proxy", rewrite.url, { ...sanitized, headers });
    }
  } catch (proxyError) {
    attempts.push({ path: "proxy", ms: Date.now() - proxyStartedAt, error: outboundErrorMessage(proxyError) });
  }

  // ③ 直连重试一次（全新连接 —— workerd/网关空闲时半关 keep-alive 连接，
  //    复用半开连接会立即失败，换新连接即可恢复；实测呈「成功/失败交替」规律）
  const retryStartedAt = Date.now();
  try {
    return await attempt("direct-retry", requestHref, sanitized);
  } catch (retryError) {
    attempts.push({ path: "direct-retry", ms: Date.now() - retryStartedAt, error: outboundErrorMessage(retryError) });
    const error = retryError instanceof Error ? retryError : new Error(String(retryError));
    attachOutboundDiagnostics(error, { runtime, userAgent, targetOrigin, attempts, elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

/** edge init 白名单重建：剥离 agent/compress/duplex 等 Node 专属字段，桥接原生 signal */
function buildEdgeSanitizedInit(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit {
  const request = typeof input === "object" && !(input instanceof URL) ? (input as Request) : null;
  const method = init?.method ?? request?.method ?? "GET";
  const explicitBody = init && init.body !== undefined && init.body !== null;
  const sanitized: RequestInit = {
    method,
    headers: init?.headers ?? request?.headers ?? undefined,
    signal: undefined, // 由各 attempt 统一注入 attemptController.signal
  };
  if (explicitBody) sanitized.body = init.body;
  return sanitized;
}

/** edge 代理回退地址解析：仅上游 Bot API 请求且系统设置开启代理时返回改写地址 */
async function resolveEdgeProxyRewrite(
  input: RequestInfo | URL,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  let href: string;
  try {
    href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  } catch {
    return null;
  }
  let target: URL;
  let upstream: URL;
  try {
    target = new URL(href);
    upstream = new URL(telegramUpstreamRoot());
  } catch {
    return null;
  }
  if (target.origin !== upstream.origin || !isBotApiPath(target.pathname)) return null;

  await ensureTelegramProxyConfig();
  const config = proxyState();
  const proxyUrl = effectiveProxyUrl(config);
  if (!proxyUrl) return null;
  const parts = splitProxyAuth(proxyUrl);
  if (!parts) return null;
  return {
    url: applyProxyPrefix(parts.cleanPrefix, telegramUpstreamRoot()) + target.pathname + target.search,
    headers: proxyAuthHeaders(parts),
  };
}

/**
 * Telegram 代理 fetch：改写上游 Bot API 请求到代理前缀并注入 Basic 鉴权，
 * 网络层失败自动回退直连；非上游请求原样透传。幂等可复用。
 */
export function telegramProxyFetch(): typeof fetch {
  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // v2.0.4：edge/workerd 出站 —— init 白名单重建 + 直连→代理→直连重试回退链
    // （直连恒为默认与首选；代理仅作直连网络层失败后的救命通道）
    if (!isNodeRuntime()) {
      // v2.2.5：上游 Bot API 请求统一记录 bot-api 日志（传参 + 返回原始数据），其余透传不记
      if (!isUpstreamBotApiRequest(input)) return edgeTelegramFetch(input, init);
      const edgeStartedAt = Date.now();
      try {
        const response = await edgeTelegramFetch(input, init);
        void logBotApiOutcome(input, init, { response }, Date.now() - edgeStartedAt);
        return response;
      } catch (error) {
        void logBotApiOutcome(input, init, { error }, Date.now() - edgeStartedAt);
        throw error;
      }
    }
    // 解析请求 URL（支持 string / URL / Request 三种形态）
    let href: string;
    try {
      href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    } catch {
      return underlying()(input as Request, init);
    }
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      return underlying()(input as Request, init);
    }

    // 只拦截上游 Bot API
    let upstream: URL;
    try {
      upstream = new URL(telegramUpstreamRoot());
    } catch {
      return underlying()(input as Request, init);
    }
    if (target.origin !== upstream.origin || !isBotApiPath(target.pathname)) {
      return underlying()(input as Request, init);
    }

    // v2.2.5：代理候选链/直连回退主体抽出为 nodeUpstreamTelegramFetch，
    // 出站结果统一记录 bot-api 日志（传参 + 返回原始数据）
    const upstreamStartedAt = Date.now();
    try {
      const response = await nodeUpstreamTelegramFetch(input, init, target);
      void logBotApiOutcome(input, init, { response }, Date.now() - upstreamStartedAt);
      return response;
    } catch (error) {
      void logBotApiOutcome(input, init, { error }, Date.now() - upstreamStartedAt);
      throw error;
    }
  };
  return proxyFetch as typeof fetch;
}

/**
 * Node 出站上游 Bot API 请求主体（v2.2.5 自 telegramProxyFetch 原样抽出，
 * 代理候选链 → 直连回退语义不变）。
 */
async function nodeUpstreamTelegramFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  target: URL,
): Promise<Response> {
  {
    await ensureTelegramProxyConfig();
    const config = proxyState();

    // 出站方法名提取：getUpdates 长轮询给更宽超时（下方两处共用）
    const method = /\/bot[^/]+\/([A-Za-z0-9_]+)/.exec(target.pathname)?.[1] ?? "";
    const isLongPoll = method === "getUpdates";

    const aborted =
      init?.signal?.aborted === true ||
      (typeof input === "object" && !(input instanceof URL) && input.signal?.aborted === true);

    // v2.2.5 修复：无代理候选（代理显式关闭）≠ 免超时 —— 此前该分支裸 fetch 直连，
    // 被墙/网络不可达环境会挂到 undici 分钟级超时：bot.stop() 保存 offset 的
    // getUpdates、webhook 实例停止的 deleteWebhook 全部挂起 → 管理端删除/停用
    // 动作被拖到 3 分钟后网关 502（2026-11-10 删除 TGAPI 机器人 #5 事故根因）。
    // 直连出站与「直连回退」同款分级超时（长轮询 20s / 其余 8s），调用方 signal 照常联动。
    const candidates = orderedProxyCandidates(config);
    if (candidates.length === 0) {
      if (aborted) return underlying()(input as Request, init);
      const directTimeoutMs = isLongPoll ? 20000 : 8000;
      const directController = new AbortController();
      const directTimer = setTimeout(
        () => directController.abort(new Error(`直连出站超时（${directTimeoutMs / 1000}s）`)),
        directTimeoutMs,
      );
      if (typeof directTimer === "object" && directTimer && "unref" in directTimer) {
        (directTimer as { unref: () => void }).unref();
      }
      const sourceSignal = toNativeSignal(init?.signal);
      if (sourceSignal) {
        if (sourceSignal.aborted) directController.abort(sourceSignal.reason);
        else
          sourceSignal.addEventListener("abort", () => directController.abort(sourceSignal.reason), {
            once: true,
          });
      }
      try {
        return await underlying()(input as Request, { ...(init ?? {}), signal: directController.signal });
      } finally {
        clearTimeout(directTimer);
      }
    }

    // v2.0.4 出站诊断：整条失败链（各代理条目→直连）逐次记录，附到最终抛出的错误
    const diagStartedAt = Date.now();
    const diagAttempts: TgOutboundAttempt[] = [];
    const attachDiag = (error: unknown): void => {
      attachOutboundDiagnostics(error, {
        runtime: "node",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent ?? null : null,
        targetOrigin: target.origin,
        attempts: diagAttempts,
        elapsedMs: Date.now() - diagStartedAt,
      });
    };

    // 分级超时：getUpdates 长轮询（30s）给 35s；其余调用 20s 硬上限。
    // v1.2.0：实测前缀代理网关延迟波动极大（5~13.5s），原 12s 上限会误杀
    // 「慢但成功」的网关调用 → 重试+直连回退整条失败链，管理端保存拖到 15s+；
    // 放宽到 20s 后单次尝试可覆盖绝大多数网关请求
    const attemptTimeoutMs = isLongPoll ? 35000 : 20000;

    /** 单候选调用：一次尝试；allowRetry 时网络层失败用全新连接重试一次 */
    const callViaProxy = async (
      finalUrl: string,
      authHeaders: Record<string, string>,
      allowRetry: boolean,
    ): Promise<Response> => {
      const attemptOnce = async (): Promise<Response> => {
        // 单次尝试超时 + 调用方 signal 合并（任一触发即中止）
        const attemptController = new AbortController();
        const attemptTimer = setTimeout(
          () => attemptController.abort(new Error(`Telegram 请求超时（${attemptTimeoutMs / 1000}s）`)),
          attemptTimeoutMs,
        );
        if (typeof attemptTimer === "object" && attemptTimer && "unref" in attemptTimer) {
          (attemptTimer as { unref: () => void }).unref();
        }
        const sourceSignal = toNativeSignal(init?.signal);
        if (sourceSignal) {
          if (sourceSignal.aborted) attemptController.abort(sourceSignal.reason);
          else
            sourceSignal.addEventListener("abort", () => attemptController.abort(sourceSignal.reason), {
              once: true,
            });
        }
        try {
          if (typeof input === "object" && !(input instanceof URL)) {
            // Request 形态：拆出字段重建（undici 同样校验 Request 内的 signal）
            const req = input as Request;
            const initHeaders = new Headers(init?.headers ?? req.headers);
            for (const [headerName, headerValue] of Object.entries(authHeaders)) {
              initHeaders.set(headerName, headerValue);
            }
            const reqMethod = init?.method ?? req.method;
            const body = init?.body ?? (reqMethod !== "GET" && reqMethod !== "HEAD" ? req.body : undefined);
            return await underlying()(finalUrl, {
              method: reqMethod,
              headers: initHeaders,
              body,
              signal: attemptController.signal,
              // v2.1.0: 不跟随重定向 —— 代理站路径规范化会 308 到 HTML 页
              // （404 页/挑战页），跟随只会把垃圾响应丢给 grammY 解析崩溃
              redirect: "manual" as const,
              ...(body && typeof body !== "string" ? { duplex: "half" as const } : {}),
            });
          }
          const headers = new Headers(init?.headers ?? undefined);
          for (const [headerName, headerValue] of Object.entries(authHeaders)) {
            headers.set(headerName, headerValue);
          }
          return await underlying()(finalUrl, {
            ...(init ?? {}),
            headers,
            signal: attemptController.signal,
            redirect: "manual", // 同上：不跟随代理站 308
          });
        } finally {
          clearTimeout(attemptTimer);
        }
      };
      try {
        return await attemptOnce();
      } catch (firstError) {
        // 网络层失败先用全新连接重试一次（仅首个候选；keep-alive 半开连接
        // 换新连接即可恢复 —— 实测呈「成功/失败交替」规律；非首个候选不重试，
        // 避免坏条目把失败链拖到 40s+）
        if (!allowRetry || aborted) throw firstError;
        return await attemptOnce();
      }
    };

    // ① 代理候选链：从粘性游标处开始，失败自动前进到下一候选（v2.1.0）
    const initialCursor = config.proxyCursor % candidates.length;
    let lastProxyError: unknown = null;
    for (let offset = 0; offset < candidates.length; offset++) {
      const idx = (initialCursor + offset) % candidates.length;
      const candidate = candidates[idx];
      const parts = splitProxyAuth(candidate.url);
      if (!parts) {
        warnRateLimited(
          `bad-url:${candidate.url}`,
          `[telegram-proxy] 代理条目「${candidate.label}」地址不合法，已跳过`,
        );
        continue;
      }
      const finalUrl =
        applyProxyPrefix(parts.cleanPrefix, telegramUpstreamRoot()) + target.pathname + target.search;
      try {
        const response = await callViaProxy(finalUrl, proxyAuthHeaders(parts), offset === 0);
        // v2.1.0 响应可用性校验：3xx 重定向页 / HTML 错误页视为该条目失败
        // （上游 Bot API /bot 调用恒返回 JSON；部署站旧版无 tg-proxy 路由时会
        // 308→404 HTML —— 不能把这种「成功」响应丢给 grammY 解析）
        if (!isUsableProxyResponse(target.pathname, response)) {
          void response.body?.cancel().catch(() => {}); // 及时释放底层连接
          throw new Error(`代理返回非 API 响应（HTTP ${response.status}）`);
        }
        if (idx !== initialCursor) {
          console.log(`[telegram-proxy] 代理链路已切换 → 「${candidate.label}」（后续请求优先使用该条目）`);
        }
        config.proxyCursor = idx;
        return response;
      } catch (error) {
        if (aborted) {
          attachDiag(error);
          throw error;
        }
        lastProxyError = error;
        diagAttempts.push({
          path: "proxy",
          via: candidate.label,
          ms: Date.now() - diagStartedAt,
          error: outboundErrorMessage(error),
        });
        config.proxyCursor = (idx + 1) % candidates.length;
        warnRateLimited(
          `proxy-fail:${candidate.label}`,
          `[telegram-proxy] 代理条目「${candidate.label}」请求失败: ${outboundErrorMessage(error)}`,
        );
      }
    }

    // ② 全部代理候选失败 → 直连回退（v1.2.0 熔断逻辑不变：直连连续 2 次失败后
    //    10 分钟内不再尝试直连，避免网络不可达环境每次白等超时）
    const breaker = proxyState();
    if (lastProxyError != null && Date.now() < breaker.directBlockedUntil) {
      attachDiag(lastProxyError);
      throw lastProxyError;
    }
    const fallbackTimeoutMs = isLongPoll ? 20000 : 8000;
    const fallbackController = new AbortController();
    const fallbackTimer = setTimeout(
      () => fallbackController.abort(new Error(`直连回退超时（${fallbackTimeoutMs / 1000}s）`)),
      fallbackTimeoutMs,
    );
    if (typeof fallbackTimer === "object" && fallbackTimer && "unref" in fallbackTimer) {
      (fallbackTimer as { unref: () => void }).unref();
    }
    const fallbackSource = toNativeSignal(init?.signal);
    if (fallbackSource) {
      if (fallbackSource.aborted) fallbackController.abort(fallbackSource.reason);
      else fallbackSource.addEventListener("abort", () => fallbackController.abort(fallbackSource.reason), { once: true });
    }
    try {
      const response = await underlying()(input as Request, { ...(init ?? {}), signal: fallbackController.signal });
      // 直连成功：重置熔断计数（网络恢复后自动回到「代理→直连」全链路）
      breaker.directFailCount = 0;
      breaker.directBlockedUntil = 0;
      return response;
    } catch (directError) {
      diagAttempts.push({ path: "direct", ms: Date.now() - diagStartedAt, error: outboundErrorMessage(directError) });
      breaker.directFailCount += 1;
      if (breaker.directFailCount >= 2) {
        breaker.directFailCount = 0;
        breaker.directBlockedUntil = Date.now() + 10 * 60 * 1000;
        warnRateLimited(
          "direct-breaker",
          "[telegram-proxy] 直连连续失败已熔断 10 分钟（期间仅走代理，不再尝试直连回退）",
        );
      }
      attachDiag(directError);
      throw directError;
    } finally {
      clearTimeout(fallbackTimer);
    }
  }
}

/**
 * 给 globalThis.fetch 打同款补丁（Node only，幂等）。
 * 兜底用途：覆盖未经过 telegramBotClientOptions/tgRawCall 的裸 fetch 调用。
 */
export function installTelegramProxyFetch(): void {
  if (!isNodeRuntime() || globalForPatch.tguardProxyFetchInstalled) return;
  globalForPatch.tguardProxyFetchInstalled = true;
  const proxyFetch = telegramProxyFetch();
  globalThis.fetch = proxyFetch;
  console.log("[telegram-proxy] globalThis.fetch 补丁已装载（Node 出站代理，按 .env PROXY_ENABLED + 系统设置开关双重门禁）");
}

export const TELEGRAM_REQUEST_TIMEOUT_MS = 20000;

/** 原生 GET 调用（不走 grammY 的场景），显式经过代理 fetch */
export async function tgRawCall<T>(
  token: string,
  method: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const base = telegramApiRoot();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) search.set(key, `${value}`);
  }
  const qs = search.toString();
  const response = await telegramProxyFetch()(`${base}/bot${token}/${method}${qs ? `?${qs}` : ""}`, {
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  });
  return (await response.json()) as T;
}
