/**
 * 跨形态加密工具（Node / Edge 双形态等价实现）。
 *
 * - Node 形态（本地/沙盒/standalone）：直接使用 node:crypto（行为与原实现一致）；
 * - Edge 形态（Cloudflare Pages）：node:crypto 静态 import 会使 Edge bundle
 *   模块求值时 "Native module not found: node:crypto" 构建失败
 *   （2026-11-04 GitHub Actions 实测），改用语义等价的标准实现。
 *
 * 等价性说明：
 *  - timingSafeEqual：Edge 分支采用 Node 官方文档描述的 constant-time 逐字节
 *    XOR 累加比较（安全语义相同：长度不同立即 false，等长时耗时恒定不泄漏内容）；
 *  - randomInt(min, max)：Edge 分支用 WebCrypto getRandomValues + 拒绝采样
 *    （rejection sampling，消除模偏差的标准算法），分布与 node:crypto 等价。
 * 不做任何静默兜底：Node 形态若 require 失败会抛出详细错误。
 */
import { isEdgeRuntime, requireNodeBuiltin } from "@/lib/node-runtime";

type NodeCryptoModule = typeof import("node:crypto");

function nodeCrypto(): NodeCryptoModule {
  return requireNodeBuiltin<NodeCryptoModule>("node:crypto");
}

/**
 * 恒定时间比较（入参为等长 Buffer/Uint8Array；长度不等直接返回 false，
 * 与 node:crypto.timingSafeEqual 抛错语义不同 —— 调用方原本就在比较前
 * 自行检查长度（详见各 webhook route），本函数保持调用方的既有约定）。
 */
export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  if (isEdgeRuntime) {
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a[i]! ^ b[i]!;
    }
    return diff === 0;
  }
  return nodeCrypto().timingSafeEqual(a, b);
}

/** [min, max) 区间内的加密安全随机整数（语义同 node:crypto.randomInt）。 */
export function randomInt(min: number, max: number): number {
  if (isEdgeRuntime) {
    const range = max - min;
    if (range <= 0) {
      throw new Error(`[crypto] randomInt 需要非空区间，收到 min=${min} max=${max}`);
    }
    const buf = new Uint32Array(1);
    // 拒绝采样：丢弃落在最后一个不完整区间内的取值，保证均匀分布
    const limit = Math.floor(0x100000000 / range) * range;
    let value: number;
    do {
      crypto.getRandomValues(buf);
      value = buf[0]!;
    } while (value >= limit);
    return min + (value % range);
  }
  return nodeCrypto().randomInt(min, max);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateVerificationToken(length = 32): string {
  let token = "";
  for (let i = 0; i < length; i++) {
    token += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return token;
}

/**
 * 入群验证码生成（v1.1.7 code_self 方式：机器人自生成验证码，用户私聊回复输入）。
 *
 * 纯数字（手机端输入成本最低），默认 6 位，首位非 0（避免短信式验证码
 * 常见的「丢前导零」输入困惑）；字符级加密安全随机（randomInt），
 * 无模偏差，不可预测。
 */
export function generateJoinCode(length = 6): string {
  let code = String(randomInt(1, 10));
  for (let i = 1; i < length; i++) {
    code += String(randomInt(0, 10));
  }
  return code;
}

export function generateSessionId(length = 16): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = randomInt(0, 256);
  }
  return Buffer.from(bytes).toString("base64url");
}
