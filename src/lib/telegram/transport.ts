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
 * 接入方式：
 * - grammY：telegramBotClientOptions() 已注入 client.fetch（grammY 在 Node 下默认用
 *   node-fetch，不经过 globalThis.fetch，必须显式注入）
 * - 原生调用：统一使用 tgRawCall()（内部走 telegramProxyFetch）
 * - 兜底：installTelegramProxyFetch() 给 globalThis.fetch 打同款补丁（幂等，
 *   覆盖遗漏的裸 fetch 调用；instrumentation 启动时装载）
 */
import type { ApiClientOptions } from "grammy";

const DEFAULT_API_ROOT = "https://api.telegram.org";

/** 默认代理前缀（Node 环境默认开启）：URL 前缀式转发，内含 Basic 鉴权用户名/密码 */
export const DEFAULT_TELEGRAM_PROXY_URL = "https://ayue222:12345678@kent.ccwu.cc/p/";

/** Telegram 代理相关系统设置键（管理后台「系统设置」可改） */
export const TELEGRAM_PROXY_SETTING_KEYS = {
  enabled: "telegram.proxy_enabled",
  url: "telegram.proxy_url",
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

interface TelegramProxyState {
  enabled: boolean;
  url: string;
  loadedAt: number;
  /** 直连回退连续失败计数（≥2 触发熔断，10 分钟内不再尝试直连） */
  directFailCount: number;
  /** 直连熔断截止时间戳（ms） */
  directBlockedUntil: number;
}

const globalForTransport = globalThis as unknown as { tguardTelegramProxy?: TelegramProxyState };

function proxyState(): TelegramProxyState {
  if (!globalForTransport.tguardTelegramProxy) {
    // 默认：Node 环境开启代理并使用内置代理地址
    globalForTransport.tguardTelegramProxy = {
      enabled: true,
      url: DEFAULT_TELEGRAM_PROXY_URL,
      loadedAt: 0,
      directFailCount: 0,
      directBlockedUntil: 0,
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

/** 从系统设置刷新代理配置（15s 节流 + 并发去重；DB 不可用时保持默认/上次值） */
export async function ensureTelegramProxyConfig(): Promise<void> {
  if (!isNodeRuntime()) return;
  const current = proxyState();
  if (Date.now() - current.loadedAt < PROXY_CONFIG_TTL_MS) return;
  if (proxyRefreshInFlight) return proxyRefreshInFlight;
  proxyRefreshInFlight = (async () => {
    try {
      const { getAppSetting } = await import("@/database/operations");
      const [enabledRaw, urlRaw] = await Promise.all([
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.enabled),
        getAppSetting(TELEGRAM_PROXY_SETTING_KEYS.url),
      ]);
      current.enabled = enabledRaw !== "false"; // 未设置时默认开启
      current.url = urlRaw?.trim() || DEFAULT_TELEGRAM_PROXY_URL;
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

/** 拆出代理地址中的 Basic 鉴权（undici 禁止 URL 内嵌凭据），返回净化后的前缀与鉴权头 */
function splitProxyAuth(prefix: string): { cleanPrefix: string; authHeader: string | null } | null {
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
// edge/workerd 请求初始化归一
// ---------------------------------------------------------------------------

/**
 * hop-by-hop 头：由 HTTP 连接层管理，workerd 的 fetch 不接受调用方设置
 * （grammY 的 JSON 载荷固定带 connection: keep-alive，直连 edge 时会被拒）。
 */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
] as const;

function stripHopByHop(headers: Headers): Headers {
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

/**
 * edge/workerd 请求初始化归一（仅非 Node 运行时调用）：
 * - 剥离 Node 专属字段 agent / compress（workerd 无 Node http 连接池概念，
 *   grammY 的 baseFetchConfig 仍会塞 Node https.Agent，属无效且易触发
 *   半开连接复用的 "Network connection lost"）
 * - signal 桥接为原生 AbortSignal（grammY 用 abort-controller polyfill，
 *   workerd 只接受原生实例）
 * - 剥离 hop-by-hop 头
 */
export function normalizeEdgeInit(init?: RequestInit): RequestInit | undefined {
  if (!init) return undefined;
  const source = init as RequestInit & { agent?: unknown; compress?: unknown };
  const normalized: RequestInit = { ...source };
  delete (normalized as { agent?: unknown }).agent;
  delete (normalized as { compress?: unknown }).compress;
  const nativeSignal = toNativeSignal(source.signal);
  if (nativeSignal) normalized.signal = nativeSignal;
  else delete (normalized as { signal?: AbortSignal }).signal;
  if (source.headers) normalized.headers = stripHopByHop(new Headers(source.headers));
  return normalized;
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

/**
 * Telegram 代理 fetch：改写上游 Bot API 请求到代理前缀并注入 Basic 鉴权，
 * 网络层失败自动回退直连；非上游请求原样透传。幂等可复用。
 */
export function telegramProxyFetch(): typeof fetch {
  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const nodeRuntime = isNodeRuntime();
    /** 直连透传：edge/workerd 必须先归一 init（Node 专属字段/非原生 signal/hop-by-hop 头） */
    const passthrough = (): Promise<Response> =>
      underlying()(input as Request, nodeRuntime ? init : normalizeEdgeInit(init));
    // v2.0.2：非 Node 运行时（edge/workerd）恒直连 —— 代理体系（Basic 鉴权头/
    // undici 连接池）只属于 Node 形态，edge 出站绝不改写到代理前缀
    if (!nodeRuntime) return passthrough();
    // 解析请求 URL（支持 string / URL / Request 三种形态）
    let href: string;
    try {
      href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    } catch {
      return passthrough();
    }
    let target: URL;
    try {
      target = new URL(href);
    } catch {
      return passthrough();
    }

    // 只拦截上游 Bot API
    let upstream: URL;
    try {
      upstream = new URL(telegramUpstreamRoot());
    } catch {
      return passthrough();
    }
    if (target.origin !== upstream.origin || !isBotApiPath(target.pathname)) {
      return passthrough();
    }

    await ensureTelegramProxyConfig();
    const config = proxyState();
    if (!config.enabled || !config.url.trim()) {
      return passthrough();
    }

    const parts = splitProxyAuth(config.url);
    if (!parts) {
      console.warn("[telegram-proxy] 代理地址不合法，本次请求直连:", config.url);
      return passthrough();
    }

    const finalUrl =
      applyProxyPrefix(parts.cleanPrefix, telegramUpstreamRoot()) + target.pathname + target.search;
    const headers = new Headers(
      typeof input === "object" && !(input instanceof URL) ? input.headers : (init?.headers ?? undefined),
    );
    if (parts.authHeader) headers.set("Authorization", parts.authHeader);

    const aborted =
      init?.signal?.aborted === true ||
      (typeof input === "object" && !(input instanceof URL) && input.signal?.aborted === true);

    // 分级超时：getUpdates 长轮询（30s）给 35s；其余调用 20s 硬上限。
    // v1.2.0：实测前缀代理网关延迟波动极大（5~13.5s），原 12s 上限会误杀
    // 「慢但成功」的网关调用 → 重试+直连回退整条失败链，管理端保存拖到 15s+；
    // 放宽到 20s 后单次尝试可覆盖绝大多数网关请求
    const method = /\/bot[^/]+\/([A-Za-z0-9_]+)/.exec(target.pathname)?.[1] ?? "";
    const isLongPoll = method === "getUpdates";
    const attemptTimeoutMs = isLongPoll ? 35000 : 20000;

    const callViaProxy = async (): Promise<Response> => {
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
          if (parts.authHeader) initHeaders.set("Authorization", parts.authHeader);
          const reqMethod = init?.method ?? req.method;
          const body = init?.body ?? (reqMethod !== "GET" && reqMethod !== "HEAD" ? req.body : undefined);
          return await underlying()(finalUrl, {
            method: reqMethod,
            headers: initHeaders,
            body,
            signal: attemptController.signal,
            ...(body && typeof body !== "string" ? { duplex: "half" as const } : {}),
          });
        }
        return await underlying()(finalUrl, {
          ...(init ?? {}),
          headers,
          signal: attemptController.signal,
        });
      } finally {
        clearTimeout(attemptTimer);
      }
    };

    try {
      return await callViaProxy();
    } catch (firstError) {
      if (aborted) throw firstError;
      const reason = firstError instanceof Error ? firstError.message : String(firstError);
      // 网络层失败先用全新连接重试一次（前缀代理/CF Workers 会在空闲时半关 keep-alive
      // 连接，undici 连接池复用半开连接会立即 ECONNRESET —— 换新连接即可成功，
      // 实测呈「成功/失败交替」规律）；重试仍失败再回退直连（普通调用限 8s、
      // getUpdates 长轮询限 20s，避免直连不可达环境长时间挂起 grammY 调用）。
      try {
        return await callViaProxy();
      } catch {
        console.warn("[telegram-proxy] 代理请求失败（重试后放弃，回退直连）:", reason);
        // v1.2.0 直连熔断：直连连续 2 次失败（网络不可达环境）后 10 分钟内
        // 不再尝试直连回退 —— 避免每次失败路径都白等 8s 直连超时，
        // 管理端操作的失败反馈从 25s+ 缩短到 20s 级
        const breaker = proxyState();
        if (Date.now() < breaker.directBlockedUntil) {
          throw firstError;
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
          breaker.directFailCount += 1;
          if (breaker.directFailCount >= 2) {
            breaker.directFailCount = 0;
            breaker.directBlockedUntil = Date.now() + 10 * 60 * 1000;
            console.warn("[telegram-proxy] 直连连续失败已熔断 10 分钟（期间仅走代理，不再尝试直连回退）");
          }
          throw directError;
        } finally {
          clearTimeout(fallbackTimer);
        }
      }
    }
  };
  return proxyFetch as typeof fetch;
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
  console.log("[telegram-proxy] globalThis.fetch 补丁已装载（Node 出站代理，默认开启）");
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
