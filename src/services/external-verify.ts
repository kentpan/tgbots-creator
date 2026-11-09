export interface CodeApiConfig {
  url: string;
  api_key: string;
  http_method: string;
  /** 卡密字段名（POST 请求体 / GET 查询参数中承载验证码的字段，兼容 code / card / key） */
  code_field?: string;
  body_template?: string;
  success_status: number;
  success_field?: string;
  success_value: string;
  timeout_seconds: number;
  rads_base_url?: string;
  rads_issue_key?: string;
  rads_script_id?: number;
  rads_title?: string;
  rads_price?: number;
  rads_max_uses?: number;
}

export interface ExternalVerifyInput {
  userId: bigint;
  username: string | null;
  code: string;
}

export interface ExternalVerifyResult {
  ok: boolean;
  message: string;
  /**
   * true = 网络/超时等基础设施故障（请求未到达验证接口或响应未返回），
   * 与「卡密核验未通过」有本质区别：调用方绝不应计入用户尝试次数。
   */
  networkError: boolean;
  /**
   * v2.1.8：网络故障的具体原因（供调用方在提示中展示，便于管理员排查配置）。
   * 仅 networkError=true 时可能有值；不含验证接口 URL（避免泄露内部拓扑）。
   */
  detail?: string;
}

export interface ExternalVerifyHooks {
  /**
   * 第一次因网络错误发起服务端重试前触发一次（bot 路径用于立即回复
   * 「网络波动，正在重试...」，让用户感知到服务端在自动处理）。
   */
  onNetworkRetry?: () => void | Promise<void>;
}

/**
 * 验证接口网络错误的服务端自动重试次数（连接级失败才重试；含首次共 5 次尝试，
 * 5 次都失败才返回网络异常）。
 *
 * v2.1.8 由 3 次提高到 5 次 + 递增间隔（1s/2s/4s/8s，总跨度 ~15s）：实测部署环境
 * （沙盒/受限出站网络）到验证接口的路由故障成片出现——瞬时连接失败（~0.6s 内
 * ETIMEDOUT/ECONNRESET）与正常请求交替，坏窗口可持续数十秒；原 3 次 × 固定 1s
 * 间隔（总跨度 ~2s）几乎必然整批落在同一坏窗口内全部失败，用户侧表现为
 * 「一直网络波动」。递增跨窗重试后，单次验证能跨越多个坏窗口，成功率大幅提升。
 */
export const VERIFY_NETWORK_RETRY_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * v2.1.8：把 fetch 抛出的底层错误翻译为可读的失败原因（供管理员排查验证接口配置）。
 * Node fetch 的 message 是笼统的 "fetch failed"，具体原因在 error.cause.code 里；
 * 其他运行时（bun / Cloudflare workerd）的 cause.code 缺失但 message 可读，一并兼容。
 */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const code = cause?.code ?? "";
  const causeMessage = cause?.message ?? error.message ?? "";
  if (error.name === "TimeoutError" || code === "ABORT_ERR") {
    return "请求超时（验证接口无响应）";
  }
  if (
    code === "ECONNREFUSED" ||
    /unable to connect|connection refused|connect ECONNREFUSED/i.test(causeMessage)
  ) {
    return "连接被拒绝（验证接口服务未启动或端口未监听）";
  }
  if (code === "ETIMEDOUT") {
    // TCP 连接建立阶段超时（SYN 无应答 / 出站防火墙拦截），与「响应超时」（应用层
    // AbortSignal.timeout）不同：请求根本没有发出去，属于路由不可达类故障
    return "连接超时（到验证接口的网络路由不可达或被拦截）";
  }
  if (code === "ENOTFOUND" || /getaddrinfo ENOTFOUND|dns lookup/i.test(causeMessage)) {
    return "域名解析失败（验证接口地址不可达）";
  }
  if (code === "ECONNRESET" || /connection (was )?reset/i.test(causeMessage)) {
    return "连接被重置";
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || /host unreachable|network unreachable/i.test(causeMessage)) {
    return "网络不可达";
  }
  if (code.startsWith("ERR_TLS") || code.startsWith("UNABLE_TO_VERIFY") || code === "CERT_HAS_EXPIRED" || /certificate|TLS/i.test(causeMessage)) {
    return "TLS/证书校验失败";
  }
  return causeMessage || error.message;
}

export function parseCodeApiConfig(raw: string): CodeApiConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CodeApiConfig>;
    if (typeof parsed.url !== "string" || !parsed.url.trim()) return null;
    if (typeof parsed.api_key !== "string" || !parsed.api_key.trim()) return null;
    return {
      url: parsed.url.trim(),
      api_key: parsed.api_key.trim(),
      http_method: (parsed.http_method ?? "POST").toUpperCase() === "GET" ? "GET" : "POST",
      code_field:
        typeof parsed.code_field === "string" && parsed.code_field.trim()
          ? parsed.code_field.trim()
          : "code",
      body_template: typeof parsed.body_template === "string" ? parsed.body_template : undefined,
      success_status:
        typeof parsed.success_status === "number" && parsed.success_status > 0
          ? parsed.success_status
          : 200,
      success_field: typeof parsed.success_field === "string" ? parsed.success_field : "valid",
      success_value:
        parsed.success_value === undefined ? "true" : String(parsed.success_value),
      timeout_seconds:
        typeof parsed.timeout_seconds === "number" && parsed.timeout_seconds > 0
          ? parsed.timeout_seconds
          : 10,
      rads_base_url:
        typeof parsed.rads_base_url === "string" && parsed.rads_base_url.trim()
          ? parsed.rads_base_url.trim().replace(/\/$/, "")
          : undefined,
      rads_issue_key:
        typeof parsed.rads_issue_key === "string" && parsed.rads_issue_key.trim()
          ? parsed.rads_issue_key.trim()
          : undefined,
      rads_script_id:
        typeof parsed.rads_script_id === "number" && parsed.rads_script_id > 0
          ? Math.floor(parsed.rads_script_id)
          : undefined,
      rads_title:
        typeof parsed.rads_title === "string" && parsed.rads_title.trim()
          ? parsed.rads_title.trim()
          : undefined,
      rads_price:
        typeof parsed.rads_price === "number" && parsed.rads_price >= 0
          ? parsed.rads_price
          : undefined,
      rads_max_uses:
        typeof parsed.rads_max_uses === "number" && parsed.rads_max_uses >= 1
          ? Math.floor(parsed.rads_max_uses)
          : undefined,
    };
  } catch {
    return null;
  }
}

function renderTemplate(template: string, input: ExternalVerifyInput): string {
  return template
    .replaceAll("{{user_id}}", String(input.userId))
    .replaceAll("{{code}}", input.code)
    .replaceAll("{{username}}", input.username ?? "");
}

function readJsonPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function verifyCodeExternally(
  config: CodeApiConfig,
  input: ExternalVerifyInput,
  hooks?: ExternalVerifyHooks,
): Promise<ExternalVerifyResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
  };

  let url = config.url;
  let body: string | undefined;

  if (config.http_method === "GET") {
    const query = new URLSearchParams({
      user_id: String(input.userId),
      [config.code_field ?? "code"]: input.code,
      username: input.username ?? "",
    });
    url = `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
  } else {
    headers["Content-Type"] = "application/json";
    body = config.body_template
      ? renderTemplate(config.body_template, input)
      : JSON.stringify({
          user_id: Number(input.userId),
          [config.code_field ?? "code"]: input.code,
          username: input.username,
        });
  }

  let response: Response | null = null;
  let lastError = "";
  let lastNetworkError: unknown = null;
  let timedOut = false;
  // 网络错误服务端自动重试（含首次共 VERIFY_NETWORK_RETRY_ATTEMPTS 次尝试，
  // 全部失败才返回网络异常）：仅对「请求确定未到达服务端」的连接级错误
  // （fetch failed / DNS 解析失败 / 连接被拒 / 连接超时）重试，这类失败重试
  // 不会造成重复核销；重试间隔递增（1s/2s/4s/8s）跨越路由坏窗口（v2.1.8，
  // 实测坏窗口可持续数十秒，固定 1s 间隔整批必败）。
  // 超时（TimeoutError）绝不重试：验证接口具有核销语义，请求可能已被服务端处理并核销，
  // 重试会导致重复核销（表现为「卡密已被使用」）——网络错误不计入用户尝试次数后，
  // 超时时让用户重新发送验证码即可，用户无任何损失。
  for (let attempt = 1; attempt <= VERIFY_NETWORK_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      if (attempt === 2) {
        await hooks?.onNetworkRetry?.();
      }
      // 递增退避：1s / 2s / 4s / 8s（attempt 2..5），总跨度 ~15s
      await sleep(1000 * Math.pow(2, attempt - 2));
    }
    try {
      // 传输通道说明（2026-11-03 实测结论，勿改回代理）：
      // 本调用必须直连验证接口。系统代理（telegram.proxy_url，前缀式网关）把请求的
      // Authorization 头用于自身 Basic 认证并整头剥离不转发——实测四种姿势全部失败：
      // ① Basic+Bearer 双写 → 401「代理认证失败」；② 仅 Basic → 上游 401「缺少
      // Authorization: Bearer」；③ Proxy-Authorization 头 → 401「代理认证失败」；
      // ④ 凭据内嵌代理路径 → 401「代理认证失败」。验证接口强制要求 Bearer apikey，
      // 两者在同一个 Authorization 头上不可调和，走代理 = 每一笔验证都被上游 401 拒绝。
      // 直连实测连通（Cloudflare Pages，延迟 2.9s~24.5s 波动），timeout_seconds 已适配。
      response = await fetch(url, {
        method: config.http_method,
        headers,
        body,
        signal: AbortSignal.timeout(config.timeout_seconds * 1000),
      });
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastNetworkError = error;
      if (error instanceof Error && error.name === "TimeoutError") {
        timedOut = true;
        break;
      }
    }
  }
  if (!response) {
    const detail = timedOut
      ? `验证接口响应超时（${config.timeout_seconds} 秒）`
      : lastNetworkError
        ? describeNetworkError(lastNetworkError)
        : lastError || "未知错误";
    console.error(
      `verifyCodeExternally network failure after ${VERIFY_NETWORK_RETRY_ATTEMPTS} attempts: ${detail} (url=${config.url})`,
    );
    return {
      ok: false,
      networkError: true,
      message: timedOut
        ? `网络异常：验证接口响应超时（${config.timeout_seconds} 秒），请稍后重试`
        : "网络异常，请稍后重试",
      detail,
    };
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (response.status >= 500 && response.status <= 599) {
    // 验证接口服务端故障（5xx）：同样属于基础设施问题而非用户输入错误，不计入用户尝试次数。
    // 不自动重试：POST 核验语义下无法确认服务端是否已核销该卡密，重试可能造成重复核销。
    return {
      ok: false,
      networkError: true,
      message: `网络异常：验证接口服务故障（HTTP ${response.status}），请稍后重试`,
      detail: `验证接口返回 HTTP ${response.status}`,
    };
  }

  if (response.status !== config.success_status) {
    // 兼容 error / msg / message 等常见错误字段，把外部 API 的失败原因透传给用户
    const apiError =
      payload && typeof payload === "object"
        ? (["error", "msg", "message"]
            .map((key) => (payload as Record<string, unknown>)[key])
            .find((value) => typeof value === "string" && value.trim()) as string | undefined)?.trim() ?? ""
        : "";
    return {
      ok: false,
      networkError: false,
      message: apiError ? `核验未通过：${apiError}` : `验证接口返回状态码 ${response.status}`,
    };
  }

  if (config.success_field) {
    const actual = readJsonPath(payload, config.success_field);
    if (actual === undefined) {
      console.error(
        `verifyCodeExternally rejected: response missing success field "${config.success_field}" (HTTP ${response.status}, body=${text.slice(0, 500)})`,
      );
      return { ok: false, networkError: false, message: "验证接口响应缺少判定字段，已拒绝通过" };
    }
    const expected = (config.success_value ?? "true").toLowerCase();
    if (String(actual).trim().toLowerCase() !== expected) {
      // HTTP 200 但判定字段不匹配（如 { success: false, msg: "验证失败: 卡密不存在" }），
      // 透传外部 API 的 msg/error/message 失败原因，与 401/403/429 路径保持一致
      const apiReason =
        payload && typeof payload === "object"
          ? (["msg", "message", "error"]
              .map((key) => (payload as Record<string, unknown>)[key])
              .find((value) => typeof value === "string" && value.trim()) as string | undefined)?.trim() ?? ""
          : "";
      return {
        ok: false,
        networkError: false,
        message: apiReason ? `核验未通过：${apiReason}` : "验证码校验未通过",
      };
    }
    return { ok: true, networkError: false, message: "验证成功" };
  }

  // 严格拒绝兜底：响应既无判定字段也不可识别时绝不默认放行（安全红线）。
  // 正常配置下 parseCodeApiConfig 保证 success_field 恒存在，此处仅为防御未来配置回归。
  console.error(
    `verifyCodeExternally rejected: unrecognized response (HTTP ${response.status}, body=${text.slice(0, 500)})`,
  );
  return { ok: false, networkError: false, message: "验证接口响应无法识别，已拒绝通过" };
}
