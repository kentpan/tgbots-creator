/**
 * 自定义键盘（v2.2.0）—— Telegram ReplyKeyboard（自定义键盘/底部键盘）配置的唯一实现。
 *
 * 与「消息内嵌按钮」（inline keyboard，附着在消息底部）互为独立能力：
 * - 通用机器人：自定义键盘附加到 /start 欢迎消息；按钮点击 = 用户发送按钮文本，
 *   运行时按按钮配置真实响应（回复内容 / 执行指令）。
 * - TGAPI申请机器人：配置非空即进入「自定义键盘对话流程」（handlers/tgapi-conversation.ts，
 *   @grammyjs/conversations 驱动），此时消息内嵌按钮不再渲染（互斥条件）。
 *
 * 按钮样式对应 grammy Keyboard 的 .style()（Bot API KeyboardButton.style）：
 * primary=蓝色（参考 https://grammy.dev/ref/core/keyboard#primary）、
 * danger=红色（#danger）、success=绿色（#success）、default=默认灰。
 */

import { Keyboard, type Keyboard as KeyboardMarkup } from "grammy";
import {
  isHttpUrl,
  type MenuButtonAction,
  type MenuMessageContent,
} from "@/services/menu-config";

export type CustomKeyboardButtonKind = "text" | "request_contact" | "request_location" | "web_app";
export type CustomKeyboardButtonStyle = "default" | "primary" | "danger" | "success";

export interface CustomKeyboardButton {
  id: string;
  text: string;
  /** 按钮类型：text=发送按钮文本；request_contact=请求共享手机号；request_location=请求位置；web_app=打开WebApp */
  kind: CustomKeyboardButtonKind;
  /** 按钮样式（KeyboardButton.style，Telegram 客户端渲染主色/危险色/成功色） */
  style: CustomKeyboardButtonStyle;
  /** web_app 专用：WebApp 地址（https） */
  url?: string;
  /**
   * kind=text 点击后的真实行为（用户点键盘按钮 = 发送按钮文本，运行时按此响应）：
   * 与消息内嵌按钮同一 MenuButtonAction 模型（v2.3 全量对齐：reply/url/web_app/
   * verify/command/switch_inline/switch_inline_current/submenu/back/language/tgapi_func）。
   * ReplyKeyboard 语义差异：submenu/back = 机器人发送子菜单键盘/上一级键盘（整键盘替换，
   * 真实 Telegram 行为）；url/web_app/switch_inline* = 机器人回复携带对应 InlineKeyboard
   * 按钮（ReplyKeyboard 按钮本身不支持这些原生类型，经回复消息真实承载）。
   * 省略 = 不响应（仅发送文本）。
   */
  action?: MenuButtonAction;
  /** submenu 专用：子菜单键盘（嵌套 ReplyKeyboard 树，深度上限 CUSTOM_KEYBOARD_MAX_DEPTH） */
  submenu?: { rows: CustomKeyboardRow[] };
}

export interface CustomKeyboardRow {
  id: string;
  buttons: CustomKeyboardButton[];
}

export interface CustomKeyboardOptions {
  /** resize_keyboard：按按钮高度自适应（推荐开启，Telegram 默认键盘观感） */
  resize: boolean;
  /** is_persistent：常驻显示（普通键盘可收起） */
  persistent: boolean;
  /** one_time_keyboard：点击后自动收起 */
  oneTime: boolean;
  /** input_field_placeholder：键盘激活时输入框占位文案 */
  inputPlaceholder: string;
}

export interface CustomKeyboardConfig {
  options: CustomKeyboardOptions;
  root: { rows: CustomKeyboardRow[] };
}

export const CUSTOM_KEYBOARD_MAX_ROWS = 10;
export const CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW = 4;
export const CUSTOM_KEYBOARD_MAX_BUTTONS_TOTAL = 40;
export const CUSTOM_KEYBOARD_TEXT_MAX_LENGTH = 40;
/** 子菜单键盘最大深度（根键盘 = 第 1 层） */
export const CUSTOM_KEYBOARD_MAX_DEPTH = 3;

const KINDS: CustomKeyboardButtonKind[] = ["text", "request_contact", "request_location", "web_app"];
const STYLES: CustomKeyboardButtonStyle[] = ["default", "primary", "danger", "success"];

/** 平台子菜单（TGAPI 设置平台）：每行 2 个、共 8 个平台按钮（对齐 APP_PLATFORM 配置） */
export const TGAPI_PLATFORM_SUBMENU_ROWS: string[][] = [
  ["android", "ios"],
  ["wp", "bb"],
  ["desktop", "web"],
  ["ubp", "other"],
];

function parseButton(
  raw: unknown,
  depth: number,
  counterRef: { total: number },
): CustomKeyboardButton | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Partial<CustomKeyboardButton>;
  const text = typeof source.text === "string" ? source.text.trim() : "";
  if (!text) return null;
  const kind = KINDS.includes(source.kind as CustomKeyboardButtonKind)
    ? (source.kind as CustomKeyboardButtonKind)
    : "text";
  const style = STYLES.includes(source.style as CustomKeyboardButtonStyle)
    ? (source.style as CustomKeyboardButtonStyle)
    : "default";
  const button: CustomKeyboardButton = {
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim().slice(0, 24) : "",
    text: text.slice(0, CUSTOM_KEYBOARD_TEXT_MAX_LENGTH),
    kind,
    style,
  };
  if (kind === "web_app") {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!isHttpUrl(url)) return null;
    button.url = url;
  }
  if (kind === "text" && typeof source.action === "object" && source.action !== null) {
    const action = source.action as Partial<MenuButtonAction>;
    // v2.3：与消息内嵌按钮同一动作模型（全量类型），ReplyKeyboard 语义差异见类型注释
    const actionType = action.type;
    const ALLOWED: MenuButtonAction["type"][] = [
      "reply",
      "command",
      "tgapi_func",
      "language",
      "url",
      "web_app",
      "verify",
      "switch_inline",
      "switch_inline_current",
      "submenu",
      "back",
    ];
    if (actionType && ALLOWED.includes(actionType)) {
      button.action = { type: actionType } as MenuButtonAction;
      if (typeof action.text === "string") button.action.text = action.text;
      if (typeof action.target === "string") button.action.target = action.target;
      if (typeof action.tgapi_func === "string") button.action.tgapi_func = action.tgapi_func;
      if (typeof action.tgapi_value === "string") button.action.tgapi_value = action.tgapi_value;
      if (action.tgapi_unlock === true) button.action.tgapi_unlock = true;
      // v2.3 通用门禁前置（与内嵌按钮同字段）
      if (action.gateRequired === true) button.action.gateRequired = true;
      if (typeof action.url === "string" && isHttpUrl(action.url)) button.action.url = action.url;
      if (typeof action.switch_query === "string") {
        button.action.switch_query = action.switch_query.slice(0, 256);
      }
      if (typeof action.verify === "object" && action.verify !== null) {
        const verifySource = action.verify as NonNullable<MenuButtonAction["verify"]>;
        const verify: NonNullable<MenuButtonAction["verify"]> = {
          method_id: typeof verifySource.method_id === "string" ? verifySource.method_id : "",
        };
        if (typeof verifySource.input_hint_text === "string") verify.input_hint_text = verifySource.input_hint_text;
        if (typeof verifySource.prompt_text === "string") verify.prompt_text = verifySource.prompt_text;
        if (typeof verifySource.success_text === "string") verify.success_text = verifySource.success_text;
        if (typeof verifySource.fail_text === "string") verify.fail_text = verifySource.fail_text;
        button.action.verify = verify;
      }
      if (typeof action.content === "object" && action.content !== null) {
        button.action.content = action.content as MenuMessageContent;
      }
      for (const slot of ["tgapi_response", "tgapi_success", "tgapi_fail"] as const) {
        const value = action[slot];
        if (typeof value === "object" && value !== null) {
          button.action[slot] = value as MenuButtonAction[typeof slot];
        }
      }
      // submenu：子菜单键盘递归解析（深度受限）
      if (actionType === "submenu" && depth < CUSTOM_KEYBOARD_MAX_DEPTH) {
        const submenuSource = source.submenu;
        if (submenuSource && typeof submenuSource === "object" && Array.isArray(submenuSource.rows)) {
          const parsed = parseRows(submenuSource.rows, depth + 1, counterRef);
          if (parsed.rows.length > 0) button.submenu = { rows: parsed.rows };
        }
      }
    }
  }
  return button;
}

/** 解析并规范化自定义键盘配置（bots.config profile.customKeyboard / tgapi.customKeyboard 共用） */
export function parseCustomKeyboardConfig(raw: unknown): CustomKeyboardConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Partial<CustomKeyboardConfig>;
  const optionsSource = (typeof source.options === "object" && source.options !== null ? source.options : {}) as Partial<CustomKeyboardOptions>;
  const config: CustomKeyboardConfig = {
    options: {
      resize: optionsSource.resize !== false,
      persistent: optionsSource.persistent === true,
      oneTime: optionsSource.oneTime === true,
      inputPlaceholder:
        typeof optionsSource.inputPlaceholder === "string" ? optionsSource.inputPlaceholder.slice(0, 64) : "",
    },
    root: { rows: [] },
  };
  if (!Array.isArray(source.root?.rows)) return null;
  const counterRef = { total: 0 };
  config.root.rows = parseRows(source.root.rows, 1, counterRef).rows;
  // 空键盘 = 未配置（运行时回落消息内嵌按钮模式）
  return config.root.rows.length > 0 ? config : null;
}

/** 递归解析键盘行（含按钮子菜单树；行/按钮/总数/深度限额统一在此收口） */
function parseRows(
  rowsRaw: unknown[],
  depth: number,
  counterRef: { total: number },
): { rows: CustomKeyboardRow[] } {
  const rows: CustomKeyboardRow[] = [];
  for (const rowRaw of rowsRaw.slice(0, CUSTOM_KEYBOARD_MAX_ROWS)) {
    if (typeof rowRaw !== "object" || rowRaw === null) continue;
    const rowSource = rowRaw as Partial<CustomKeyboardRow>;
    const buttons: CustomKeyboardButton[] = [];
    if (Array.isArray(rowSource.buttons)) {
      for (const buttonRaw of rowSource.buttons.slice(0, CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW)) {
        if (counterRef.total >= CUSTOM_KEYBOARD_MAX_BUTTONS_TOTAL) break;
        const button = parseButton(buttonRaw, depth, counterRef);
        if (button) {
          buttons.push(button);
          counterRef.total += 1;
        }
      }
    }
    if (buttons.length > 0) {
      rows.push({
        id: typeof rowSource.id === "string" && rowSource.id.trim() ? rowSource.id.trim().slice(0, 24) : "",
        buttons,
      });
    }
  }
  return { rows };
}

export function emptyCustomKeyboardOptions(): CustomKeyboardOptions {
  return { resize: true, persistent: true, oneTime: false, inputPlaceholder: "" };
}

export function countCustomKeyboardStats(config: CustomKeyboardConfig): { buttons: number; rows: number } {
  return {
    buttons: config.root.rows.reduce((sum, row) => sum + row.buttons.length, 0),
    rows: config.root.rows.length,
  };
}

/**
 * 把配置渲染为 grammy Keyboard（真实 reply_markup）。
 * 样式经 .style()（primary/danger/success）附加到最后一个按钮；
 * request_contact / request_location / web_app 使用 Keyboard 对应方法。
 */
export function renderCustomKeyboardMarkup(config: CustomKeyboardConfig): KeyboardMarkup {
  const keyboard = new Keyboard();
  config.root.rows.forEach((row, rowIndex) => {
    for (const button of row.buttons) {
      if (button.kind === "request_contact") keyboard.requestContact(button.text);
      else if (button.kind === "request_location") keyboard.requestLocation(button.text);
      else if (button.kind === "web_app" && button.url) keyboard.webApp(button.text, button.url);
      else keyboard.text(button.text);
      if (button.style !== "default") keyboard.style(button.style);
    }
    if (rowIndex < config.root.rows.length - 1) keyboard.row();
  });
  keyboard.resize_keyboard = config.options.resize;
  keyboard.is_persistent = config.options.persistent;
  keyboard.one_time_keyboard = config.options.oneTime;
  if (config.options.inputPlaceholder.trim()) {
    keyboard.input_field_placeholder = config.options.inputPlaceholder.trim().slice(0, 64);
  }
  return keyboard;
}

/** 请求共享手机号键盘（TGAPI 创建API流程：点击「创建API」后获取手机号，Keyboard#requestContact） */
export function requestContactKeyboard(shareText: string, cancelText: string): KeyboardMarkup {
  const keyboard = new Keyboard().requestContact(shareText).row().text(cancelText);
  keyboard.resize_keyboard = true;
  keyboard.one_time_keyboard = true;
  return keyboard;
}

/**
 * TGAPI 申请机器人默认自定义键盘（v2.2.0，图1 布局逐字对齐）：
 * 行1 🗝 创建 API（primary 主色蓝，整行）；行2 🗂 我的 API ｜ 📱 设置平台；
 * 行3 ✅ 语言 ｜ 🆘 帮助；行4 🎫 客服支持（整行）。
 * 全部按钮绑定 TGAPI 固定指令；「创建 API」默认开启首次对话解锁门禁。
 */
export function defaultTgApiCustomKeyboard(): CustomKeyboardConfig {
  const button = (
    id: string,
    text: string,
    style: CustomKeyboardButtonStyle,
    tgapi_func: string,
    extra?: Partial<CustomKeyboardButton["action"]>,
  ): CustomKeyboardButton => ({
    id,
    text,
    kind: "text",
    style,
    action: { type: "tgapi_func", tgapi_func, ...extra },
  });
  return {
    options: { resize: true, persistent: true, oneTime: false, inputPlaceholder: "" },
    root: {
      rows: [
        {
          id: "kbrow-create",
          buttons: [
            button("kbtn-create", "🗝 创建 API", "primary", "create", {
              tgapi_unlock: true,
              tgapi_response: {
                zh: "🗝 正在为你创建 API，请稍候…",
                en: "🗝 Creating your API, please wait…",
              },
            }),
          ],
        },
        {
          id: "kbrow-my-platform",
          buttons: [
            button("kbtn-my", "🗂 我的 API", "default", "my"),
            button("kbtn-platform", "📱 设置平台", "default", "platform"),
          ],
        },
        {
          id: "kbrow-lang-help",
          buttons: [
            button("kbtn-language", "✅ 语言", "default", "language"),
            button("kbtn-help", "🆘 帮助", "default", "help"),
          ],
        },
        {
          id: "kbrow-support",
          buttons: [button("kbtn-support", "🎫 客服支持", "default", "support")],
        },
      ],
    },
  };
}

/** 平台选择键盘（TGAPI 设置平台：每行 2 个共 8 个平台按钮 + 返回） */
export function platformKeyboard(
  labels: Record<string, string>,
  backText: string,
  current?: string,
): KeyboardMarkup {
  const keyboard = new Keyboard();
  TGAPI_PLATFORM_SUBMENU_ROWS.forEach((pair, index) => {
    for (const platform of pair) {
      const mark = current === platform ? "✅ " : "";
      keyboard.text(`${mark}${labels[platform] ?? platform}`);
    }
    if (index < TGAPI_PLATFORM_SUBMENU_ROWS.length - 1) keyboard.row();
  });
  keyboard.row().text(backText);
  keyboard.resize_keyboard = true;
  keyboard.one_time_keyboard = true;
  return keyboard;
}

/**
 * 按按钮文本在键盘树中查找（v2.3 键盘子菜单运行时寻址）：
 * 先根层（当前激活键盘最常见），再递归各子菜单 —— 返回按钮与其所在行集合
 * （back 动作据此发送「上一级键盘」）。同名按钮取首个匹配（真实机器人惯例：
 * 子菜单按钮文案不与父级重复）。
 */
export function findKeyboardButtonByText(
  config: CustomKeyboardConfig,
  text: string,
): { button: CustomKeyboardButton; parentRows: CustomKeyboardRow[] } | null {
  const visit = (
    rows: CustomKeyboardRow[],
  ): { button: CustomKeyboardButton; parentRows: CustomKeyboardRow[] } | null => {
    for (const row of rows) {
      for (const button of row.buttons) {
        if (button.text.trim() === text) return { button, parentRows: rows };
      }
    }
    for (const row of rows) {
      for (const button of row.buttons) {
        if (button.submenu) {
          const found = visit(button.submenu.rows);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(config.root.rows);
}

/**
 * 按「返回」按钮文本查找其所在键盘的上一级键盘行集合（v2.3 back 动作运行时寻址）：
 * - 返回按钮位于根键盘 → 上一级 = 根键盘自身（重发主键盘）；
 * - 返回按钮位于某子菜单键盘 → 上一级 = 包含该子菜单按钮的键盘行集合。
 */
export function findKeyboardParentRowsByText(
  config: CustomKeyboardConfig,
  text: string,
): CustomKeyboardRow[] {
  const visit = (rows: CustomKeyboardRow[], parentRows: CustomKeyboardRow[] | null): CustomKeyboardRow[] | null => {
    for (const row of rows) {
      for (const button of row.buttons) {
        if (button.text.trim() === text) return parentRows ?? rows;
      }
    }
    for (const row of rows) {
      for (const button of row.buttons) {
        if (button.submenu) {
          const found = visit(button.submenu.rows, parentRows ?? rows);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(config.root.rows, null) ?? config.root.rows;
}
