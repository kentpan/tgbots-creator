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
 * Telegram Web 登录码：严格从官方通知的英文 `login code:` 标签后提取。
 * 官方通知正文格式固定；不再尝试中文关键字、猜测裸码或校验码长，避免误提取。
 */
export function extractTgWebLoginCode(messageText: string): string | null {
  // /im：大小写不敏感 + 多行模式；优先提取连续字母数字码，兼容标签后同一行的其它文本。
  const match = messageText.match(/login code:\s*([a-zA-Z0-9]+|[^\r\n]+)/im);
  const code = match?.[1]?.trim();
  return code || null;
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
