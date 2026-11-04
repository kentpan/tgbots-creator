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
  | { kind: "verify"; token: string; expectedUserId: number; captchaConfig: CaptchaConfig }
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
        const captchaProvider = await getCaptchaProvider();
        const captchaConfig = captchaProvider.getFrontendConfig() as unknown as CaptchaConfig;
        view = {
          kind: "verify",
          token,
          expectedUserId: Number(session.userId),
          captchaConfig,
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
          />
        </>
      );
    case "error":
      return <ErrorState message="页面加载失败，请稍后重试" />;
  }
}
