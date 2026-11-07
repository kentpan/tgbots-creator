/**
 * 键盘重建的中立结构层：不依赖 telegram 包类型（Edge bundle 安全）。
 * TL → 中立结构的映射在 src/relay/tl-adapter.ts（仅 Node 中继面）。
 */

export type TlButton =
  | { kind: "callback"; text: string; data: Uint8Array }
  | { kind: "url"; text: string; url: string }
  | { kind: "url_auth"; text: string; url: string; buttonId: number }
  | { kind: "switch_inline"; text: string; query: string; samePeer: boolean }
  | { kind: "web_app"; text: string; url: string }
  | { kind: "unsupported"; text: string };

export interface TlMarkup {
  rows: TlButton[][];
}

export type CallbackKeyResolver = (button: Extract<TlButton, { kind: "callback" }>) => string;

export interface BuiltButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
}

export interface BuiltMarkup {
  inline_keyboard: BuiltButton[][];
}

const CALLBACK_KEY_LIMIT = 64;

/**
 * TL 中立结构 → Bot API InlineKeyboardMarkup。
 * - callback 按钮：data 经 resolver 换成 32 hex proxy_key（由调用方写 mirror_callbacks）
 * - url 按钮：url 先经 sanitize 再输出
 * - web_app 按钮：目标 bot 域名绑定无法代理 → 降级为 URL 按钮
 * - switch_inline：无法完美代理 → 忽略（保留文本占位会误导用户）
 * - url_auth：无 Bot API 等价物 → 降级 URL
 */
export function buildProxyInlineKeyboard(
  markup: TlMarkup | null,
  options: {
    resolveCallbackKey: CallbackKeyResolver;
    sanitizeUrl: (url: string) => string;
  },
): BuiltMarkup | undefined {
  if (!markup || markup.rows.length === 0) return undefined;
  const inline_keyboard: BuiltButton[][] = [];
  for (const row of markup.rows) {
    const builtRow: BuiltButton[] = [];
    for (const button of row) {
      switch (button.kind) {
        case "callback": {
          const key = options.resolveCallbackKey(button);
          if (key.length === 0 || key.length > CALLBACK_KEY_LIMIT) {
            console.error(
              `[mirror] callback key 长度非法（${key.length}），按钮「${button.text}」已跳过`,
            );
            continue;
          }
          builtRow.push({ text: button.text, callback_data: key });
          break;
        }
        case "url": {
          builtRow.push({ text: button.text, url: options.sanitizeUrl(button.url) });
          break;
        }
        case "url_auth": {
          builtRow.push({ text: button.text, url: options.sanitizeUrl(button.url) });
          break;
        }
        case "web_app": {
          const url = options.sanitizeUrl(button.url);
          if (url) builtRow.push({ text: button.text, url });
          break;
        }
        case "switch_inline":
          break;
        case "unsupported":
          break;
      }
    }
    if (builtRow.length > 0) inline_keyboard.push(builtRow);
  }
  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
}

/** 32 hex callback key（128 bit 熵，Bot API callback_data ≤64 字节限制内） */
export function generateCallbackKey(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
