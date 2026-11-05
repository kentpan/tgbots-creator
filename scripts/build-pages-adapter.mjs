#!/usr/bin/env node
/**
 * scripts/build-pages-adapter.mjs — OpenNext 产物 → Cloudflare Pages 高级模式装配。
 *
 * 仅 deployType=pages 的 CI 构建调用(.github/workflows/pages-deploy.yml 的
 * "Assemble Pages bundle" 步骤, 与生产验证工作流 upload/next-deploy.yml 同源同步骤)。
 * deployType=workers 直接以 pages-adapter/worker.ts 为 wrangler main, 不走本脚本。
 *
 * 职责(对齐生产验证适配层的既定职责):
 *   1. 重建 dist-pages/(干净装配, 幂等可重跑)
 *   2. 复制 OpenNext 静态资源 .open-next/assets/** → dist-pages/**
 *      (.open-next 本身位于部署目录之外, 服务端代码不会泄漏为静态资源)
 *   3. esbuild 打包 pages-adapter/worker.ts → dist-pages/_worker.js
 *      (bundle 内联 .open-next/worker.js 全树; node:* / cloudflare:* 保持
 *      external, 由 workerd nodejs_compat 运行时原生提供; 与 Workers 部署
 *      的 wrangler esbuild+nodejs_compat 管线同语义)
 *   4. 生成 _routes.json —— 纯静态路径排除出 worker(CDN 直出, 规避 Pages
 *      高级模式全量请求进 _worker.js 的额外开销); worker 内 OpenNext 路由
 *      自带 env.ASSETS 兜底, 未排除的静态请求仍可正确服务
 *   5. 产物完整性校验, 任何缺失立即 exit 1(绝不静默产出残缺部署目录)
 *
 * esbuild 解析: 复用项目 node_modules 中 wrangler 的依赖(esbuild 随 wrangler
 * 进入依赖树, npm ci 后必然存在); 缺失时报错退出, 不做网络回退。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const openNextDir = path.join(root, ".open-next");
const assetsDir = path.join(openNextDir, "assets");
const distPagesDir = path.join(root, "dist-pages");
const adapterEntry = path.join(root, "pages-adapter", "worker.ts");
const workerOut = path.join(distPagesDir, "_worker.js");

function fail(message) {
  console.error(`::error::[build-pages-adapter] ${message}`);
  process.exit(1);
}

// ---- 0. 前置校验 ----
if (!existsSync(path.join(openNextDir, "worker.js"))) {
  fail(`OpenNext 构建产物缺失: .open-next/worker.js(请先执行 opennextjs-cloudflare build)`);
}
if (!existsSync(assetsDir)) {
  fail(`OpenNext 静态资源目录缺失: .open-next/assets`);
}
if (!existsSync(adapterEntry)) {
  fail(`适配层入口缺失: pages-adapter/worker.ts`);
}

// ---- 1. 重建 dist-pages/ ----
rmSync(distPagesDir, { recursive: true, force: true });
mkdirSync(distPagesDir, { recursive: true });

// ---- 2. 复制静态资源 ----
cpSync(assetsDir, distPagesDir, { recursive: true });
const assetFileCount = (function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
})(distPagesDir);

// ---- 3. esbuild 打包适配层 ----
const require = createRequire(path.join(root, "package.json"));
let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  fail(`无法加载 esbuild(wrangler 依赖树应携带): ${error?.message ?? error}`);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["pages-adapter/worker.ts"],
  outfile: "dist-pages/_worker.js",
  bundle: true,
  format: "esm",
  // platform "node": node 内置模块(裸名 require("fs")/require("async_hooks") 与
  // node: 前缀两种形态, OpenNext handler.mjs 两种都有)全部自动 external ——
  // 由 workerd nodejs_compat 运行时原生提供; platform "neutral" 不认识裸名内置模块。
  platform: "node",
  target: "esnext",
  // 覆盖 conditions 为 workerd 优先(与 wrangler 打包管线同语义):
  // 让 OpenNext 产物内的条件导入按 workerd 运行时形态解析。
  conditions: ["workerd", "worker", "import", "module", "default"],
  // cloudflare:* 为 workerd 专有模块(DO 基类等), node 内置模块已由 platform=node 外置
  external: ["cloudflare:*", "node:*"],
  legalComments: "none",
  logLevel: "info",
});

// ---- 3.5 恢复裸 require(与 @opennextjs/cloudflare patchRequireHelper 同一补丁) ----
// esbuild 把 CJS 互操作代码里的外部模块 require(...) 重写为运行时辅助函数
// __require(...), 后者在 ESM 产物中直接抛
// "Dynamic require of X is not supported" —— 而 workerd 的 nodejs_compat
// 在 ES 模块内提供真实的 require()。OpenNext 官方构建对 handler.mjs 应用的
// 正是本补丁(仅重命名标识符, 前面是 . # $ 或单词字符的 __require 属于
// 打包代码内部命名, 一律保留)。
const bundledCode = readFileSync(workerOut, "utf8");
const patchedCode = bundledCode.replace(/(?<![.#$\w])__require\d?\(/g, "require(");
if (patchedCode !== bundledCode) {
  writeFileSync(workerOut, patchedCode);
  const replaced = (bundledCode.match(/(?<![.#$\w])__require\d?\(/g) ?? []).length;
  console.log(`✓ 已恢复 ${replaced} 处裸 require(workerd nodejs_compat 运行时提供)`);
}

// ---- 4. 生成 _routes.json ----
// 纯静态资源 CDN 直出; 其余(页面 SSR/API/预渲染页)进 _worker.js,
// 由 OpenNext 路由 + env.ASSETS 兜底服务。规则数远低于 Pages 100 条上限。
const routesJson = {
  version: 1,
  include: ["/*"],
  exclude: [
    "/_next/static/*",
    "/favicon.ico",
    "/favicon.svg",
    "/robots.txt",
    "/sitemap.xml",
    "/site.webmanifest",
    "/manifest.json",
  ],
};
writeFileSync(path.join(distPagesDir, "_routes.json"), JSON.stringify(routesJson, null, 2));

// ---- 5. 产物完整性校验 ----
if (!existsSync(workerOut)) {
  fail("dist-pages/_worker.js 未生成(esbuild 打包失败)");
}
const workerSize = statSync(workerOut).size;
if (workerSize < 100 * 1024) {
  fail(`dist-pages/_worker.js 体积异常(${workerSize} bytes), OpenNext bundle 未正确内联`);
}
if (assetFileCount === 0) {
  fail("dist-pages 静态资源为空(assets 复制失败)");
}

console.log(`✅ dist-pages 装配完成: _worker.js ${(workerSize / 1024 / 1024).toFixed(2)} MB + ${assetFileCount} 个静态文件`);
