export const MENU_MAX_BUTTONS_PER_ROW = 8;
export const MENU_MAX_BUTTONS_TOTAL = 100;
export const MENU_MAX_ROWS = 20;
export const MENU_MAX_DEPTH = 5;
export const MENU_MAX_MEDIA_ITEMS = 10;

export type MenuMediaType = "photo" | "video";
export type MenuContentType = "text" | "photo" | "video" | "media_group";

export interface MenuMediaItem {
  type: MenuMediaType;
  url: string;
  caption: string;
}

export interface MenuMessageContent {
  type: MenuContentType;
  text: string;
  mediaUrl: string;
  items: MenuMediaItem[];
}

export type MenuActionType =
  | "reply"
  | "verify"
  | "submenu"
  | "back"
  | "url"
  | "web_app"
  | "switch_inline"
  | "switch_inline_current"
  | "command";

/**
 * 外部验证 API 按钮配置（v2.1.12）：与「验证方式」库 / 群组外部 API 验证同一机制 ——
 * 绑定验证方式库中的验证方法（code_api：验证 API 地址 / Bearer apikey / 传参 /
 * 响应解析 / 超时均在验证方式中统一配置，此处直接复用），点击按钮后要求在输入框
 * 回复验证码并真实核验；提示/成功/失败文案可自定义（留空用默认文案）。
 */
export interface MenuVerifyConfig {
  /** 绑定的验证方式 id（verification_methods.id，type=code_api） */
  method_id: string;
  /** 输入提示文案（v2.1.14：点击按钮后先发送的提示；留空用默认「✍🏻 请在下方的输入框进行输入:」） */
  input_hint_text?: string;
  /** 提示文案（force-reply 消息；留空用默认） */
  prompt_text?: string;
  /** 成功文案（留空用默认） */
  success_text?: string;
  /** 失败文案（留空用默认） */
  fail_text?: string;
}

export interface MenuButtonAction {
  type: MenuActionType;
  text?: string;
  content?: MenuMessageContent;
  /** verify 类型专用：绑定的验证方法与自定义文案 */
  verify?: MenuVerifyConfig;
  url?: string;
  switch_query?: string;
  /** command 类型专用：点击后真实执行的指令名（不含 /；内置或自定义指令） */
  target?: string;
}

export interface MenuButton {
  id: string;
  text: string;
  action: MenuButtonAction;
  submenu?: MenuNode;
}

export interface MenuRow {
  id: string;
  buttons: MenuButton[];
}

export interface MenuNode {
  rows: MenuRow[];
}

export interface BotMenuConfig {
  content: MenuMessageContent;
  root: MenuNode;
}

export const DEFAULT_MENU_TEXT = "📋 请使用下方菜单：";

export function emptyContent(): MenuMessageContent {
  return { type: "text", text: DEFAULT_MENU_TEXT, mediaUrl: "", items: [] };
}

export function emptyMenuConfig(): BotMenuConfig {
  return { content: emptyContent(), root: { rows: [] } };
}

const CONTENT_TYPES: MenuContentType[] = ["text", "photo", "video", "media_group"];
const ACTION_TYPES: MenuActionType[] = [
  "reply",
  "verify",
  "submenu",
  "back",
  "url",
  "web_app",
  "switch_inline",
  "switch_inline_current",
  "command",
];

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function parseContent(raw: unknown): MenuMessageContent {
  const fallback = emptyContent();
  if (typeof raw !== "object" || raw === null) return fallback;
  const source = raw as Partial<MenuMessageContent>;
  const type = CONTENT_TYPES.includes(source.type as MenuContentType)
    ? (source.type as MenuContentType)
    : "text";
  const content: MenuMessageContent = {
    type,
    text: typeof source.text === "string" ? source.text : "",
    mediaUrl: typeof source.mediaUrl === "string" && isHttpUrl(source.mediaUrl) ? source.mediaUrl.trim() : "",
    items: [],
  };
  if (type === "media_group" && Array.isArray(source.items)) {
    content.items = source.items
      .slice(0, MENU_MAX_MEDIA_ITEMS)
      .filter(
        (item): item is MenuMediaItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Partial<MenuMediaItem>).url === "string" &&
          isHttpUrl(String((item as Partial<MenuMediaItem>).url)),
      )
      .map((item) => ({
        type: item.type === "video" ? "video" : "photo",
        url: item.url.trim(),
        caption: typeof item.caption === "string" ? item.caption : "",
      }));
  }
  if ((type === "photo" || type === "video") && !content.mediaUrl) {
    return { ...content, type: "text" };
  }
  if (type === "media_group" && content.items.length === 0) {
    return { ...content, type: "text" };
  }
  return content;
}

function parseVerify(raw: unknown): MenuVerifyConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const verify = raw as Partial<MenuVerifyConfig>;
  const methodId = typeof verify.method_id === "string" ? verify.method_id.trim() : "";
  if (!methodId) return undefined;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    method_id: methodId,
    input_hint_text: text(verify.input_hint_text),
    prompt_text: text(verify.prompt_text),
    success_text: text(verify.success_text),
    fail_text: text(verify.fail_text),
  };
}

function parseAction(raw: unknown): MenuButtonAction {
  const fallback: MenuButtonAction = { type: "reply", text: "" };
  if (typeof raw !== "object" || raw === null) return fallback;
  const source = raw as Partial<MenuButtonAction>;
  if (!ACTION_TYPES.includes(source.type as MenuActionType)) return fallback;
  const action: MenuButtonAction = { type: source.type as MenuActionType };
  if (typeof source.text === "string") action.text = source.text;
  if (typeof source.url === "string") action.url = source.url;
  if (typeof source.switch_query === "string") action.switch_query = source.switch_query;
  if (typeof source.target === "string") action.target = source.target;
  const verify = parseVerify(source.verify);
  if (verify) action.verify = verify;
  const content = parseContent(source.content);
  if (source.type === "reply" && (content.type !== "text" || content.text)) {
    action.content = content;
    if (content.text) action.text = content.text;
  }
  return action;
}

function parseNode(raw: unknown, depth: number): MenuNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Partial<MenuNode>;
  if (!Array.isArray(source.rows) || depth > MENU_MAX_DEPTH) return null;
  const rows: MenuRow[] = [];
  for (const row of source.rows.slice(0, MENU_MAX_ROWS)) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Partial<MenuRow>;
    const buttons: MenuButton[] = [];
    if (Array.isArray(r.buttons)) {
      for (const button of r.buttons.slice(0, MENU_MAX_BUTTONS_PER_ROW)) {
        if (typeof button !== "object" || button === null) continue;
        const b = button as Partial<MenuButton>;
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text) continue;
        const parsed: MenuButton = {
          id: typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 24) : "",
          text: text.slice(0, 64),
          action: parseAction(b.action),
        };
        if (parsed.action.type === "submenu") {
          const child = depth < MENU_MAX_DEPTH ? parseNode((b as Partial<MenuButton>).submenu, depth + 1) : null;
          if (child) {
            parsed.submenu = child;
            delete parsed.action.target;
          } else if (depth >= MENU_MAX_DEPTH) {
            parsed.action = { type: "reply", text: "" };
          }
        }
        buttons.push(parsed);
      }
    }
    rows.push({ id: typeof r.id === "string" ? r.id : "", buttons });
  }
  return { rows };
}

export function parseBotMenuConfig(raw: string | null | undefined): BotMenuConfig {
  const fallback = emptyMenuConfig();
  if (!raw || !raw.trim()) return fallback;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof data !== "object" || data === null) return fallback;
  const source = data as Record<string, unknown>;
  if (source.root !== undefined) {
    const root = parseNode(source.root, 1);
    if (!root) return fallback;
    return { content: parseContent(source.content), root };
  }
  return migrateLegacyConfig(source);
}

interface LegacyPage {
  id: string;
  rows: MenuRow[];
}

function migrateLegacyConfig(source: Record<string, unknown>): BotMenuConfig {
  const fallback = emptyMenuConfig();
  const messageText =
    typeof source.messageText === "string" && source.messageText.trim()
      ? source.messageText
      : DEFAULT_MENU_TEXT;
  const rawPages = Array.isArray(source.pages) ? source.pages : [];
  const pages: LegacyPage[] = [];
  for (const page of rawPages.slice(0, 20)) {
    if (typeof page !== "object" || page === null) continue;
    const p = page as Partial<MenuNode> & { id?: unknown };
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim().slice(0, 16) : "";
    if (!id) continue;
    const node = parseNode({ rows: p.rows }, 1);
    if (node) pages.push({ id, rows: node.rows });
  }
  if (pages.length === 0) return { content: { ...emptyContent(), text: messageText }, root: { rows: [] } };
  const rootId =
    typeof source.rootId === "string" && pages.some((page) => page.id === source.rootId)
      ? source.rootId
      : pages[0].id;
  const used = new Set<string>([rootId]);
  const convert = (pageId: string, depth: number): MenuNode | null => {
    const page = pages.find((item) => item.id === pageId);
    if (!page || depth > MENU_MAX_DEPTH) return null;
    used.add(pageId);
    for (const row of page.rows) {
      for (const button of row.buttons) {
        if (button.action.type !== "submenu") continue;
        const target = button.action.target as unknown;
        if (typeof target !== "string" || !target || used.has(target) || target === pageId) {
          button.action = { type: "reply", text: "" };
          continue;
        }
        const child = convert(target, depth + 1);
        if (child) {
          button.submenu = child;
        } else {
          button.action = { type: "reply", text: "" };
        }
        delete button.action.target;
      }
    }
    return { rows: page.rows };
  };
  const root = convert(rootId, 1) ?? { rows: [] };
  return { content: { ...emptyContent(), text: messageText }, root };
}

export interface MenuTemplateVars {
  chat_id: string;
  user_id: string;
  username: string;
  first_name: string;
  last_name: string;
  chat_title: string;
  message_id: string;
  [key: string]: unknown;
}

function readJsonPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function renderMenuTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_match, rawPath: string) => {
    const value = readJsonPath(vars, rawPath);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

export function varsFromContext(context: {
  chat?: { id: number; title?: string } | null;
  from?: { id: number; username?: string; first_name?: string; last_name?: string } | null;
  msg?: { message_id: number } | null;
}): MenuTemplateVars {
  return {
    chat_id: String(context.chat?.id ?? ""),
    user_id: String(context.from?.id ?? ""),
    username: context.from?.username ?? "",
    first_name: context.from?.first_name ?? "",
    last_name: context.from?.last_name ?? "",
    chat_title: context.chat?.title ?? "",
    message_id: String(context.msg?.message_id ?? ""),
  };
}

export function normalizeReplyContent(action: MenuButtonAction): MenuMessageContent {
  if (action.content) {
    if (action.content.type !== "text" || action.content.text.trim()) return action.content;
  }
  return { type: "text", text: action.text ?? "", mediaUrl: "", items: [] };
}

export function countMenuStats(node: MenuNode): { buttons: number; submenus: number; depth: number } {
  let buttons = 0;
  let submenus = 0;
  let depth = 1;
  for (const row of node.rows) {
    for (const button of row.buttons) {
      buttons += 1;
      if (button.submenu) {
        submenus += 1;
        const child = countMenuStats(button.submenu);
        buttons += child.buttons;
        submenus += child.submenus;
        depth = Math.max(depth, 1 + child.depth);
      }
    }
  }
  return { buttons, submenus, depth };
}
