export interface CaptchaVerificationResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  score?: number;
  challengeTs?: string;
  hostname?: string;
  extraData?: Record<string, unknown>;
}

export const ERROR_MESSAGES: Record<string, string> = {
  "missing-input-secret": "配置错误：缺少密钥",
  "invalid-input-secret": "配置错误：无效密钥",
  "sitekey-secret-mismatch": "配置错误：密钥不匹配",
  "missing-input-response": "请完成验证",
  "invalid-input-response": "验证已过期，请重新验证",
  "invalid-or-already-seen-response": "验证已过期或已使用，请重新验证",
  "timeout-or-duplicate": "验证超时或重复提交",
  "bad-request": "请求格式错误",
  "network-error": "网络连接失败，请重试",
  "http-error": "验证服务暂时不可用，请稍后重试",
  "internal-error": "服务器内部错误，请稍后重试",
};

export const DEFAULT_ERROR_MESSAGE = "验证失败，请重试";

export function failure(
  errorCode: string,
  extraData?: Record<string, unknown>,
): CaptchaVerificationResult {
  return {
    success: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode] ?? DEFAULT_ERROR_MESSAGE,
    extraData,
  };
}

export interface SiteverifyOptions {
  data?: Record<string, string>;
  json?: Record<string, unknown>;
}

export abstract class CaptchaProvider {
  readonly siteKey: string;
  readonly secretKey: string;
  readonly timeout: number;

  constructor(siteKey: string, secretKey: string, timeout = 30) {
    this.siteKey = siteKey;
    this.secretKey = secretKey;
    this.timeout = timeout * 1000;
  }

  abstract get providerName(): string;

  abstract verify(
    response: string,
    remoteIp?: string | null,
    userAgent?: string | null,
  ): Promise<CaptchaVerificationResult>;

  abstract getFrontendConfig(): Record<string, unknown>;

  protected async siteverify(
    url: string,
    options: SiteverifyOptions = {},
  ): Promise<CaptchaVerificationResult> {
    let result: Record<string, unknown>;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "User-Agent": "TGuard/1.0",
            ...(options.json
              ? { "Content-Type": "application/json" }
              : { "Content-Type": "application/x-www-form-urlencoded" }),
          },
          body: options.json
            ? JSON.stringify(options.json)
            : new URLSearchParams(options.data ?? {}).toString(),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return failure("http-error");
      }
      result = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof TypeError) {
        return failure("network-error");
      }
      return failure("internal-error");
    }

    if (result.success) {
      return {
        success: true,
        challengeTs: result.challenge_ts as string | undefined,
        hostname: result.hostname as string | undefined,
        score: result.score as number | undefined,
        extraData: result,
      };
    }

    const errorCodes = (result["error-codes"] as string[] | undefined) ?? ["verification-failed"];
    return failure(errorCodes[0], result);
  }
}
