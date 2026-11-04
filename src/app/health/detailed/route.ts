import { NextResponse } from "next/server";
import { queryOne } from "@/database/client";
import { getCaptchaProvider } from "@/captcha/factory";
import { config } from "@/config/settings";
import { APP_VERSION } from "@/lib/app-version";

// OpenNext(nodejs 运行时)构建会把无动态 API 的 GET handler 静态预渲染 ——
// 本接口依赖数据库/captcha 运行时状态, 必须逐请求执行, 禁止构建期烘焙结果
// (Edge 形态恒动态, 此声明在 Edge 下无行为差异, 仅约束 nodejs 形态)。
export const dynamic = "force-dynamic";

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
