#!/usr/bin/env node
/**
 * 正式打包脚本：生成发布 zip 包。
 *
 * 版本号全局唯一来源：package.json 的 version 字段。
 * zip 文件名通过 deploy.config.js（其 version/projectName 均动态读取 package.json）
 * 派生为：download/<projectName>-v<version>.zip，禁止任何硬编码版本号。
 *
 * 打包流程：
 * 1. SQLite WAL checkpoint（保证 db 文件落盘完整）
 * 2. 复制源码/配置/数据库到临时 staging 目录（排除日志等运行时文件）
 * 3. staging 中生成「产品默认 .env」（直连模式；沙盒本地 .env 不入包）
 * 4. 从 staging 压缩为发布包
 *
 * 用法：node scripts/package.mjs
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".package-stage");

// 1. 读取全局唯一版本源 package.json
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
if (!pkg.version) {
  console.error("❌ package.json 缺少 version 字段");
  process.exit(1);
}

// 2. 读取部署配置（projectName/version 均动态来自 package.json），校验一致性
let cfg = { projectName: pkg.name, version: pkg.version };
const deployCfgPath = path.join(root, "deploy.config.js");
if (existsSync(deployCfgPath)) {
  cfg = (await import(deployCfgPath)).default ?? cfg;
  if (cfg.version !== pkg.version) {
    console.error(
      `❌ deploy.config.js version(${cfg.version}) 与 package.json version(${pkg.version}) 不一致，请检查动态读取逻辑`,
    );
    process.exit(1);
  }
}

const zipPath = path.join(root, "download", `${cfg.projectName}-v${pkg.version}.zip`);

// 3. SQLite WAL checkpoint：把 -wal 中的数据落盘进主 db 文件，保证包内数据库完整。
//    直接在本进程内用 node:sqlite 执行（子进程 shell 引号会截断参数导致永远失败）；
//    dev server 运行中可能短暂持锁 → 带重试，全部失败则中止打包（宁缺勿错）。
function checkpointDb(dbFile) {
  const abs = path.join(root, dbFile);
  if (!existsSync(abs)) return true;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const db = new DatabaseSync(abs);
      db.exec("PRAGMA busy_timeout=3000;");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
      console.log(`   checkpoint ok: ${dbFile}`);
      return true;
    } catch (error) {
      if (attempt < 5) {
        console.warn(`   checkpoint 第 ${attempt} 次失败（${error instanceof Error ? error.message : error}），1 秒后重试…`);
        execSync("sleep 1", { stdio: "ignore" });
      }
    }
  }
  return false;
}
for (const dbFile of ["prisma/bot-groups.db", "db/custom.db"]) {
  if (!checkpointDb(dbFile)) {
    console.error(`❌ ${dbFile} WAL checkpoint 重试 5 次仍失败：包内数据库可能缺数据，中止打包。请稍后重试或停掉 dev server 再打包。`);
    process.exit(1);
  }
}

// 3.5 打包前配置闸门（防「沙盒配置污染用户生产配置」事故复发）：
//     v1.1.3/v1.1.4 首包曾把沙盒遗留的 telegram.transport_mode=polling 打进包，
//     用户部署后自己的「全局 Webhook」配置被包内 DB 覆盖成轮询（2026-11-03 用户暴怒投诉）。
//     此后每次打包必须完整打印即将随包分发的全局配置与验证方式，人工核对无误才允许交付。
//     读取失败直接抛错中止（绝不静默跳过）。
function dumpShippedConfig(dbFile) {
  const abs = dbFile;
  if (!existsSync(abs)) return;
  const db = new DatabaseSync(abs, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  // 两个库 schema 不同：bot-groups.db 持有 Telegram 全局配置与验证方式；
  // custom.db 无这两张表属正常（打印说明而非报错）
  if (!tables.includes("app_settings") && !tables.includes("verification_methods")) {
    db.close();
    console.log(`   ── ${dbFile}：无 app_settings / verification_methods 表（schema 不同，无全局配置随包） ──`);
    return;
  }
  const settings = db
    .prepare(
      "SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?, ?) ORDER BY key",
    )
    .all(
      "telegram.transport_mode",
      "telegram.webhook_base_url",
      "telegram.proxy_enabled",
      "telegram.proxy_url",
      "api.base_url",
    );
  const methods = db
    .prepare("SELECT id, name, enabled, type FROM verification_methods ORDER BY id")
    .all();
  db.close();
  console.log(`   ── ${dbFile} 随包全局配置（交付前必须逐项核对） ──`);
  for (const row of settings) {
    console.log(`   · ${row.key} = ${row.value}`);
  }
  console.log(`   ── ${dbFile} 随包验证方式（严禁 mock/假数据） ──`);
  if (methods.length === 0) console.log("   · （无）");
  for (const m of methods) {
    console.log(`   · #${m.id} ${m.name} type=${m.type} enabled=${m.enabled}`);
  }
}
dumpShippedConfig(path.join(root, "prisma/bot-groups.db"));
dumpShippedConfig(path.join(root, "db/custom.db"));

/**
 * 沙盒运行时残留键（v2.1.9 打包闸门强制化）：
 * v1.1.3/v1.1.4 事故：沙盒遗留的 telegram.transport_mode=polling 随包分发，用户部署后
 * 自己的全局传输配置被包内 DB 覆盖成轮询（2026-11-03 用户暴怒投诉）。此前
 * dumpShippedConfig 只能事后打印供人工核对 —— v2.1.9 起在 staging 副本上直接强制
 * 清除下列键（只影响包内副本，沙盒本地库不受任何影响）:
 * - telegram.transport_mode：删除 → 运行时取产品默认 auto（按部署形态自适应 Webhook/轮询）
 * - telegram.pending_groups：沙盒建群向导的临时待绑定态，随包分发无意义
 * 清洗结果与随包配置一并打印，交付前逐项核对。
 */
const SANDBOX_RESIDUE_KEYS = ["telegram.transport_mode", "telegram.pending_groups"];

function sanitizeShippedDb(dbFile) {
  if (!existsSync(dbFile)) return;
  const db = new DatabaseSync(dbFile);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    if (!tables.includes("app_settings")) return;
    for (const key of SANDBOX_RESIDUE_KEYS) {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
      if (row === undefined) continue;
      const deleted = db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
      console.log(
        `   🧹 已清洗沙盒残留 ${key}（原值：${row.value}）→ 运行时取产品默认`,
      );
      if (deleted.changes !== 1) {
        console.error(`   ❌ 清洗 ${key} 失败（changes=${deleted.changes}），中止打包`);
        db.close();
        process.exit(1);
      }
    }
  } finally {
    db.close();
  }
}

// 4. 组装 staging
const includeRootFiles = [
  ".gitignore",
  ".npmrc",
  "Caddyfile",
  "README.md",
  "components.json",
  "config.toml",
  "deploy.config.js",
  "eslint.config.mjs",
  "instrumentation.ts",
  "next-env.d.ts",
  "next.config.ts",
  "open-next.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
];
const includeDirs = [".github", "pages-adapter", "prisma", "public", "scripts", "src"];
const skipNames = new Set(["dev.log", ".package-stage", "node_modules", ".vercel"]);
// SQLite 运行时伴生文件不入包：WAL checkpoint(TRUNCATE) 后 -wal 已是 0 字节，
// -shm 是共享内存索引，两者与主 db 文件无关且解压后可能引起误判
const skipSuffixes = [".db-wal", ".db-shm"];

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const f of includeRootFiles) {
  if (existsSync(path.join(root, f))) {
    cpSync(path.join(root, f), path.join(stage, f));
  }
}
for (const d of includeDirs) {
  if (!existsSync(path.join(root, d))) continue;
  cpSync(path.join(root, d), path.join(stage, d), {
    recursive: true,
    filter: (src) => {
      const name = src.split(path.sep).pop() ?? "";
      if (skipNames.has(name)) return false;
      if (skipSuffixes.some((suffix) => name.endsWith(suffix))) return false;
      return true;
    },
  });
}

// 4.5 沙盒残留清洗（staging 副本上执行，绝不写回沙盒本地库），随后从副本读出
//     随包全局配置/验证方式打印 —— 这里才是真正随包分发的最终数据，交付前逐项核对
for (const dbFile of ["prisma/bot-groups.db", "db/custom.db"]) {
  sanitizeShippedDb(path.join(stage, dbFile));
  dumpShippedConfig(path.join(stage, dbFile));
}

// 4.6 遗留文件清理清单（upgrade-cleanup.txt）：
//     发布包解压覆盖升级时，历史版本中「后来被删除」的文件会以幽灵文件残留在
//     部署目录 —— 如 v2.1.12 已删除的 src/app/api/admin/bots/preview/route.ts
//     仍 import 已移除的 executeMenuApi，导致 Cloudflare CI next build 失败。
//     打包时从主线 git 历史提取「曾存在、现已删除」且位于发布分发范围内的路径
//     随包分发；构建前 scripts/prebuild-clean.mjs 据此自动清除。
//     安全硬边界：仅限发布分发目录/根文件；数据库/.env/日志/构建产物一律不入清单。
const SENSITIVE_DIR_TOPS = ["db", "download", "node_modules", ".next", ".open-next", ".vercel", ".package-stage"];

function isSensitivePath(rel) {
  const top = rel.split(path.sep)[0];
  if (SENSITIVE_DIR_TOPS.includes(top)) return true;
  if (/\.(db|db-wal|db-shm)$/.test(rel)) return true;
  if (/(^|[\\/])\.env/.test(rel)) return true;
  if (/\.log$/.test(rel)) return true;
  return false;
}

function isPackagedPath(rel) {
  const top = rel.split(path.sep)[0];
  return includeDirs.includes(top) || includeRootFiles.includes(rel);
}

function collectLegacyGhosts() {
  const gitOutput = execSync("git -c core.quotepath=false log HEAD --pretty=format: --name-only", {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ghosts = new Set();
  for (const raw of gitOutput.split("\n")) {
    const rel = raw.trim();
    if (!rel || rel.includes("\t")) continue;
    const normalized = rel.split("/").join(path.sep);
    if (path.isAbsolute(normalized)) continue;
    const abs = path.join(root, normalized);
    if (path.relative(root, abs).startsWith("..")) continue;
    if (existsSync(abs)) continue;
    if (!isPackagedPath(normalized)) continue;
    if (isSensitivePath(normalized)) continue;
    ghosts.add(normalized);
  }
  return [...ghosts].sort();
}

const legacyGhosts = collectLegacyGhosts();
writeFileSync(
  path.join(stage, "upgrade-cleanup.txt"),
  [
    `# upgrade-cleanup.txt —— 解压覆盖升级遗留文件清理清单（v${pkg.version} 打包时自动生成）`,
    "# 由 scripts/prebuild-clean.mjs 在每次 npm run build 最前读取执行：",
    "# 清除历史版本遗留、当前版本已不存在的幽灵文件（如旧路由 import 已移除导出导致构建失败）。",
    "# 本文件随包自动生成，禁止手工编辑；清理范围仅限发布分发文件，绝不涉及数据库/.env/日志。",
    "",
    ...legacyGhosts,
    "",
  ].join("\n"),
);
console.log(`   ── upgrade-cleanup.txt：${legacyGhosts.length} 条历史遗留路径入清单 ──`);
for (const g of legacyGhosts) console.log(`   · ${g}`);

// 5. 产品默认 .env。沙盒本地 .env 不入包。
writeFileSync(
  path.join(stage, ".env"),
  [
    "# TGuard 环境配置（产品默认值）",
    `# 版本：v${pkg.version}`,
    "",
    "DATABASE_URL=file:./db/custom.db",
    "DATABASE_URI=file:./prisma/bot-groups.db",
    "",
    `NEXT_PUBLIC_APP_VERSION=${pkg.version}`,
    "",
    "# ---- Telegram Bot API 连接 ----",
    "# 默认（推荐）：管理后台「系统设置」中开启 Telegram API 代理（telegram.proxy_enabled，默认开启），",
    "#   Node 服务器/沙盒无法直连 api.telegram.org 时自动走 HTTP 前缀代理（telegram.proxy_url），",
    "#   代理请求失败自动回退直连；修改设置后立即生效，无需重启。",
    "# Cloudflare Pages/Workers 部署始终直连，不使用代理。",
    "# 自建反代可选：TELEGRAM_API_ROOT=https://your-worker.example.com（覆盖上游 origin，",
    "#   此时代理改写为 <代理前缀><TELEGRAM_API_ROOT>/...）",
    "",
  ].join("\n"),
);

// 6. 压缩
if (existsSync(zipPath)) {
  rmSync(zipPath);
}
execSync(`cd "${stage}" && zip -q -r "${zipPath}" .`, { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });

const size = statSync(zipPath).size;
const kb = (size / 1024).toFixed(1);
console.log("");
console.log(`✅ 打包完成: download/${cfg.projectName}-v${pkg.version}.zip (${kb} KB)`);
console.log(`   版本源: package.json -> "version": "${pkg.version}"`);
