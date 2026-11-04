"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Script from "next/script";
import { hapticError, hapticSuccess, getTg } from "@/lib/webapp";

export interface CaptchaConfig {
  provider: string;
  siteKey?: string;
  theme?: string;
  size?: string;
  language?: string;
  server_url?: string;
  site_key?: string;
  endpoint?: string;
}

interface VerifyClientProps {
  token: string;
  expectedUserId: number;
  captchaConfig: CaptchaConfig;
  apiBaseUrl: string;
}

interface TgMessage {
  icon: string;
  cardClass: string;
  textClass: string;
  text: string;
}

export function VerifyClient({ token, expectedUserId, captchaConfig, apiBaseUrl }: VerifyClientProps) {
  const captchaResponseRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const hcaptchaContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const capWidgetRef = useRef<HTMLElement | null>(null);
  const submitRef = useRef<() => void>(() => {});

  const [identityFailed, setIdentityFailed] = useState(false);
  const [message, setMessage] = useState<TgMessage | null>(null);

  const showMessage = useCallback((text: string, icon: string, cardClass: string, textClass: string) => {
    setMessage({ icon, cardClass, textClass, text });
  }, []);

  const showSuccess = useCallback(
    (text: string) => showMessage(text, "✅", "success-animation", "text-green-600"),
    [showMessage],
  );

  const showError = useCallback(
    (text: string) => showMessage(text, "❌", "error-shake", "text-red-600"),
    [showMessage],
  );

  const submitVerification = useCallback(async () => {
    if (!captchaResponseRef.current) {
      showError("请先完成人机验证");
      hapticError();
      return;
    }

    showSuccess("🔄 验证中，请稍候...");

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          captcha_response: captchaResponseRef.current,
          user_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id ?? null,
          init_data: window.Telegram?.WebApp?.initData ?? null,
        }),
      });

      const result = (await response.json()) as {
        success?: boolean;
        message?: string;
        detail?: string;
        redirect_url?: string | null;
      };

      if (response.ok && result.success) {
        showSuccess(result.message ?? "✅ 验证成功！");
        hapticSuccess();

        const tg = getTg();
        setTimeout(() => {
          showSuccess("🎉 验证成功！点击下方 Telegram 按钮关闭页面");

          if (tg) {
            tg.MainButton.setText("🎉 关闭页面");
            tg.MainButton.show();
            tg.MainButton.enable();

            tg.MainButton.offClick();
            tg.MainButton.onClick(() => {
              if (result.redirect_url) {
                try {
                  window.location.href = result.redirect_url;
                  setTimeout(() => tg.close(), 1000);
                } catch {
                  tg.close();
                }
              } else {
                tg.close();
              }
            });
          }
        }, 500);
      } else {
        throw new Error(result.detail || result.message || "验证失败");
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "网络错误，请重试");
      hapticError();

      if (captchaConfig.provider === "hcaptcha" && window.hcaptcha) {
        window.hcaptcha.reset();
      } else if (captchaConfig.provider === "turnstile" && window.turnstile) {
        window.turnstile.reset("#turnstile-container");
      } else if (captchaConfig.provider === "cap") {
        const capWidget = capWidgetRef.current;
        if (capWidget && typeof (capWidget as unknown as { reset?: () => void }).reset === "function") {
          (capWidget as unknown as { reset: () => void }).reset();
        }
      }
      captchaResponseRef.current = null;
    }
  }, [apiBaseUrl, captchaConfig.provider, showError, showSuccess, token]);

  // 提交入口经由 ref 供外部（Telegram MiniApp 按钮/定时器）调用；
  // 在 effect 中挂载以满足 React 严格模式（渲染期禁止写 ref）
  useEffect(() => {
    submitRef.current = () => {
      void submitVerification();
    };
  });

  useEffect(() => {
    const tg = getTg();
    const telegramUserId = tg?.initDataUnsafe?.user?.id ?? null;

    if (telegramUserId !== null && telegramUserId !== expectedUserId) {
      // 外部系统（Telegram initData）校验失败 → 进入失败态（合法的 effect 副作用）
      // eslint-disable-next-line react-hooks/set-state-in-effect
      showError("用户身份验证失败，此验证链接不属于您");
      hapticError();
      setIdentityFailed(true);
    }
  }, [expectedUserId, showError]);

  useEffect(() => {
    const tg = getTg();
    if (!tg) return;
    tg.BackButton.onClick(() => {
      tg.close();
    });
    tg.BackButton.show();
    return () => {
      tg.BackButton.offClick();
      tg.BackButton.hide();
    };
  }, []);

  const handleCaptchaSolved = useCallback((response: string) => {
    captchaResponseRef.current = response;
    hapticSuccess();
    setTimeout(() => {
      if (captchaResponseRef.current) {
        submitRef.current();
      }
    }, 2000);
  }, []);

  const handleCaptchaError = useCallback(() => {
    showError("验证组件加载失败，请刷新页面重试");
    hapticError();
  }, [showError]);

  useEffect(() => {
    if (captchaConfig.provider === "hcaptcha") {
      const timer = setInterval(() => {
        if (window.hcaptcha && hcaptchaContainerRef.current) {
          clearInterval(timer);
          try {
            window.hcaptcha.render(hcaptchaContainerRef.current, {
              sitekey: captchaConfig.siteKey ?? "",
              theme: captchaConfig.theme ?? "light",
              size: captchaConfig.size ?? "normal",
              callback: (response: string) => handleCaptchaSolved(response),
              "expired-callback": () => {
                captchaResponseRef.current = null;
              },
              "error-callback": () => handleCaptchaError(),
            });
          } catch {
            showError("验证组件初始化失败，请刷新页面重试");
          }
        }
      }, 100);

      const timeout = setTimeout(() => {
        if (!window.hcaptcha) {
          clearInterval(timer);
          showError("验证组件加载超时，请检查网络连接");
        }
      }, 10000);

      return () => {
        clearInterval(timer);
        clearTimeout(timeout);
      };
    }

    if (captchaConfig.provider === "turnstile") {
      const timer = setInterval(() => {
        if (window.turnstile && turnstileContainerRef.current) {
          clearInterval(timer);
          try {
            window.turnstile.render(turnstileContainerRef.current, {
              sitekey: captchaConfig.siteKey ?? "",
              theme: captchaConfig.theme ?? "light",
              size: captchaConfig.size ?? "normal",
              language: captchaConfig.language ?? "zh-CN",
              callback: (token: string) => handleCaptchaSolved(token),
              "expired-callback": () => {
                captchaResponseRef.current = null;
              },
              "error-callback": () => handleCaptchaError(),
            });
          } catch {
            showError("验证组件初始化失败，请刷新页面重试");
          }
        }
      }, 100);

      const timeout = setTimeout(() => {
        if (!window.turnstile) {
          clearInterval(timer);
          showError("验证组件加载超时，请检查网络连接");
        }
      }, 10000);

      return () => {
        clearInterval(timer);
        clearTimeout(timeout);
      };
    }

    if (captchaConfig.provider === "cap") {
      let checkCount = 0;
      const timer = setInterval(() => {
        checkCount++;
        const capWidget = capWidgetRef.current;
        if ((typeof customElements !== "undefined" && customElements.get("cap-widget")) || checkCount > 50) {
          clearInterval(timer);
          if (capWidget) {
            capWidget.addEventListener("solve", ((event: CustomEvent<{ token: string }>) => {
              handleCaptchaSolved(event.detail.token);
            }) as EventListener);
            capWidget.addEventListener("error", ((event: CustomEvent<{ code?: string; message?: string }>) => {
              console.error("Cap.js error:", event.detail?.code, event.detail?.message);
              handleCaptchaError();
            }) as EventListener);
            capWidget.addEventListener("reset", () => {
              captchaResponseRef.current = null;
            });
          } else {
            showError("验证组件初始化失败，请刷新页面重试");
          }
        }
      }, 100);

      return () => clearInterval(timer);
    }
  }, [captchaConfig, handleCaptchaError, handleCaptchaSolved, showError]);

  return (
    <div className="tg-page min-h-screen flex flex-col">
      {captchaConfig.provider === "hcaptcha" && (
        <Script src="https://js.hcaptcha.com/1/api.js" strategy="afterInteractive" />
      )}
      {captchaConfig.provider === "cap" && (
        <Script
          src="https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.58/cap.min.js"
          strategy="afterInteractive"
          integrity="sha384-KhjwzP/vdfVipXU8YRs7tdYICX7Bcpl4biGuQZgNkwICZe/3Xm7KKezqHn/1SZWX"
          crossOrigin="anonymous"
        />
      )}
      {captchaConfig.provider === "turnstile" && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
        />
      )}

      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card">
          <div className="text-center mb-8">
            <div className="text-6xl mb-4">🔐</div>
            <h1 className="text-2xl font-bold mb-2 text-fg">人机验证</h1>
            <p className="text-fg-secondary">请完成下方的人机验证</p>
          </div>

          <div className="space-y-6" id="verificationContainer">
            <div className="flex justify-center">
              {identityFailed ? (
                <div className="text-center text-red-600">❌ 用户身份验证失败</div>
              ) : (
                <>
                  {captchaConfig.provider === "hcaptcha" && (
                    <div
                      id="hcaptcha-container"
                      ref={hcaptchaContainerRef}
                      className="tg-captcha-container"
                    />
                  )}
                  {captchaConfig.provider === "cap" && (
                    <cap-widget
                      ref={capWidgetRef}
                      data-cap-api-endpoint={captchaConfig.endpoint ?? ""}
                      data-cap-lang="zh-cn"
                      id="cap-widget"
                    />
                  )}
                  {captchaConfig.provider === "turnstile" && (
                    <div
                      id="turnstile-container"
                      ref={turnstileContainerRef}
                      className="tg-captcha-container"
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <div className="mt-6 text-center">
            <div className="text-sm text-fg-hint">
              <p>💡 完成人机验证后页面会自动刷新，请稍等</p>
              <p>⚡ 由 TGuard 提供技术支持</p>
            </div>
          </div>
        </div>

        <div id="message-container">
          {message && (
            <div className={`tg-card ${message.cardClass}`}>
              <div className="text-center">
                <div className="text-4xl mb-4">{message.icon}</div>
                <div className={`text-lg font-medium ${message.textClass}`}>{message.text}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
