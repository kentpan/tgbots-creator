import Script from "next/script";
import { WebAppLoader } from "@/components/tg/web-app-loader";

export default function IndexPage() {
  const features = [
    {
      color: "bg-blue-50 border-blue-200",
      text: "text-blue-700",
      icon: "🔐",
      title: "安全验证",
      description: "高级人机验证技术",
    },
    {
      color: "bg-green-50 border-green-200",
      text: "text-green-700",
      icon: "⚡",
      title: "自动处理",
      description: "验证通过即刻生效",
    },
    {
      color: "bg-purple-50 border-purple-200",
      text: "text-purple-700",
      icon: "🛡️",
      title: "防护机制",
      description: "有效阻止恶意用户",
    },
    {
      color: "bg-orange-50 border-orange-200",
      text: "text-orange-700",
      icon: "📱",
      title: "用户友好",
      description: "简单易用的界面",
    },
  ];

  const steps = [
    { number: "1", label: "发起验证请求", color: "bg-blue-500" },
    { number: "2", label: "收到验证链接", color: "bg-blue-500" },
    { number: "3", label: "完成人机验证", color: "bg-blue-500" },
    { number: "4", label: "验证完成", color: "bg-green-500" },
  ];

  return (
    <div className="tg-page min-h-screen flex flex-col">
      <WebAppLoader />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card">
          <div className="text-center">
            <div className="text-8xl mb-6">🤖</div>
            <h1 className="text-4xl font-bold mb-4 text-fg">TGuard</h1>
            <p className="text-xl mb-6 text-fg-secondary">智能验证机器人</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
              {features.map((feature) => (
                <div key={feature.title} className={`${feature.color} border rounded-lg p-4`}>
                  <div className={feature.text}>
                    <div className="text-2xl mb-2">{feature.icon}</div>
                    <div className="font-medium">{feature.title}</div>
                    <div className="text-sm">{feature.description}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-secondary border border-gray-200 rounded-lg p-6 mb-6">
              <h3 className="font-bold mb-3 text-fg">📋 使用流程</h3>
              <div className="text-left space-y-2 text-sm">
                {steps.map((step) => (
                  <div key={step.number} className="flex items-center space-x-2">
                    <span
                      className={`${step.color} text-white rounded-full w-6 h-6 flex items-center justify-center text-sm`}
                    >
                      {step.number}
                    </span>
                    <span className="text-fg">{step.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-sm text-fg-hint">
              <p>
                Powered by{" "}
                <a
                  className="text-fg-link hover:text-blue-800 font-medium"
                  href="https://github.com/SideCloudGroup/TGuard"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  TGuard
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>

      <Script id="tg-index-page" strategy="afterInteractive">
        {`
          (function () {
            var tg = window.Telegram && window.Telegram.WebApp;
            if (!tg) return;
            tg.BackButton.hide();
            tg.MainButton.setText('了解更多');
            tg.MainButton.onClick(function () {
              window.open('https://github.com/SideCloudGroup/TGuard', '_blank');
            });
          })();
        `}
      </Script>
    </div>
  );
}
