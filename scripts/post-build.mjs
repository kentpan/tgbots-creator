/**
 * 统一构建后处理（next build 之后执行）：
 *
 * 分两种构建目标，行为与各部署方式一一对应：
 *
 * 1. Cloudflare Pages（@cloudflare/next-on-pages）：
 *    CI 注入 NEXT_ON_PAGES=1（或 CF_PAGES=1），next.config.ts 据此关闭 standalone 输出，
 *    产物由 vercel build 收集为 .vercel/output/{static,functions}，next-on-pages 再加工。
 *    此时 .next/standalone 不存在 —— 若仍执行 standalone 复制必然
 *    "cp: cannot create directory '.next/standalone/.next/': No such file or directory"
 *    → npm run build exit 1 → vercel build 失败（2026-11-04 GitHub Actions 实测事故）。
 *    因此 Pages 模式直接跳过全部 standalone 后处理。
 *
 * 2. 本地/Node 服务器（output:"standalone"）：
 *    保持与原 build 脚本完全一致的动作：
 *      cp -r .next/static  → .next/standalone/.next/
 *      cp -r public        → .next/standalone/
 *      node scripts/sync-instrumentation.mjs
 *      rm -rf .next/standalone/prisma .next/standalone/.env .next/standalone/.env.production
 *    .next/standalone 缺失时抛出详细错误退出 1（绝不静默跳过）。
 */
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dotNext = path.join(root, ".next");
const standaloneDir = path.join(dotNext, "standalone");

const isPagesBuild =
  process.env.NEXT_ON_PAGES === "1" ||
  process.env.NEXT_ON_PAGES === "true" ||
  process.env.CF_PAGES === "1";

if (isPagesBuild) {
  console.log(
    "[post-build] 检测到 NEXT_ON_PAGES/CF_PAGES：Cloudflare Pages 构建，跳过 standalone 后处理（产物由 vercel build → next-on-pages 收集）",
  );
  process.exit(0);
}

if (!existsSync(standaloneDir)) {
  console.error(
    "[post-build] .next/standalone 目录不存在，且未设置 NEXT_ON_PAGES/CF_PAGES。\n" +
      "  说明 next.config.ts 的 output:\"standalone\" 未生效或 next build 未完成，无法执行 standalone 后处理。\n" +
      "  如目标是 Cloudflare Pages 构建，请在构建环境显式注入 NEXT_ON_PAGES=1。",
  );
  process.exit(1);
}

// 与原 build 脚本逐条对应（源/目标一致，不改变 standalone 部署行为）
const standaloneDotNext = path.join(standaloneDir, ".next");
if (!existsSync(path.join(dotNext, "static"))) {
  console.error("[post-build] .next/static 不存在 —— next build 产物不完整，中止 standalone 后处理。");
  process.exit(1);
}
cpSync(path.join(dotNext, "static"), path.join(standaloneDotNext, "static"), { recursive: true });
console.log("[post-build] 已复制 .next/static → .next/standalone/.next/static");

if (!existsSync(path.join(root, "public"))) {
  console.error("[post-build] public/ 目录不存在，中止 standalone 后处理。");
  process.exit(1);
}
cpSync(path.join(root, "public"), path.join(standaloneDir, "public"), { recursive: true });
console.log("[post-build] 已复制 public → .next/standalone/public");

const syncResult = spawnSync(process.execPath, [path.join(root, "scripts", "sync-instrumentation.mjs")], {
  stdio: "inherit",
});
if (syncResult.error) {
  console.error(`[post-build] sync-instrumentation 执行失败: ${syncResult.error.message}`);
  process.exit(1);
}
if (syncResult.status !== 0) {
  console.error(`[post-build] sync-instrumentation 退出码 ${syncResult.status}，中止 standalone 后处理。`);
  process.exit(syncResult.status ?? 1);
}

for (const sensitive of ["prisma", ".env", ".env.production"]) {
  rmSync(path.join(standaloneDir, sensitive), { recursive: true, force: true });
}
console.log("[post-build] 已清理 standalone 内敏感文件（prisma/.env/.env.production）");

const sizeKb = (statSync(standaloneDir).size / 1024).toFixed(1);
console.log(`[post-build] standalone 后处理完成（${sizeKb} KB）`);
