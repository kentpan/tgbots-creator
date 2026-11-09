import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

// 全局唯一版本源：package.json 的 version 字段。
// 所有需要版本号的地方（客户端组件、health 接口等）
// 一律通过本配置注入的 NEXT_PUBLIC_APP_VERSION 或 app-version.ts 获取，禁止硬编码。
const pkg: { version?: string } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

const parsedPort = Number(process.env.PORT);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
process.env.PORT = String(port);

// Cloudflare Pages 构建（@cloudflare/next-on-pages）模式：standalone 输出与其不兼容，
// 由 CI 显式注入 NEXT_ON_PAGES=1 切换为默认输出；本地/Node 部署仍用 standalone。
const isPagesBuild =
  process.env.NEXT_ON_PAGES === "1" || process.env.NEXT_ON_PAGES === "true" || process.env.CF_PAGES === "1";

const nextConfig: NextConfig = {
  ...(isPagesBuild ? {} : { output: "standalone" }),
  // 放行任意 Host/Origin（Next 16 无 allowedHosts 字段；等价实现：
  // "**.*" 通配任意 ≥2 段的域名 —— allowedDevOrigins（dev 资源/跨站校验）
  // 与 serverActions.allowedOrigins（server action POST 校验）共用同一匹配器）
  allowedHosts: true,
  allowedDevOrigins: ["**.*", "localhost", "127.0.0.1"],
  // 构建时把 package.json 的 version 注入前后端通用的环境变量
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version ?? "0.0.0",
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  experimental: {
    serverActions: {
      allowedOrigins: Array.from(
        new Set([
          ...(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean),
          "**.*",
          "*.space.zhipuaidemo.cn",
          "*.fcapp.run",
        ]),
      ),
    },
  },
};

export default nextConfig;
