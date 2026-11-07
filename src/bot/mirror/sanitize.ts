/**
 * 出站文本/URL 清洗：抹去目标 bot 痕迹（@提及、深链、裸链、品牌词）。
 * 纯函数，Edge/Node 通用；单测见 scripts/test-mirror-sanitize.ts。
 */

export interface SanitizeOptions {
  targetBot: string; // 不带 @，如 "My_Telegram_RoBot"
  proxyBot: string; // 不带 @，壳 bot 用户名
  rewriteRules?: Record<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function applyRewriteRules(text: string, rules: Record<string, string>): string {
  let result = text;
  for (const [from, to] of Object.entries(rules)) {
    if (!from) continue;
    result = result.replace(new RegExp(escapeRegExp(from), "gi"), to);
  }
  return result;
}

/**
 * 深链重写：t.me/<target>?start=x → t.me/<proxy>?start=x。
 * 无法重写的目标域链接（如 t.me/<target>/screenshot 路径页）整段移除。
 */
export function rewriteTelegramLinks(text: string, options: SanitizeOptions): string {
  const { targetBot, proxyBot } = options;
  const targetPattern = escapeRegExp(targetBot);
  const deepLink = new RegExp(`t\\.me/${targetPattern}(\\?[^\\s)]*)`, "gi");
  const bareLink = new RegExp(`(?:https?://)?t\\.me/${targetPattern}(?!\\?)`, "gi");
  return text
    .replace(deepLink, `t.me/${proxyBot}$1`)
    .replace(bareLink, "");
}

/**
 * 文本清洗主入口：
 * 1. rewriteRules 词表替换（品牌词/名称）
 * 2. @target 提及 → @proxy
 * 3. t.me 深链/裸链重写或移除
 */
export function sanitizeText(text: string, options: SanitizeOptions): string {
  if (!text) return text;
  let result = applyRewriteRules(text, options.rewriteRules ?? {});
  result = result.replace(
    new RegExp(`@${escapeRegExp(options.targetBot)}\\b`, "gi"),
    `@${options.proxyBot}`,
  );
  result = rewriteTelegramLinks(result, options);
  return result;
}

/**
 * URL 按钮 / 实体链接清洗：
 * - 深链 t.me/<target>?start=x → t.me/<proxy>?start=x
 * - 指向目标 bot 的其他链接返回 ""（调用方删除该按钮/实体）
 */
export function sanitizeUrl(url: string, options: SanitizeOptions): string {
  if (!url) return url;
  const deepLinkMatch = new RegExp(
    `^(?:https?://)?t\\.me/${escapeRegExp(options.targetBot)}(\\?[^\\s]*)$`,
    "i",
  ).exec(url);
  if (deepLinkMatch) return `https://t.me/${options.proxyBot}${deepLinkMatch[1]}`;
  if (new RegExp(`^https?://t\\.me/${escapeRegExp(options.targetBot)}(/|$|\\?)`, "i").test(url)) {
    return "";
  }
  return url;
}

/** 实体文本清理（Bot API MarkdownV2/HTML 实体无法逐一定位时，退化为整段清洗） */
export function sanitizeCaption(caption: string | undefined, options: SanitizeOptions): string | undefined {
  if (!caption) return caption;
  return sanitizeText(caption, options);
}

/** HTML 模式下组合「清洗 + 转义」的便捷入口：纯文本先清洗再转义 */
export function sanitizeTextAsHtml(text: string, options: SanitizeOptions): string {
  return escapeHtml(sanitizeText(text, options));
}
