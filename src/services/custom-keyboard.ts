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
   * tgapi_func=TGAPI 固定指令（isTgApi）；reply=回复配置内容；command=执行指令。
   * 省略 = 不响应（仅发送文本）。
   */
  action?: MenuButtonAction;
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

const KINDS: CustomKeyboardButtonKind[] = ["text", "request_contact", "request_location", "web_app"];
const STYLES: CustomKeyboardButtonStyle[] = ["default", "primary", "danger", "success"];

/** 平台子菜单（TGAPI 设置平台）：每行 2 个、共 8 个平台按钮（对齐 APP_PLATFORM 配置） */
export const TGAPI_PLATFORM_SUBMENU_ROWS: string[][] = [
  ["android", "ios"],
  ["wp", "bb"],
  ["desktop", "web"],
  ["ubp", "other"],
];

function parseButton(raw: unknown): CustomKeyboardButton | null {
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
    // 回复键盘按钮只支持 reply / command / tgapi_func / language 行为（内联专属类型一律丢弃）
    if (
      (action.type === "reply" || action.type === "command" || action.type === "tgapi_func" || action.type === "language")
    ) {
      button.action = { type: action.type } as MenuButtonAction;
      if (typeof action.text === "string") button.action.text = action.text;
      if (typeof action.target === "string") button.action.target = action.target;
      if (typeof action.tgapi_func === "string") button.action.tgapi_func = action.tgapi_func;
      if (typeof action.tgapi_value === "string") button.action.tgapi_value = action.tgapi_value;
      if (action.tgapi_unlock === true) button.action.tgapi_unlock = true;
      if (typeof action.content === "object" && action.content !== null) {
        button.action.content = action.content as MenuMessageContent;
      }
      for (const slot of ["tgapi_response", "tgapi_success", "tgapi_fail"] as const) {
        const value = action[slot];
        if (typeof value === "object" && value !== null) {
          button.action[slot] = value as MenuButtonAction[typeof slot];
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
  let total = 0;
  for (const rowRaw of (source.root?.rows ?? []).slice(0, CUSTOM_KEYBOARD_MAX_ROWS)) {
    if (typeof rowRaw !== "object" || rowRaw === null) continue;
    const rowSource = rowRaw as Partial<CustomKeyboardRow>;
    const buttons: CustomKeyboardButton[] = [];
    if (Array.isArray(rowSource.buttons)) {
      for (const buttonRaw of rowSource.buttons.slice(0, CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW)) {
        if (total >= CUSTOM_KEYBOARD_MAX_BUTTONS_TOTAL) break;
        const button = parseButton(buttonRaw);
        if (button) {
          buttons.push(button);
          total += 1;
        }
      }
    }
    if (buttons.length > 0) {
      config.root.rows.push({
        id: typeof rowSource.id === "string" && rowSource.id.trim() ? rowSource.id.trim().slice(0, 24) : "",
        buttons,
      });
    }
  }
  // 空键盘 = 未配置（运行时回落消息内嵌按钮模式）
  return config.root.rows.length > 0 ? config : null;
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
