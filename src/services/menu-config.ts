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
  | "command"
  | "language"
  | "tgapi_func";

/**
 * TGAPI 指令消息槽位定义（v2.1.16）：每个固定指令中可配置的消息（发送消息 /
 * 成功消息 / 失败消息），管理端「指令配置」模块按 slots 渲染，
 * 真实端 handlers/tgapi.ts 按同名槽位读取渲染（{{变量}} 由 renderMenuTemplate 解析）。
 */
export interface TgApiFuncMessageSlot {
  key: "response" | "success" | "fail";
  label: string;
  /** 该槽位的说明（发送时机/留空语义） */
  desc: string;
  /** 可用模板变量提示（空 = 无变量） */
  vars: string;
  /** 默认文案（真实端未配置时使用；管理端作为 placeholder 展示） */
  defaultZh: string;
  defaultEn: string;
}

/**
 * TGAPI 申请机器人内置功能（v2.2.0）：内嵌按钮「交互」下拉框的可选项，
 * 与 TGAPI 机器人真实具备的功能一一对应（运行时由 registerTgApiHandlers 注入执行器）。
 * label 即管理端下拉框展示文案（指令 /xxx : 描述格式）；slots 是该指令
 * 可配置的消息槽位（发送消息/成功消息/失败消息，双语，支持 {{变量}}）。
 *
 * TGAPI 固定指令（v2.2.2 起 9 个，/skip 已移除）：
 * 启动机器人 / 创建API / 我的API / 设置平台 / 语言切换 / 帮助 / 客服支持 /
 * 设置APP名称(title) / 设置APP描述(description)。
 * 其中 /start 是入口指令不设按钮，其余 8 个指令对应默认菜单的 8 个内嵌按钮
 *（v2.2.2：/skip 指令已移除 —— 创建 API 直接手机号 → 登录码，APP 参数用
 * 设置Title/设置Description/设置平台 预配置或管理端默认值）。
 */
export const TGAPI_MENU_FUNCS = [
  {
    func: "start",
    label: "指令 /start : 启动机器人",
    hint: "重新发送一条新的初始消息+内嵌按钮，之前的消息和内嵌按钮过时失效",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击按钮后机器人先发送的提示（留空 = 直接重发初始消息）",
        vars: "",
        defaultZh: "",
        defaultEn: "",
      },
    ],
  },
  {
    func: "create",
    label: "指令 /createapi : 创建API",
    hint: "先检测是否已创建过 → 未解锁时进入验证码验证流程 → 通过后自动进入创建流程（手机号 → 登录码 → api_id/api_hash）",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击按钮后机器人先发送的提示（留空 = 点击后直接执行）",
        vars: "",
        defaultZh: "🗝 正在为你创建 API，请稍候…",
        defaultEn: "🗝 Creating your API, please wait…",
      },
      {
        key: "success",
        label: "成功消息",
        desc: "API 创建成功后发送（留空 = 只发默认完整 APP 配置消息）",
        vars: "{{phone}} {{api_id}} {{api_hash}}",
        defaultZh: "",
        defaultEn: "",
      },
      {
        key: "fail",
        label: "失败消息",
        desc: "创建失败时发送（留空 = 只发默认错误提示）",
        vars: "{{error}}",
        defaultZh: "",
        defaultEn: "",
      },
    ],
  },
  {
    func: "my",
    label: "指令 /myapi : 我的API",
    hint: "查看已创建的 api_id 与 api_hash（号码 / api_id / api_hash 三行格式）",
    slots: [
      {
        key: "success",
        label: "成功消息",
        desc: "已创建时发送（号码/api_id/api_hash 三行格式）",
        vars: "{{phone}} {{api_id}} {{api_hash}}",
        defaultZh: "📱 号码：{{phone}}\n🆔 api_id：{{api_id}}\n🔑 api_hash：{{api_hash}}",
        defaultEn: "📱 Number: {{phone}}\n🆔 api_id: {{api_id}}\n🔑 api_hash: {{api_hash}}",
      },
      {
        key: "fail",
        label: "失败消息",
        desc: "未创建时发送",
        vars: "",
        defaultZh: "💎 你还没有创建 API。\n\n点击 🗝 创建API 开始申请。",
        defaultEn: "💎 You haven't created an API yet.\n\nTap 🗝 Create API to start.",
      },
    ],
  },
  {
    func: "platform",
    label: "指令 /setplatform : 设置平台",
    hint: "点按钮展开平台子菜单（每行2个共8个平台按钮）；选中平台用于创建 APP 时提交（未选择则从 APP_PLATFORM 配置随机选一）",
    slots: [
      {
        key: "success",
        label: "选择成功消息",
        desc: "平台子菜单中点击具体平台后发送",
        vars: "{{platform}}",
        defaultZh: "✅ APP 平台已设置为 {{platform}}，创建 API 时将优先使用。",
        defaultEn: "✅ App platform set to {{platform}}; it will be used when creating your API.",
      },
    ],
  },
  {
    func: "language",
    label: "指令 /language : 语言切换",
    hint: "点击后在 中文/English 之间切换并回复确认；语言偏好按会话记忆",
    slots: [],
  },
  {
    func: "help",
    label: "指令 /help : 帮助",
    hint: "回复使用帮助（各按钮功能说明）",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击后发送的帮助文案（留空 = 内置默认帮助）",
        vars: "{{user_id}} {{username}} {{first_name}}",
        defaultZh: "",
        defaultEn: "",
      },
    ],
  },
  {
    func: "support",
    label: "指令 /support : 客服支持",
    hint: "回复客服支持文案（联系方式等）",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击后发送的客服文案（留空 = 内置默认）",
        vars: "{{user_id}} {{username}} {{first_name}}",
        defaultZh: "",
        defaultEn: "",
      },
    ],
  },
  {
    func: "settitle",
    label: "指令 /settitle : 设置APP名称",
    hint: "在输入框发送 APP 名称（title，1-32 字符），创建 API 时优先使用；发送 /start 返回主键盘",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击后先发送的提示（留空 = 内置名称输入提示）",
        vars: "{{title}}",
        defaultZh: "",
        defaultEn: "",
      },
      {
        key: "success",
        label: "设置成功消息",
        desc: "保存成功后发送",
        vars: "{{title}}",
        defaultZh: "✅ APP 名称已设置为：{{title}}",
        defaultEn: "✅ App title set to: {{title}}",
      },
    ],
  },
  {
    func: "setdescription",
    label: "指令 /setdescription : 设置APP描述",
    hint: "在输入框发送 APP 描述（description，1-200 字符），创建 API 时优先使用；发送 /start 返回主键盘",
    slots: [
      {
        key: "response",
        label: "发送消息",
        desc: "点击后先发送的提示（留空 = 内置描述输入提示）",
        vars: "{{description}}",
        defaultZh: "",
        defaultEn: "",
      },
      {
        key: "success",
        label: "设置成功消息",
        desc: "保存成功后发送",
        vars: "{{description}}",
        defaultZh: "✅ APP 描述已设置为：{{description}}",
        defaultEn: "✅ App description set to: {{description}}",
      },
    ],
  },
] as const;

export type TgApiMenuFunc = (typeof TGAPI_MENU_FUNCS)[number]["func"];

/** TGAPI 平台指令的合法平台值（tgapi_value，与 my.telegram.org APP_PLATFORM 提交值一致） */
export const TGAPI_PLATFORM_VALUES = [
  "android",
  "ios",
  "wp",
  "bb",
  "desktop",
  "web",
  "ubp",
  "other",
] as const;

const TGAPI_PLATFORM_VALUE_SET: Set<string> = new Set(TGAPI_PLATFORM_VALUES);

/** 判断是否合法的 TGAPI 平台值（parseAction 校验用） */
export function isValidTgApiPlatformValue(value: string | undefined | null): boolean {
  return typeof value === "string" && TGAPI_PLATFORM_VALUE_SET.has(value);
}

const TGAPI_MENU_FUNC_SET: Set<string> = new Set(TGAPI_MENU_FUNCS.map((item) => item.func));

/** 判断是否合法的 TGAPI 内置功能名（parseAction 校验与 validateMenuConfig 校验共用） */
export function isValidTgApiMenuFunc(func: string | undefined | null): boolean {
  return typeof func === "string" && TGAPI_MENU_FUNC_SET.has(func);
}

/** 按钮级响应配置（v2.1.16）：点击按钮后机器人先发送的提示消息（中英双语，支持 {{变量}} 占位符） */
export interface MenuTgApiResponse {
  zh: string;
  en: string;
}

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
  /** tgapi_func 类型专用：TGAPI 内置功能名（见 TGAPI_MENU_FUNCS，共 9 个固定指令） */
  tgapi_func?: string;
  /** tgapi_func=platform 专用：按钮绑定的平台值（android/ios/wp/bb/desktop/web/ubp/other） */
  tgapi_value?: string;
  /** tgapi_func 类型专用：首次对话解锁门禁（true=未解锁用户点击先进入验证码验证流程） */
  tgapi_unlock?: boolean;
  /** tgapi_func 类型专用：点击后的响应提示消息（中英双语，先于功能执行发送） */
  tgapi_response?: MenuTgApiResponse;
  /** tgapi_func 类型专用：功能成功消息（中英双语，{{phone}}/{{api_id}}/{{api_hash}} 可用；留空用内置默认） */
  tgapi_success?: MenuTgApiResponse;
  /** tgapi_func 类型专用：功能失败消息（中英双语，{{error}} 可用；留空用内置默认） */
  tgapi_fail?: MenuTgApiResponse;
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

/**
 * TGAPI 平台标签（my.telegram.org APP_PLATFORM 提交值 → 展示文案，图2 清单逐字对齐）
 */
export const TGAPI_PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  wp: "Windows Phone",
  bb: "BlackBerry",
  desktop: "桌面端",
  web: "Web",
  ubp: "Ubiquitous",
  other: "其他",
};

/** 平台子菜单布局：每行 2 个、共 8 个平台按钮（[值, 标签] 配对） */
export const TGAPI_PLATFORM_LABEL_ROWS: [string, string][][] = [
  [
    ["android", TGAPI_PLATFORM_LABELS.android],
    ["ios", TGAPI_PLATFORM_LABELS.ios],
  ],
  [
    ["wp", TGAPI_PLATFORM_LABELS.wp],
    ["bb", TGAPI_PLATFORM_LABELS.bb],
  ],
  [
    ["desktop", TGAPI_PLATFORM_LABELS.desktop],
    ["web", TGAPI_PLATFORM_LABELS.web],
  ],
  [
    ["ubp", TGAPI_PLATFORM_LABELS.ubp],
    ["other", TGAPI_PLATFORM_LABELS.other],
  ],
];

/**
 * TGAPI 申请机器人默认按钮组（v2.2.0）：存量机器人首次打开新弹窗时按钮区按此生成；
 * 固定指令中除 /start（入口指令）外的 8 个指令各对应一个按钮（v2.2.2 移除跳过）。
 * 图1 布局基础上扩展：
 * 行1 🗝 创建 API（整行，默认开启首次对话解锁门禁）；
 * 行2 🗂 我的 API ｜ 📱 设置平台（两列；设置平台展开平台子菜单）；
 * 行3 ✅ 语言 ｜ 🆘 帮助（两列）；
 * 行4 🎫 客服支持（整行）；
 * 行5 ✏️ 设置Title ｜ 📝 设置Description（两列，v2.2.2 移除跳过按钮）。
 * 平台子菜单：每行 2 个共 8 个平台按钮（TGAPI_PLATFORM_LABELS 全量）。
 * 消息正文不在此处（正文沿用其已自定义的欢迎语 texts.start）。
 */
export function defaultTgApiMenuRoot(): MenuNode {
  const row = (buttons: MenuButton[]): MenuRow => ({
    id: `row${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    buttons,
  });
  return {
    rows: [
      row([
        {
          id: "btn-create-api",
          text: "🗝 创建 API",
          action: {
            type: "tgapi_func",
            tgapi_func: "create",
            tgapi_unlock: true,
            tgapi_response: {
              zh: "🗝 正在为你创建 API，请稍候…",
              en: "🗝 Creating your API, please wait…",
            },
          },
        },
      ]),
      row([
        {
          id: "btn-my-api",
          text: "🗂 我的 API",
          action: {
            type: "tgapi_func",
            tgapi_func: "my",
            tgapi_response: {
              zh: "💎 正在查询你的 API 信息…",
              en: "💎 Looking up your API info…",
            },
          },
        },
        {
          id: "btn-platform",
          text: "📱 设置平台",
          action: { type: "submenu" },
          submenu: {
            rows: TGAPI_PLATFORM_LABEL_ROWS.map((pair) =>
              row(
                pair.map(([value, label]) => ({
                  id: `btn-platform-${value}`,
                  text: label,
                  action: {
                    type: "tgapi_func",
                    tgapi_func: "platform",
                    tgapi_value: value,
                  },
                } satisfies MenuButton)),
              ),
            ),
          },
        },
      ]),
      row([
        {
          id: "btn-language",
          text: "✅ 语言",
          action: { type: "language" },
        },
        {
          id: "btn-help",
          text: "🆘 帮助",
          action: { type: "tgapi_func", tgapi_func: "help" },
        },
      ]),
      row([
        {
          id: "btn-support",
          text: "🎫 客服支持",
          action: { type: "tgapi_func", tgapi_func: "support" },
        },
      ]),
      row([
        {
          id: "btn-set-title",
          text: "✏️ 设置Title",
          action: { type: "tgapi_func", tgapi_func: "settitle" },
        },
        {
          id: "btn-set-description",
          text: "📝 设置Description",
          action: { type: "tgapi_func", tgapi_func: "setdescription" },
        },
      ]),
    ],
  };
}

/** TGAPI 设计器保存标记（menu_config JSON 顶层字段）：true = 按钮配置来自新设计器弹窗 */
export const TGAPI_DESIGNER_FLAG = "tgapiDesigner";

/** 判断 menu_config JSON 是否由 TGAPI 新设计器保存过（存量旧配置返回 false） */
export function isTgApiDesignerConfig(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return data[TGAPI_DESIGNER_FLAG] === true;
  } catch {
    return false;
  }
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
  "language",
  "tgapi_func",
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

/** 解析 TGAPI 指令消息槽位（双语，全空 = 未配置返回 undefined） */
function parseTgApiResponse(raw: unknown): MenuTgApiResponse | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Partial<MenuTgApiResponse>;
  const zh = typeof source.zh === "string" ? source.zh : "";
  const en = typeof source.en === "string" ? source.en : "";
  if (!zh.trim() && !en.trim()) return undefined;
  return { zh, en };
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
  // v2.1.16 TGAPI 按钮：功能名仅接受内置功能清单；响应配置中英文都空时不落库
  if (
    source.type === "tgapi_func" &&
    typeof source.tgapi_func === "string" &&
    TGAPI_MENU_FUNC_SET.has(source.tgapi_func)
  ) {
    action.tgapi_func = source.tgapi_func;
    // 平台指令：按钮可绑定具体平台值（子菜单平台按钮）；非法值丢弃
    if (
      source.tgapi_func === "platform" &&
      typeof source.tgapi_value === "string" &&
      TGAPI_PLATFORM_VALUE_SET.has(source.tgapi_value)
    ) {
      action.tgapi_value = source.tgapi_value;
    }
    if (source.tgapi_unlock === true) action.tgapi_unlock = true;
    const response = parseTgApiResponse(source.tgapi_response);
    if (response) action.tgapi_response = response;
    const success = parseTgApiResponse(source.tgapi_success);
    if (success) action.tgapi_success = success;
    const fail = parseTgApiResponse(source.tgapi_fail);
    if (fail) action.tgapi_fail = fail;
  }
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
