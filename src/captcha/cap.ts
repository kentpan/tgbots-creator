import { CaptchaProvider, CaptchaVerificationResult } from "./base";

export class CapProvider extends CaptchaProvider {
  readonly serverUrl: string;

  constructor(serverUrl: string, siteKey: string, secretKey: string, timeout = 30) {
    super(siteKey, secretKey, timeout);
    this.serverUrl = serverUrl.replace(/\/+$/, "");
  }

  get providerName(): string {
    return "cap";
  }

  async verify(response: string): Promise<CaptchaVerificationResult> {
    return this.siteverify(`${this.serverUrl}/${this.siteKey}/siteverify`, {
      json: { secret: this.secretKey, response },
    });
  }

  getFrontendConfig(): Record<string, unknown> {
    return {
      provider: "cap",
      server_url: this.serverUrl,
      site_key: this.siteKey,
      endpoint: `${this.serverUrl}/${this.siteKey}/`,
    };
  }
}
