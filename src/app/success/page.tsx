import Script from "next/script";
import type { Metadata } from "next";
import { WebAppLoader } from "@/components/tg/web-app-loader";

export const metadata: Metadata = {
  title: "验证成功",
};

export default function SuccessPage() {
  return (
    <div className="tg-page min-h-screen flex flex-col">
      <WebAppLoader />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card success-animation">
          <div className="text-center">
            <div className="text-8xl mb-6">🎉</div>
            <h1 className="text-3xl font-bold mb-4 text-green-600">验证成功！</h1>
            <p className="text-lg mb-6 text-gray-600">您已成功完成人机验证！</p>

            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center justify-center space-x-2 text-green-700">
                  <span className="text-xl">✅</span>
                  <span className="font-medium">身份验证通过</span>
                </div>
              </div>
            </div>

            <div className="mt-8">
              <button className="tg-button w-full" data-close-webapp>
                返回 Telegram
              </button>
            </div>

            <div className="mt-6 text-sm text-gray-500">
              <p>🔒 本次验证受到加密保护</p>
              <p>⚡ 由 TGuard 提供技术支持</p>
            </div>
          </div>
        </div>
      </div>

      <Script id="tg-success-page" strategy="afterInteractive">
        {`
          (function () {
            var tg = window.Telegram && window.Telegram.WebApp;
            function closeWebApp() { if (tg) tg.close(); }
            function hapticSuccess() {
              if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            }
            setTimeout(closeWebApp, 2000);
            hapticSuccess();
            if (tg) {
              tg.BackButton.hide();
              var button = document.querySelector('[data-close-webapp]');
              if (button) button.addEventListener('click', closeWebApp);
            }
          })();
        `}
      </Script>
    </div>
  );
}
