import Link from "next/link";

export default function NotFound() {
  return (
    <div className="tg-page min-h-screen flex flex-col">
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card error-shake">
          <div className="text-center">
            <div className="text-8xl mb-6">❌</div>
            <h1 className="text-3xl font-bold mb-4 text-red-600">出现错误</h1>
            <p className="text-lg mb-6 text-gray-600">验证链接无效或已过期</p>

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
              <Link href="/" className="tg-button w-full block">
                返回主页
              </Link>
            </div>

            <div className="mt-6 text-sm text-gray-500">
              <p>📞 如需帮助，请联系管理员</p>
              <p>⚡ 由 TGuard 提供技术支持</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
