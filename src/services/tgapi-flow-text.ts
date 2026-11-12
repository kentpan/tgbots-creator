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
 * Telegram Web 登录码的两种合法形态：
 * - 旧版：3-8 位纯数字（如 12345）
 * - 新版：6-16 位字母数字混合且必须同时含字母与数字（如 abQ4fb6aJTE）
 * 纯英文单词、纯数字手机号、正文编号都不算登录码。
 */
function isTgWebLoginCodeToken(token: string): boolean {
  if (/^\d{3,8}$/.test(token)) return true;
  return (
    /^[A-Za-z0-9]{6,16}$/.test(token) &&
    /[A-Za-z]/.test(token) &&
    /\d/.test(token)
  );
}

/** 行内字母数字连续段（my.telegram.org 会拆成 my/telegram/org，不会被误当码） */
function alphanumericTokens(line: string): string[] {
  return line.match(/[A-Za-z0-9]+/g) ?? [];
}

/** 官方服务通知里标识登录码位置的关键字（大小写不敏感） */
const LOGIN_CODE_KEYWORDS = ["web login code", "login code", "登录码", "登录代码"];

/**
 * 从用户消息提取 Telegram Web 登录码（机器人转发/粘贴的官方服务通知，或用户直接发的裸码）。
 *
 * 只认两个位置，识别不出就返回 null：
 *  1. 关键字行及其后的「整行即登录码」—— Telegram 官方模板把码独占一行，裸发码也是这种形态；
 *  2. 关键字行冒号后的第一个字母数字段 —— "Login code: 12345" / "登录码：abQ4fb6aJTE"，
 *     以及整段消息被客户端折叠成一行时 "…login code: abQ4fb6aJTE Do not give…"。
 *
 * 有关键字时只在其所在行及之后查找，用户自加的前置问候、转发头不会干扰。
 * 绝不把整行原文、正文首个数字段或任意像码的 token 当登录码提交给 /auth/login。
 */
export function extractTgWebLoginCode(messageText: string): string | null {
  const lines = messageText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const keywordIndex = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return LOGIN_CODE_KEYWORDS.some((keyword) => lower.includes(keyword));
  });
  const candidates = keywordIndex >= 0 ? lines.slice(keywordIndex) : lines;

  for (const line of candidates) {
    if (isTgWebLoginCodeToken(line)) return line;
  }

  if (keywordIndex >= 0) {
    const keywordLine = lines[keywordIndex] ?? "";
    const afterColon = keywordLine.split(/[:：]/).slice(1).join(":").trim();
    const firstToken = alphanumericTokens(afterColon)[0];
    if (firstToken && isTgWebLoginCodeToken(firstToken)) return firstToken;
  }

  return null;
}

/**
 * 手机号归一化（管理端向导与机器人流程共用）：去空白/连字符/括号，
 * 校验国际格式 7-15 位数字，统一补 + 前缀。不合法返回 null。
 */
export function normalizeApplyPhone(raw: unknown): string | null {
  const phone = String(raw ?? "")
    .trim()
    .replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(phone)) return null;
  return phone.startsWith("+") ? phone : `+${phone}`;
}

/**
 * get_phno_imn_ges 增强版：提取国际格式手机号。
 * 优先级：phone_number 实体片段（Telegram 已校验）＞ 联系人号码 ＞ 手输纯文本。
 * 手输只接受「整条消息就是一个手机号」，不在正文里捞号，避免把登录码或正文数字当手机号。
 */
export function extractPhoneNumber(
  messageText: string,
  entities: MessageEntity[] | undefined,
  contactPhone: string | null,
): string | null {
  if (entities && entities.length > 0) {
    for (const entity of entities) {
      if (entity.type === "phone_number") {
        const normalized = normalizeApplyPhone(
          messageText.slice(entity.offset, entity.offset + entity.length),
        );
        if (normalized) return normalized;
      }
    }
  }
  const fromContact = normalizeApplyPhone(contactPhone);
  if (fromContact) return fromContact;
  return normalizeApplyPhone(messageText);
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
