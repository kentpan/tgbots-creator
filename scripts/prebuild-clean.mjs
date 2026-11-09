// 构建前遗留文件清理：与 scripts/package.mjs 生成的 upgrade-cleanup.txt 配套。
// 发布包解压覆盖升级时，历史版本中后来被删除的文件会残留在部署目录（幽灵文件），
// 例如 v2.1.12 已删除的 src/app/api/admin/bots/preview/route.ts 仍 import 已移除的
// executeMenuApi，导致 Cloudflare CI next build 失败（2026-11-09 事故）。
// 本脚本在 npm run build 最前执行：按清单清除幽灵文件；清单缺失 = 源码树直跑，
// 直接跳过。清单路径命中安全禁区（数据库/.env/日志/构建产物）时立即中止构建，
// 宁缺勿错 —— 清理逻辑绝不触碰运行时数据。
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "upgrade-cleanup.txt");

if (!existsSync(manifestPath)) {
  console.log("[prebuild-clean] 未找到 upgrade-cleanup.txt（源码树直跑，非解压部署目录），跳过遗留清理");
  process.exit(0);
}

const FORBIDDEN_DIR_TOPS = new Set([
  "db",
  "download",
  "node_modules",
  ".next",
  ".open-next",
  ".vercel",
  ".package-stage",
]);

function isForbidden(rel) {
  const top = rel.split("/")[0];
  if (FORBIDDEN_DIR_TOPS.has(top)) return true;
  if (/\.(db|db-wal|db-shm)$/.test(rel)) return true;
  if (/(^|\/)\.env/.test(rel)) return true;
  if (/\.log$/.test(rel)) return true;
  return false;
}

const entries = readFileSync(manifestPath, "utf-8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const removed = [];
for (const rel of entries) {
  const segments = rel.split("/");
  if (path.isAbsolute(rel) || segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    console.error(`[prebuild-clean] 清单含非法路径「${rel}」，中止构建（宁缺勿错）`);
    process.exit(1);
  }
  if (isForbidden(rel)) {
    console.error(`[prebuild-clean] 清单路径「${rel}」命中安全禁区（数据库/.env/日志/构建产物），中止构建`);
    process.exit(1);
  }
  const abs = path.join(root, ...segments);
  if (!existsSync(abs)) continue;
  if (!statSync(abs).isFile()) continue;
  rmSync(abs);
  removed.push(rel);
  console.log(`[prebuild-clean] 已清除历史遗留幽灵文件: ${rel}`);
}

console.log(`[prebuild-clean] 遗留清理完成（清单 ${entries.length} 条，本次清除 ${removed.length} 个文件）`);
