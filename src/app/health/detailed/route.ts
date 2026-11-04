import { NextResponse } from "next/server";
import { queryOne } from "@/database/client";
import { getCaptchaProvider } from "@/captcha/factory";
import { config } from "@/config/settings";
import { APP_VERSION } from "@/lib/app-version";

interface HealthCheck {
  status: string;
  error?: string;
  provider?: string;
}

export async function GET() {
  const healthStatus: {
    status: string;
    timestamp: string;
    service: string;
    version: string;
    checks: Record<string, HealthCheck>;
  } = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "TGuard API",
    version: APP_VERSION,
    checks: {},
  };

  try {
    await queryOne("SELECT 1 AS ok");
    healthStatus.checks.database = { status: "healthy" };
  } catch (error) {
    console.error("Database health check failed:", error);
    healthStatus.checks.database = { status: "unhealthy", error: "database unavailable" };
    healthStatus.status = "unhealthy";
  }

  try {
    const captchaProvider = await getCaptchaProvider();
    healthStatus.checks.captcha = {
      status: "healthy",
      provider: captchaProvider.providerName,
    };
  } catch (error) {
    console.error("Captcha provider health check failed:", error);
    healthStatus.checks.captcha = {
      status: "unhealthy",
      error: "captcha provider unavailable",
    };
    healthStatus.status = "unhealthy";
  }

  try {
    if (!config.bot.token || config.bot.token === "YOUR_BOT_TOKEN_HERE") {
      throw new Error("Bot token not configured");
    }

    const captchaConfig =
      config.captcha[config.captcha.provider as keyof typeof config.captcha];
    const siteKey = (captchaConfig as { siteKey?: string }).siteKey;
    const secretKey = (captchaConfig as { secretKey?: string }).secretKey;
    if (!siteKey || !secretKey) {
      throw new Error("Captcha keys not configured");
    }

    healthStatus.checks.configuration = { status: "healthy" };
  } catch (error) {
    healthStatus.checks.configuration = {
      status: "unhealthy",
      error: error instanceof Error ? error.message : String(error),
    };
    healthStatus.status = "unhealthy";
  }

  if (healthStatus.status === "unhealthy") {
    return NextResponse.json(healthStatus, { status: 503 });
  }

  return NextResponse.json(healthStatus);
}
