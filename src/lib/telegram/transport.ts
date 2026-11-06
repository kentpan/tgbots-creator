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
      if (rewrite.authHeader) headers.set("Authorization", rewrite.authHeader);
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
): Promise<{ url: string; authHeader: string | null } | null> {
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
  if (!config.enabled || !config.url.trim()) return null;
  const parts = splitProxyAuth(config.url);
  if (!parts) return null;
  return {
    url: applyProxyPrefix(parts.cleanPrefix, telegramUpstreamRoot()) + target.pathname + target.search,
    authHeader: parts.authHeader,
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
    if (!isNodeRuntime()) return edgeTelegramFetch(input, init);
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

    await ensureTelegramProxyConfig();
    const config = proxyState();
    if (!config.enabled || !config.url.trim()) {
      return underlying()(input as Request, init);
    }

    const parts = splitProxyAuth(config.url);
    if (!parts) {
      console.warn("[telegram-proxy] 代理地址不合法，本次请求直连:", config.url);
      return underlying()(input as Request, init);
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

    // v2.0.4 出站诊断：整条失败链（代理→代理重试→直连）逐次记录，附到最终抛出的错误
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
      diagAttempts.push({ path: "proxy", ms: Date.now() - diagStartedAt, error: outboundErrorMessage(firstError) });
      if (aborted) {
        attachDiag(firstError);
        throw firstError;
      }
      const reason = firstError instanceof Error ? firstError.message : String(firstError);
      // 网络层失败先用全新连接重试一次（前缀代理/CF Workers 会在空闲时半关 keep-alive
      // 连接，undici 连接池复用半开连接会立即 ECONNRESET —— 换新连接即可成功，
      // 实测呈「成功/失败交替」规律）；重试仍失败再回退直连（普通调用限 8s、
      // getUpdates 长轮询限 20s，避免直连不可达环境长时间挂起 grammY 调用）。
      try {
        return await callViaProxy();
      } catch (retryError) {
        diagAttempts.push({ path: "proxy", ms: Date.now() - diagStartedAt, error: outboundErrorMessage(retryError) });
        console.warn("[telegram-proxy] 代理请求失败（重试后放弃，回退直连）:", reason);
        // v1.2.0 直连熔断：直连连续 2 次失败（网络不可达环境）后 10 分钟内
        // 不再尝试直连回退 —— 避免每次失败路径都白等 8s 直连超时，
        // 管理端操作的失败反馈从 25s+ 缩短到 20s 级
        const breaker = proxyState();
        if (Date.now() < breaker.directBlockedUntil) {
          attachDiag(firstError);
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
          diagAttempts.push({ path: "direct", ms: Date.now() - diagStartedAt, error: outboundErrorMessage(directError) });
          breaker.directFailCount += 1;
          if (breaker.directFailCount >= 2) {
            breaker.directFailCount = 0;
            breaker.directBlockedUntil = Date.now() + 10 * 60 * 1000;
            console.warn("[telegram-proxy] 直连连续失败已熔断 10 分钟（期间仅走代理，不再尝试直连回退）");
          }
          attachDiag(directError);
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
