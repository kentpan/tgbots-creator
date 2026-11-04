import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import { CaptchaProvider } from "./base";
import { CapProvider } from "./cap";
import { HCaptchaProvider } from "./hcaptcha";
import { TurnstileProvider } from "./turnstile";

type CaptchaProviderConstructor = new (...args: never[]) => CaptchaProvider;

const CAPTCHA_PROVIDERS: Record<string, CaptchaProviderConstructor> = {
  hcaptcha: HCaptchaProvider,
  cap: CapProvider,
  turnstile: TurnstileProvider,
};

export async function createCaptchaProvider(providerOverride?: string): Promise<CaptchaProvider> {
  const runtime = providerOverride ? null : await getRuntimeSettings(config);
  const providerName = (
    providerOverride ?? runtime?.captchaProvider ?? config.captcha.provider
  ).toLowerCase();

  const ProviderClass = CAPTCHA_PROVIDERS[providerName];
  if (!ProviderClass) {
    const available = Object.keys(CAPTCHA_PROVIDERS).join(", ");
    throw new Error(`Unknown captcha provider: ${providerName}. Available providers: ${available}`);
  }

  const providerConfig = config.captcha[providerName as keyof typeof config.captcha] as unknown as Record<
    string,
    unknown
  >;
  const kwargs: Record<string, unknown> = {
    siteKey: providerConfig.siteKey,
    secretKey: providerConfig.secretKey,
    timeout: config.captcha.timeoutSeconds,
  };
  if (providerName === "cap") {
    kwargs.serverUrl = providerConfig.serverUrl;
  }

  const missing = (["serverUrl", "siteKey", "secretKey"] as const).filter(
    (key) => key in kwargs && !kwargs[key],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing configuration for ${providerName}. Please set ${missing.join(", ")} in config.toml`,
    );
  }

  const provider =
    providerName === "cap"
      ? new CapProvider(
          kwargs.serverUrl as string,
          kwargs.siteKey as string,
          kwargs.secretKey as string,
          kwargs.timeout as number,
        )
      : providerName === "hcaptcha"
        ? new HCaptchaProvider(
            kwargs.siteKey as string,
            kwargs.secretKey as string,
            kwargs.timeout as number,
          )
        : new TurnstileProvider(
            kwargs.siteKey as string,
            kwargs.secretKey as string,
            kwargs.timeout as number,
          );

  return provider;
}

const globalForCaptcha = globalThis as unknown as {
  botGroupsCaptchaProviders?: Map<string, CaptchaProvider>;
};

export async function getCaptchaProvider(): Promise<CaptchaProvider> {
  if (!globalForCaptcha.botGroupsCaptchaProviders) {
    globalForCaptcha.botGroupsCaptchaProviders = new Map();
  }
  const runtime = await getRuntimeSettings(config);
  const providerName = runtime.captchaProvider.toLowerCase();
  const cache = globalForCaptcha.botGroupsCaptchaProviders;
  const cached = cache.get(providerName);
  if (cached) return cached;
  const provider = await createCaptchaProvider(providerName);
  cache.set(providerName, provider);
  return provider;
}
