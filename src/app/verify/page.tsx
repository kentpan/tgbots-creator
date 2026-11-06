import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCaptchaProvider } from "@/captcha/factory";
import { getGroupSettings, getVerificationSession, isSessionExpired } from "@/database/operations";
import { WebAppLoader } from "@/components/tg/web-app-loader";
import { VerifyClient, type CaptchaConfig } from "./verify-client";
import { CodeVerifyClient } from "./code-verify-client";
import { CompletedState, ErrorState, ExpiredState } from "./states";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "入群验证",
};

interface VerifyPageProps {
  searchParams: Promise<{ token?: string }>;
}

type VerifyView =
  | { kind: "notfound" }
  | { kind: "expired" }
  | { kind: "completed"; inGroup: boolean }
  | { kind: "verify"; token: string; expectedUserId: number; captchaConfig: CaptchaConfig }
  | {
      kind: "code";
      token: string;
      methodLabel: string;
      expiresInSeconds: number;
      chatTitle: string | null;
      maxAttempts: number;
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
        view = { kind: "completed", inGroup: session.channel === "group" };
      } else if (session.method === "code_api" || session.method === "code_self") {
        // v2.1.0：群内验证的「不泄露给其他群成员」输码通道 —— 验证码只在网页里输入
        const settings = await getGroupSettings(session.chatId);
        view = {
          kind: "code",
          token,
          methodLabel:
            session.method === "code_self" ? "自动验证码" : "外部 API 卡密 / 验证码",
          expiresInSeconds: Math.max(
            0,
            Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
          ),
          chatTitle: settings?.chatTitle ?? null,
          maxAttempts: settings?.maxAttempts ?? 3,
        };
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
          <CompletedState
            message={
              view.inGroup
                ? "您已完成验证，可以返回群组聊天了"
                : "您已完成验证，请等待管理员审核"
            }
          />
        </>
      );
    case "code":
      return (
        <>
          <WebAppLoader />
          <CodeVerifyClient
            token={view.token}
            methodLabel={view.methodLabel}
            expiresInSeconds={view.expiresInSeconds}
            chatTitle={view.chatTitle}
            maxAttempts={view.maxAttempts}
          />
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
