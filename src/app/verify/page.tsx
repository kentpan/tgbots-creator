import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCaptchaProvider } from "@/captcha/factory";
import { getVerificationSession, isSessionExpired } from "@/database/operations";
import { WebAppLoader } from "@/components/tg/web-app-loader";
import { VerifyClient, type CaptchaConfig } from "./verify-client";
import { CompletedState, ErrorState, ExpiredState } from "./states";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "人机验证",
};

interface VerifyPageProps {
  searchParams: Promise<{ token?: string }>;
}

type VerifyView =
  | { kind: "notfound" }
  | { kind: "expired" }
  | { kind: "completed" }
  | {
      kind: "verify";
      token: string;
      expectedUserId: number;
      captchaConfig: CaptchaConfig;
      method: string;
    }
  | { kind: "error" };

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const { token } = await searchParams;

  let view: VerifyView = { kind: "notfound" };

  try {
    if (token) {
      const session = await getVerificationSession(token);
      if (!session) {
        view = { kind: "notfound" };
      } else if (isSessionExpired(session)) {
        view = { kind: "expired" };
      } else if (session.captchaCompleted) {
        view = { kind: "completed" };
      } else {
        // v2.1.4 修复验证页整体报错：验证码 provider 仅在会话真正需要人机验证组件时
        // 初始化（method=captcha），与 POST /api/v1/verify 的会话方式分支同源。
        // code_api/code_self 是网页输码通道（verify-client codeMode，不渲染任何
        // 验证码组件）；此前无条件初始化，Edge/Cloudflare 形态下 config.toml 不存在、
        // provider 配置为空 → createCaptchaProvider 抛 "Missing configuration" →
        // 整个验证页进入错误态。输码会话无需任何验证码配置。
        const codeMode = session.method === "code_api" || session.method === "code_self";
        const captchaConfig: CaptchaConfig = codeMode
          ? { provider: "none" }
          : ((await getCaptchaProvider()).getFrontendConfig() as unknown as CaptchaConfig);
        view = {
          kind: "verify",
          token,
          expectedUserId: Number(session.userId),
          captchaConfig,
          method: session.method,
        };
      }
    }
  } catch (error) {
    console.error("Error serving verification page:", error);
    view = { kind: "error" };
  }

  switch (view.kind) {
    case "notfound":
      notFound();
      return null;
    case "expired":
      return (
        <>
          <WebAppLoader />
          <ExpiredState message="验证链接已过期，请重新申请加群" />
        </>
      );
    case "completed":
      return (
        <>
          <WebAppLoader />
          <CompletedState message="您已完成验证，请等待管理员审核" />
        </>
      );
    case "verify":
      return (
        <>
          <WebAppLoader />
          <VerifyClient
            token={view.token}
            expectedUserId={view.expectedUserId}
            captchaConfig={view.captchaConfig}
            apiBaseUrl=""
            method={view.method}
          />
        </>
      );
    case "error":
      return <ErrorState message="页面加载失败，请稍后重试" />;
  }
}
