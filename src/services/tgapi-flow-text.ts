/**
 * TGAPI 申请流程纯文本工具（v2.2.1）—— 无任何服务端依赖（grammy 类型仅 type-only）：
 *
 * 运行端（bot/handlers/tgapi.ts、tgapi-conversation.ts）与客户端仿真屏
 * （TGAPI「菜单和键盘」弹窗的自定义键盘流程仿真）共用同一实现，
 * 保证「部署后在 APP 中的展现界面和交互逻辑跟仿真屏完全一致」。
 *
 * - extractTgWebLoginCode：原 services/my-telegram-org.ts（extract_code_imn_ges 增强版）
 * - extractPhoneNumber / buildAppResultHTML / briefError：原 bot/handlers/tgapi.ts
 */

import type { MessageEntity } from "grammy/types";
import type { TgAppInfo } from "@/services/my-telegram-org";
import { htmlEscape } from "@/utils/html";

/**
 * extract_code_imn_ges 增强版（v2.1.8）：从用户消息提取 Telegram Web 登录码。
 * 机器人与管理端申请向导共用（机器人收「转发的服务通知消息」，向导收「粘贴的消息文本」，
 * 两者都是纯文本，解析逻辑完全一致）。
 *
 * 已知消息形态（Telegram 777000 服务通知）：
 *  1. "Web login code: 12345"（原版 trial-and-error 依据的 "web login code" 关键字）
 *  2. "Login code: 12345\n\nDo not give this code to anyone, ... "（新版措辞）
 *  3. "登录码：9VC6TeKMTQY"（中文措辞 —— v2.2.8：关键字补中文「登录码」）
 *  4. 用户手输/复制的独立验证码行
 *  5. 新版混合码：Telegram 新版登录码为字母数字混合（如 9VC6TeKMTQY），非纯数字
 *     —— v2.2.8：关键字行冒号后 / 关键字行后续行 / 整行三种形态均支持混合码提取
 * 解析优先级：
 *  a) 关键字行（web login code / login code / 登录码）冒号后的数字段或混合码；
 *  b) 原版第二行试错结论：关键字行的后续非空行中的数字段或混合码；
 *  c) 整行即验证码（纯数字独立行 / 字母数字混合独立行）；
 *  d) 首个行内独立数字段（3-8 位，不吞长数字的片段）；
 *  e) 单行原文兜底（原版行为：单行原样提交）。
 */
export function extractTgWebLoginCode(messageText: string): string | null {
  const text = messageText.trim();
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  /** 行内独立数字段（3-8 位；前后不能还是数字，避免吞掉手机号片段） */
  const codeInLine = (line: string): string | null =>
    line.match(/(?<!\d)\d{3,8}(?!\d)/)?.[0] ?? null;
  /**
   * 行内字母数字混合码（v2.2.8）：Telegram 新版登录码形态（如 9VC6TeKMTQY）。
   * 词边界内 6-16 位 token，必须同时含字母与数字 —— 纯英文单词（anyone/Telegram）
   * 与纯数字段均被排除，正文警示行不会被误提取。
   */
  const mixedCodeInLine = (line: string): string | null => {
    for (const m of line.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{6,16}(?![A-Za-z0-9])/g)) {
      const token = m[0] ?? "";
      if (/[A-Za-z]/.test(token) && /\d/.test(token)) return token;
    }
    return null;
  };

  const keywordIndex = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes("web login code") ||
      lower.includes("login code") ||
      line.includes("登录码") ||
      line.includes("登录代码")
    );
  });

  if (keywordIndex >= 0) {
    // a) 关键字行冒号后直接跟验证码（"Web login code: 12345" / "登录码：9VC6TeKMTQY"）
    const keywordLine = lines[keywordIndex] ?? "";
    const afterColon = keywordLine.split(/[:：]/).slice(1).join(":").trim();
    if (afterColon) {
      const code = codeInLine(afterColon) ?? mixedCodeInLine(afterColon);
      if (code) return code;
    }
    // b) 原版第二行试错结论：验证码在关键字行的后续非空行
    for (let i = keywordIndex + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const code = codeInLine(line) ?? mixedCodeInLine(line);
      if (code) return code;
    }
  }

  // c) 整行即验证码（手输/复制的独立码行：旧版纯数字，或新版字母数字混合）
  for (const line of lines) {
    if (/^\d{3,8}$/.test(line)) return line;
  }
  for (const line of lines) {
    if (/^[A-Za-z0-9]{6,16}$/.test(line) && /[A-Za-z]/.test(line) && /\d/.test(line)) {
      return line;
    }
  }
  // d) 首个行内独立数字段（多行且无关键字，如转发的旧版通知）
  for (const line of lines) {
    const code = codeInLine(line);
    if (code) return code;
  }
  // e) 单行原文兜底（原版行为：单行原样作为验证码提交）
  if (lines.length === 1) {
    return lines[0] ?? null;
  }
  return null;
}

/**
 * get_phno_imn_ges 原样移植：提取国际格式手机号。
 * 优先级：phone_number 实体片段（Telegram 已校验）＞ 联系人号码 ＞ 原文。
 */
export function extractPhoneNumber(
  messageText: string,
  entities: MessageEntity[] | undefined,
  contactPhone: string | null,
): string | null {
  if (entities && entities.length > 0) {
    for (const entity of entities) {
      if (entity.type === "phone_number") {
        return messageText.slice(entity.offset, entity.offset + entity.length).trim();
      }
    }
  }
  if (contactPhone && contactPhone.trim()) {
    return contactPhone.trim();
  }
  return null;
}

/**
 * parse_to_meaning_ful_text 原样移植：把抓取结果组装为 Telegram HTML 消息。
 * 结构与原实现逐字一致（Phone Number / App Configuration / Available MTProto
 * Servers / Disclaimer），占位值做 HTML 转义（原实现未转义，这里只加固不改变结构）。
 */
export function buildAppResultHTML(phone: string, info: TgAppInfo): string {
  return (
    "<i>Phone Number</i>: " +
    `<u>${htmlEscape(phone)}</u>` +
    "\n\n" +
    "<i>App Configuration</i>\n" +
    "<b>APP ID</b>: " +
    `<code>${htmlEscape(info.appId)}</code>` +
    "\n" +
    "<b>API HASH</b>: " +
    `<code>${htmlEscape(info.apiHash)}</code>` +
    "\n\n" +
    "<i>Available MTProto Servers</i>\n" +
    "<b>Production Configuration</b>: " +
    `<code>${htmlEscape(info.productionConfiguration.ip)}</code> <u>${htmlEscape(info.productionConfiguration.dc)}</u>` +
    "\n" +
    "<b>Test Configuration</b>: " +
    `<code>${htmlEscape(info.testConfiguration.ip)}</code> <u>${htmlEscape(info.testConfiguration.dc)}</u>` +
    "\n\n" +
    "<i>Disclaimer</i>: " +
    "<u>It is forbidden to pass this value to third parties.</u>"
  );
}

/** TGAPI 机器人错误详情的终端截断长度（详细日志进 dev.log，用户侧截断展示） */
export function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
