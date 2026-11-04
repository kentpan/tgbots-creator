import type { Metadata } from "next";
import Link from "next/link";
import { loginAction } from "./actions";

export const metadata: Metadata = {
  title: "管理后台登录 - TGuard",
};

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  empty: "请输入用户名和密码",
  invalid: "用户名或密码错误，或账号已停用",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? "登录失败，请重试") : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="p-6 space-y-1 text-center">
            <div className="text-4xl">🤖</div>
            <h1 className="text-xl font-bold">TGuard 管理后台</h1>
            <p className="text-sm text-muted-foreground">
              使用管理员账号登录，管理群组验证与系统配置
            </p>
          </div>
          <div className="px-6 pb-6">
            {errorMessage ? (
              <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}
            <form action={loginAction} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="username" className="text-sm font-medium">
                  用户名
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  required
                  autoComplete="username"
                  placeholder="请输入用户名"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">
                  密码
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="submit"
                className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                登 录
              </button>
            </form>
          </div>
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground hover:underline">
            返回验证首页
          </Link>
        </p>
      </div>
    </div>
  );
}
