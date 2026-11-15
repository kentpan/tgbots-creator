"use client";

import { useEffect } from "react";
import { hapticError, hapticSuccess, getTg } from "@/lib/webapp";

export function BackButtonCloseEffect({ enabled = true }: { enabled?: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const tg = getTg();
    if (!tg) return;
    tg.BackButton.show();
    tg.BackButton.onClick(() => {
      tg.close();
    });
    return () => {
      tg.BackButton.offClick();
      tg.BackButton.hide();
    };
  }, [enabled]);

  return null;
}

export function ExpiredState({ message }: { message: string }) {
  return (
    <div className="tg-page min-h-screen flex flex-col">
      <BackButtonCloseEffect />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card">
          <div className="text-center">
            <div className="text-8xl mb-6">⏰</div>
            <h1 className="text-3xl font-bold mb-4 text-orange-600">验证已过期</h1>
            <p className="text-lg mb-6 text-gray-600">{message}</p>

            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-6">
              <div className="text-orange-700">
                <div className="font-medium mb-2">💡 如何重新验证：</div>
                <ol className="text-left space-y-1 text-sm">
                  <li>1. 返回应用</li>
                  <li>2. 重新发起验证</li>
                  <li>3. 点击新的验证链接</li>
                </ol>
              </div>
            </div>

            <div className="space-y-3">
              <button className="tg-button w-full" onClick={() => getTg()?.close()}>
                返回 Telegram
              </button>

              <button
                className="bg-gray-200 text-gray-700 border border-gray-300 rounded-lg px-6 py-3 w-full"
                onClick={() => window.location.reload()}
              >
                刷新页面
              </button>
            </div>

            <div className="mt-6 text-sm text-gray-500">
              <p>🕐 验证链接有效期：5分钟</p>
            </div>
          </div>
        </div>
      </div>
      <HapticErrorEffect />
    </div>
  );
}

/**
 * v3.0.4 验证完成状态页（无轮询）：
 * - 服务端已在页面加载时查过一次审批结果（未批准会就地结算一次）：
 *   approved=true → 直接展示「验证成功」，3 秒后自动关闭；
 *   approved=false → 展示「等待处理」，5 秒后自动关闭（用户可刷新页面再次触发结算）。
 */
export function CompletedState({
  message,
  approved = false,
}: {
  message: string;
  approved?: boolean;
}) {
  useEffect(() => {
    if (approved) hapticSuccess();
  }, [approved]);

  // 成功 3 秒关闭；待处理 5 秒关闭（原行为）
  useEffect(() => {
    const timer = setTimeout(() => getTg()?.close(), approved ? 3000 : 5000);
    return () => clearTimeout(timer);
  }, [approved]);

  return (
    <div className="tg-page min-h-screen flex flex-col">
      <BackButtonCloseEffect />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card">
          <div className="text-center">
            <div className="text-8xl mb-6">{approved ? "🎉" : "✅"}</div>
            <h1 className={`text-3xl font-bold mb-4 ${approved ? "text-green-600" : "text-blue-600"}`}>
              {approved ? "验证成功" : "验证已完成"}
            </h1>
            <p className="text-lg mb-6 text-gray-600">
              {approved ? "验证已通过，欢迎加入群组！" : message}
            </p>

            {approved ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <div className="text-green-700 text-sm">
                  <span className="font-medium">✅</span> 验证已通过，页面即将自动关闭
                </div>
              </div>
            ) : (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                  <div className="text-blue-700">
                    <div className="font-medium mb-2">📋 当前状态：</div>
                    <div className="text-left space-y-2 text-sm">
                      <div className="flex items-center space-x-2">
                        <span className="text-green-500">✓</span>
                        <span>人机验证已完成</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-blue-500">⏳</span>
                        <span>等待处理</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                  <div className="text-yellow-700 text-sm">
                    <span className="font-medium">💡 提示：</span>
                    处理完成后重新打开本页即可看到验证结果
                  </div>
                </div>
              </>
            )}

            <button className="tg-button w-full" onClick={() => getTg()?.close()}>
              返回 Telegram
            </button>

            <div className="mt-6 text-sm text-gray-500">
              <p>🔔 {approved ? "如有问题请联系群管理员" : "您将收到处理通知"}</p>
            </div>
          </div>
        </div>
      </div>
      {!approved && <HapticErrorEffect />}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="tg-page min-h-screen flex flex-col">
      <BackButtonCloseEffect />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card error-shake">
          <div className="text-center">
            <div className="text-8xl mb-6">❌</div>
            <h1 className="text-3xl font-bold mb-4 text-red-600">出现错误</h1>
            <p className="text-lg mb-6 text-gray-600">{message}</p>

            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <div className="text-red-700">
                <div className="font-medium mb-2">🔧 解决方案：</div>
                <ul className="text-left space-y-1 text-sm">
                  <li>• 检查网络连接</li>
                  <li>• 刷新页面重试</li>
                  <li>• 重新发起验证</li>
                  <li>• 联系管理员</li>
                </ul>
              </div>
            </div>

            <div className="space-y-3">
              <button
                className="tg-button w-full"
                onClick={() => window.location.reload()}
              >
                刷新页面
              </button>

              <button
                className="bg-gray-200 text-gray-700 border border-gray-300 rounded-lg px-6 py-3 w-full"
                onClick={() => getTg()?.close()}
              >
                返回 Telegram
              </button>
            </div>

            <div className="mt-6 text-sm text-gray-500">
              <p>📞 如需帮助，请联系管理员</p>
            </div>
          </div>
        </div>
      </div>
      <HapticErrorEffect />
    </div>
  );
}

function HapticErrorEffect() {
  useEffect(() => {
    hapticError();
  }, []);
  return null;
}
