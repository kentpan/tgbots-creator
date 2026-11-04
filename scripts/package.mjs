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
  const abs = path.join(root, dbFile);
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
dumpShippedConfig("prisma/bot-groups.db");
dumpShippedConfig("db/custom.db");

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
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
];
const includeDirs = [".github", "prisma", "public", "scripts", "src"];
const skipNames = new Set(["dev.log", ".package-stage", "node_modules", ".vercel"]);

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
    filter: (src) => !skipNames.has(src.split(path.sep).pop() ?? ""),
  });
}

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
