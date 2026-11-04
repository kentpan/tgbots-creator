import { NextResponse } from "next/server";
import { getCaptchaProvider } from "@/captcha/factory";

export async function GET() {
  try {
    const captchaProvider = await getCaptchaProvider();
    const captchaConfig = captchaProvider.getFrontendConfig();

    return NextResponse.json({
      captcha: captchaConfig,
      provider: captchaProvider.providerName,
    });
  } catch (error) {
    console.error("Error getting captcha config:", error);
    return NextResponse.json({ detail: "无法获取验证配置" }, { status: 500 });
  }
}
