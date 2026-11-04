#!/usr/bin/env node
/**
 * 孤儿进程守护启动器（经典 daemon 双 fork 惯用法）。
 *
 * 进程树演变：
 *   bash(工具调用) ──> 第一代(fork 后立即退出)
 *                        └─ 第二代(setsid 新会话, fork 后立即退出)
 *                             └─ 第三代 = 真正的服务进程
 *                                  孤儿化后被 PID 1 (tini) 收养，
 *                                  完全脱离工具调用进程树。
 *
 * 用法：node scripts/start-daemon.mjs
 */
import { fork, spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PROJECT = path.resolve(path.dirname(SELF), "..");
const SERVER = path.join(PROJECT, ".next/standalone/server.js");
const LOG = openSync("/tmp/next-server.log", "a");

const step = process.env.DAEMON_STEP ?? "1";

if (step === "1") {
  // 第一代：fork 第二代（detached => setsid 新会话），立即退出
  const child = fork(SELF, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DAEMON_STEP: "2" },
  });
  child.unref();
  process.exit(0);
}

if (step === "2") {
  // 第二代：已处于新会话；用 spawn 再 fork 一次后退出 → 第三代成为孤儿
  // （服务进程不需要 IPC 通道，故不用 fork，避免 ERR_CHILD_PROCESS_IPC_REQUIRED）
  const grandchild = spawn(process.execPath, [SELF], {
    detached: true,
    stdio: ["ignore", LOG, LOG],
    env: { ...process.env, DAEMON_STEP: "3" },
  });
  grandchild.unref();
  process.exit(0);
}

// 第三代：孤儿服务进程，加载 Next.js standalone server
process.chdir(path.dirname(SERVER));
process.env.NODE_ENV = "production";
import(SERVER).catch((err) => {
  process.stderr.write(`daemon server failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
