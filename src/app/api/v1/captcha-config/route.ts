import { NextResponse } from "next/server";
import { getCaptchaProvider } from "@/captcha/factory";

// OpenNext(nodejs 运行时)构建会把无动态 API 的 GET handler 静态预渲染 ——
// 本接口读取数据库验证配置, 必须逐请求执行, 禁止构建期烘焙结果
// (构建期 CI 无数据库, 预渲染必然产出静态 500; Edge 形态恒动态, 无行为差异)。
export const dynamic = "force-dynamic";

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
