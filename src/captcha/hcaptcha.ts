import { CaptchaProvider, CaptchaVerificationResult } from "./base";

export class HCaptchaProvider extends CaptchaProvider {
  static readonly VERIFY_URL = "https://hcaptcha.com/siteverify";

  get providerName(): string {
    return "hcaptcha";
  }

  async verify(
    response: string,
    remoteIp?: string | null,
  ): Promise<CaptchaVerificationResult> {
    const data: Record<string, string> = {
      secret: this.secretKey,
      response,
      sitekey: this.siteKey,
    };
    if (remoteIp) {
      data.remoteip = remoteIp;
    }

    return this.siteverify(HCaptchaProvider.VERIFY_URL, { data });
  }

  getFrontendConfig(): Record<string, unknown> {
    return {
      provider: "hcaptcha",
      siteKey: this.siteKey,
      theme: "light",
      size: "normal",
    };
  }
}
