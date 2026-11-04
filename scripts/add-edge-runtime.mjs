/**
 * CI 专用：为所有 App Router 路由注入 Edge Runtime 声明（仅 Cloudflare Pages 构建使用）。
 *
 * 背景：
 *   @cloudflare/next-on-pages 只支持 Edge Runtime，构建末期会校验「所有非静态路由
 *   必须显式 export const runtime = 'edge'」，缺失即报
 *   "Failed to produce a Cloudflare Pages build ... routes were not configured to
 *   run with the Edge Runtime" 并 exit 1（2026-11-04 GitHub Actions 实测事故）。
 *
 * 为什么不在源码里直接声明：
 *   本项目双形态部署 —— 本地/沙盒以 Node 运行（node:sqlite 直连 SQLite 文件），
 *   Cloudflare Pages 以 Edge 运行（D1 绑定，见 src/database/client.ts 三级适配）。
 *   若把 runtime='edge' 写死进源码，本地 next dev 会把所有路由放入 Edge 模拟沙箱，
 *   node:sqlite / 文件系统全部不可用，直接摧毁现有功能。
 *   因此本脚本只在 CI（Pages 构建）中、next build 之前执行，注入只存在于
 *   runner 工作区，不进 git、不进沙盒。
 *
 * 行为：
 *   1. 扫描 src/app 下全部 page.{tsx,jsx,ts,js} 与 route.{tsx,jsx,ts,js}
 *   2. 已含 `export const runtime` 声明的文件一律跳过（绝不覆盖已有配置）
 *   3. 其余在文件末尾追加 `export const runtime = "edge";`（附带说明注释）
 *   4. 幂等：重复执行结果一致
 *   5. 任何读取/写入失败立即抛错退出（绝不静默跳过）
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const appDir = path.join(root, "src", "app");

if (!statSync(appDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`[add-edge-runtime] 未找到路由目录: ${appDir}`);
  process.exit(1);
}

const TARGET_BASENAMES = new Set(["page", "route"]);
const TARGET_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const RUNTIME_DECLARATION = "export const runtime";
const INJECTION = [
  "",
  "// @cloudflare/next-on-pages 要求所有非静态路由运行于 Edge Runtime（CI Pages 构建时由 scripts/add-edge-runtime.mjs 自动注入，不入源码仓库）",
  'export const runtime = "edge";',
  "",
].join("\n");

let injected = 0;
let skipped = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const base = path.basename(entry.name, ext);
    if (!TARGET_EXTS.has(ext) || !TARGET_BASENAMES.has(base)) continue;

    const content = readFileSync(full, "utf-8");
    if (content.includes(RUNTIME_DECLARATION)) {
      skipped += 1;
      continue;
    }
    const needsNewline = content.length > 0 && !content.endsWith("\n");
    writeFileSync(full, content + (needsNewline ? "\n" : "") + INJECTION, "utf-8");
    injected += 1;
    console.log(`[add-edge-runtime] 注入 edge runtime: ${path.relative(root, full)}`);
  }
}

walk(appDir);

console.log(
  `[add-edge-runtime] 完成：注入 ${injected} 个文件，跳过 ${skipped} 个（已含 runtime 声明）`,
);
