import { CaptchaProvider, CaptchaVerificationResult } from "./base";

export class TurnstileProvider extends CaptchaProvider {
  static readonly VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  get providerName(): string {
    return "turnstile";
  }

  async verify(
    response: string,
    remoteIp?: string | null,
  ): Promise<CaptchaVerificationResult> {
    const data: Record<string, string> = {
      secret: this.secretKey,
      response,
    };
    if (remoteIp) {
      data.remoteip = remoteIp;
    }

    return this.siteverify(TurnstileProvider.VERIFY_URL, { data });
  }

  getFrontendConfig(): Record<string, unknown> {
    return {
      provider: "turnstile",
      siteKey: this.siteKey,
      theme: "light",
      size: "normal",
      language: "zh-CN",
    };
  }
}
