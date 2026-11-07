import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dotNext = path.join(root, ".next");
const serverDir = path.join(dotNext, "server");
const standaloneServer = path.join(dotNext, "standalone", ".next", "server");
const manifestPath = path.join(serverDir, "instrumentation.js.nft.json");

if (!existsSync(manifestPath)) {
  console.warn("instrumentation.js.nft.json not found; skip sync");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

/**
 * 手写递归复制（readFile/writeFile，不用 copyFileSync/cpSync）：
 * - nft 清单里会出现**目录**条目（如 .next/node_modules/<pkg>-<hash>，telegram
 *   依赖引入后出现），copyFileSync 对目录抛 EISDIR（2026-11-08 CI 实录）；
 * - cpSync 在部分沙箱环境（WorkBuddy node-brokered-fs-shim）同样以 copyfile
 *   语义代理目录复制并失败 —— 纯 read/write 路径两边都稳定。
 */
function copyPath(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyPath(path.join(src, entry), path.join(dest, entry));
    }
    return "dir";
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src));
  return "file";
}

let copied = 0;
let copiedDirs = 0;
for (const rel of manifest.files) {
  const source = path.resolve(serverDir, rel);
  if (!source.startsWith(dotNext + path.sep)) continue;
  if (!existsSync(source)) continue;
  const relative = path.relative(serverDir, source);
  const dest = path.join(standaloneServer, relative);
  if (copyPath(source, dest) === "dir") copiedDirs += 1;
  else copied += 1;
}

const instrumentationEntry = path.join(serverDir, "instrumentation.js");
if (existsSync(instrumentationEntry)) {
  copyFileSync(instrumentationEntry, path.join(standaloneServer, "instrumentation.js"));
  const mapFile = path.join(serverDir, "instrumentation.js.map");
  if (existsSync(mapFile)) {
    copyFileSync(mapFile, path.join(standaloneServer, "instrumentation.js.map"));
  }
}

console.log(`Instrumentation synced into standalone: ${copied} files, ${copiedDirs} directories`);
