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
  | "api"
  | "submenu"
  | "back"
  | "url"
  | "web_app"
  | "switch_inline"
  | "switch_inline_current";

export interface MenuApiHeader {
  key: string;
  value: string;
}

export interface MenuApiConfig {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: MenuApiHeader[];
  body_template: string;
  success_status: number;
  timeout_seconds: number;
  response_template: string;
}

export interface MenuButtonAction {
  type: MenuActionType;
  text?: string;
  content?: MenuMessageContent;
  api?: MenuApiConfig;
  url?: string;
  switch_query?: string;
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
  "api",
  "submenu",
  "back",
  "url",
  "web_app",
  "switch_inline",
  "switch_inline_current",
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

function parseApi(raw: unknown): MenuApiConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const api = raw as Partial<MenuApiConfig>;
  return {
    method: (["GET", "POST", "PUT", "DELETE"] as const).includes(api.method as MenuApiConfig["method"])
      ? (api.method as MenuApiConfig["method"])
      : "GET",
    url: typeof api.url === "string" ? api.url : "",
    headers: Array.isArray(api.headers)
      ? api.headers
          .filter(
            (h): h is MenuApiHeader =>
              typeof h === "object" && h !== null && typeof (h as MenuApiHeader).key === "string",
          )
          .map((h) => ({ key: String(h.key), value: String(h.value ?? "") }))
      : [],
    body_template: typeof api.body_template === "string" ? api.body_template : "",
    success_status: typeof api.success_status === "number" && api.success_status > 0 ? api.success_status : 200,
    timeout_seconds: typeof api.timeout_seconds === "number" && api.timeout_seconds > 0 ? api.timeout_seconds : 10,
    response_template: typeof api.response_template === "string" ? api.response_template : "",
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
  const api = parseApi(source.api);
  if (api) action.api = api;
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

export interface MenuApiResult {
  ok: boolean;
  text: string;
  status: number;
}

export async function executeMenuApi(
  api: MenuApiConfig,
  vars: MenuTemplateVars,
): Promise<MenuApiResult> {
  if (!api.url.trim()) {
    return { ok: false, text: "接口地址未配置", status: 0 };
  }
  const headers: Record<string, string> = {};
  for (const header of api.headers ?? []) {
    const key = header.key.trim();
    if (!key) continue;
    headers[key] = renderMenuTemplate(header.value, vars);
  }
  const method = api.method ?? "GET";
  let url = renderMenuTemplate(api.url, vars);
  let body: string | undefined;
  if (method === "GET") {
    if (api.body_template?.trim()) {
      const query = renderMenuTemplate(api.body_template, vars);
      url = `${url}${url.includes("?") ? "&" : "?"}${query}`;
    }
  } else {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    body = api.body_template?.trim() ? renderMenuTemplate(api.body_template, vars) : JSON.stringify({});
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout((api.timeout_seconds ?? 10) * 1000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, text: `接口请求失败：${detail}`, status: 0 };
  }

  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = raw;
  }

  if (response.status !== (api.success_status ?? 200)) {
    const apiError =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as Record<string, unknown>).error)
        : "";
    return {
      ok: false,
      text: apiError || `接口返回状态码 ${response.status}`,
      status: response.status,
    };
  }

  const template = api.response_template?.trim();
  const text = template
    ? renderMenuTemplate(template, { ...vars, res: payload })
    : typeof payload === "string"
      ? payload
      : JSON.stringify(payload, null, 2);
  return { ok: true, text: text || "（接口返回空内容）", status: response.status };
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
