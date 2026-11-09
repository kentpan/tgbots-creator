import { Bot } from "grammy";
import type { ChatAdministratorRights } from "grammy/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  resolveEffectiveTransport,
  resolveEffectiveTransportWithFallback,
  resolveEffectivePrivacy,
  isEdgeRuntime,
  type EffectiveTransport,
} from "@/lib/telegram/runtime-mode";
import {
  listEnabledBots,
  getBot,
  listBotCommandsByIds,
  type BotRow,
} from "@/database/operations";
import { installBotMenu, parseBotMenuConfig, createMenuCommandRegistry, scopeCommandRunnerToGroup, type BotMenuConfig, type MenuCommandRegistry, type MenuCommandRunner } from "@/services/bot-menu";
import { CommandGroup } from "@grammyjs/commands";
import { codeQuestion } from "./verification-question";
import { registerAiSupport, type AiSupportConfig } from "./handlers/ai-support";
import { registerBuiltinCommandHandlers } from "./handlers/builtin-commands";
import { registerTgApiHandlers } from "./handlers/tgapi";
import { normalizeTgApiSection, type TgApiBotConfig } from "@/services/tgapi-config";
import { buildSessionMiddleware } from "./session-storage";
import { registerChatTracking } from "./chat-tracking";
import { registerInviteLinkTracking } from "./invite-link-tracking";
import { handleJoinRequest, handleChatMemberUpdate } from "./handlers/chat-member";
import { handleVerificationChoice } from "./handlers/group-verification";
import { handleCodeInput } from "./handlers/code-input";
import { menuVerifyQuestion } from "./handlers/menu-verify";
import type { BotContext } from "./context";
import { config } from "@/config/settings";
import { POLLING_ALLOWED_UPDATES } from "@/lib/telegram/runtime-mode";
import {
  LONG_POLL_TIMEOUT_SECONDS,
  isPollingRestartable,
  runPollingWithAutoRestart,
} from "./polling-restart";

interface BotProfileConfig {
  my_name?: string;
  description?: string;
  short_description?: string;
  commands?: { command: string; description: string }[];
  /** 隐私模式（默认开启）：开启时指令仅标准 / 前缀 + 消息开头匹配；关闭时支持消息中任意位置与定向写法 */
  privacyMode?: boolean;
  /** 隐私模式单项配置（新）：inherit=跟随全局 / on=开启 / off=关闭；优先于旧布尔字段 */
  privacyModeSetting?: "inherit" | "on" | "off";
  /** 传输模式单项配置：inherit=跟随全局 / polling=长轮询 / webhook=Webhook */
  transportMode?: "inherit" | "polling" | "webhook";
  /** 机器人指令菜单：「⌨️ 指令菜单」弹窗勾选的指令库 id 列表（指令注册唯一来源；未勾选 = 不注册任何指令） */
  commandIds?: number[];
  /** 菜单按钮 setChatMenuButton（真实 API 配置） */
  menuButton?: { type: "default" | "commands" | "web_app"; text?: string; url?: string };
  /** 默认管理员权限 setMyDefaultAdministratorRights（真实 API 配置；group=群组，channel=频道） */
  defaultAdminRights?: {
    group?: Record<string, boolean>;
    channel?: Record<string, boolean>;
  };
  /** grammY 插件开关（缺省 = 开启官方推荐组合） */
  plugins?: BotPluginsConfig;
  /** AI 客服配置 */
  aiSupport?: AiSupportConfig;
  /** TGAPI申请 机器人配置（v2.1.6）：启用后实例为纯私聊对话工具机器人（MyTelegramOrgRoBot 复刻） */
  tgapi?: TgApiBotConfig;
}

export interface BotPluginsConfig {
  autoRetry?: boolean;
  throttler?: boolean;
  /** 会话存储单项覆盖：inherit / memory / sqlite / d1 / r2 */
  sessionStorage?: string;
}

export function parseBotPrivacyMode(profile: BotProfileConfig): boolean {
  return profile.privacyMode !== false;
}

interface MenuBotInstance {
  bot: Bot<BotContext>;
  running: boolean;
  /** 生效传输模式：polling=本进程轮询；webhook=Telegram 主动回调（本进程不轮询） */
  mode: EffectiveTransport;
  /**
   * 验证/指令能力是否已注册（registerBotCapabilities）。
   * createMenuBot 只装配菜单插件与聊天登记；验证 handler、指令、验证码输入通道
   * 都在 registerBotCapabilities 里。polling 路径历来会注册，但 webhook 分支与
   * acquireMenuBot 兑底实例此前漏注册 → webhook 收到的加群申请/指令全部静默落空
   * （2026-11-03 webhook 全链路实测抓到）。所有入 registry 的实例必须为 true。
   */
  capabilitiesReady: boolean;
  /**
   * 传输层部署结果（真实结果，非预期值）：webhook 模式 = setWebhook 注册结果；
   * polling 模式 = 轮询启动确认（onStart 成功置 ok）。
   * 此前该结果只进 console 日志，管理后台完全看不到部署成败 ——
   * TGAPI 申请机器人保存后部署失败（如 Webhook Base URL 未配置）用户毫无感知。
   */
  transportState: { ok: boolean; error?: string; url?: string } | null;
  /** polling 模式：getMe 成功、轮询确认运行的 Telegram 侧确认信号 */
  started: boolean;
  /** polling 模式最近一次轮询致命错误消息（onError 记录，绝不静默） */
  startError: string | null;
  /**
   * 菜单「执行指令」按钮注册表（v2.1.10）：createMenuBot 创建并注入菜单插件，
   * registerBotCapabilities 在能力注册阶段按「⌨️ 指令菜单」弹窗勾选填充
   * （bots.config.commandIds；未勾选 = 空，运行时不自行补注册）。
   */
  menuCommands: MenuCommandRegistry;
}

type MenuBotRegistry = Map<number, MenuBotInstance>;

const globalForBots = globalThis as unknown as {
  tguardMenuBots?: MenuBotRegistry;
  tguardMenuBotTokens?: Set<string>;
};

function registry(): MenuBotRegistry {
  if (!globalForBots.tguardMenuBots) {
    globalForBots.tguardMenuBots = new Map();
  }
  return globalForBots.tguardMenuBots;
}

function runningTokens(): Set<string> {
  if (!globalForBots.tguardMenuBotTokens) {
    globalForBots.tguardMenuBotTokens = new Set();
  }
  return globalForBots.tguardMenuBotTokens;
}

export interface MenuBotDeployState {
  /** 本进程 registry 中是否存在该机器人实例 */
  present: boolean;
  /** 轮询循环是否在运行（webhook 模式恒 false —— 本进程不轮询） */
  running: boolean;
  mode: EffectiveTransport | null;
  /** polling 模式：Telegram 侧确认启动成功（getMe 已过） */
  started: boolean;
  /** 传输层部署结果：true/false = 已确认成败；null = 尚未返回 */
  transportOk: boolean | null;
  transportError: string | null;
  /** webhook 注册成功的回调地址 / polling 启动成功的 @用户名 */
  transportUrl: string | null;
  /** polling 最近一次轮询致命错误消息 */
  startError: string | null;
}

/**
 * 读取机器人的真实部署状态（本进程 registry 权威值）。
 * 注意：Edge 环境 isolate 不共享内存，跨请求渲染的页面请用 Telegram 侧
 * getWebhookInfo（webhook 模式）或本接口（polling 模式，同进程内权威）。
 */
export function getMenuBotDeployState(botId: bigint): MenuBotDeployState {
  const instance = registry().get(Number(botId));
  if (!instance) {
    return {
      present: false,
      running: false,
      mode: null,
      started: false,
      transportOk: null,
      transportError: null,
      transportUrl: null,
      startError: null,
    };
  }
  return {
    present: true,
    running: instance.running,
    mode: instance.mode,
    started: instance.started,
    transportOk: instance.transportState ? instance.transportState.ok : null,
    transportError: instance.transportState?.error ?? null,
    transportUrl: instance.transportState?.url ?? null,
    startError: instance.startError,
  };
}

/**
 * 有界等待轮询部署确认：polling 模式下 startMenuBot 返回时 getMe 尚未完成，
 * 轮询等待 started=true（成功）或 running=false（失败退出）。
 * webhook 模式结果在 startMenuBot 返回时已定（setWebhook 同步 await），无需等待。
 * 实例消失（停用/被移除）立即返回，由调用方按未部署报告。
 */
export async function waitForMenuBotDeployConfirmation(botId: bigint, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const instance = registry().get(Number(botId));
    if (!instance) return;
    if (instance.mode !== "polling") return;
    if (instance.started || !instance.running) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export function parseBotProfile(raw: string): BotProfileConfig {
  try {
    const parsed = JSON.parse(raw) as BotProfileConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Bot API ChatAdministratorRights 全字段（setMyDefaultAdministratorRights 要求完整对象） */
const ADMIN_RIGHT_KEYS = [
  "is_anonymous",
  "can_manage_chat",
  "can_change_info",
  "can_delete_messages",
  "can_invite_users",
  "can_restrict_members",
  "can_pin_messages",
  "can_manage_video_chats",
  "can_promote_members",
  "can_post_messages",
  "can_edit_messages",
  "can_manage_topics",
  "can_post_stories",
  "can_edit_stories",
  "can_delete_stories",
] as const;

function buildAdminRights(flags: Record<string, boolean>): ChatAdministratorRights {
  const rights: Record<string, boolean> = {};
  for (const key of ADMIN_RIGHT_KEYS) {
    rights[key] = flags[key] === true;
  }
  return rights as unknown as ChatAdministratorRights;
}

async function applyMenuButton(bot: Bot<BotContext>, menuButton: NonNullable<BotProfileConfig["menuButton"]>): Promise<void> {
  const type = menuButton.type;
  if (type === "web_app") {
    const url = menuButton.url?.trim();
    if (!url) return;
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: menuButton.text?.trim() || "打开应用", web_app: { url } },
    });
    return;
  }
  if (type === "commands") {
    await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
    return;
  }
  await bot.api.setChatMenuButton({ menu_button: { type: "default" } });
}

export async function applyBotProfile(bot: Bot<BotContext>, profile: BotProfileConfig): Promise<void> {
  if (profile.my_name?.trim()) {
    await bot.api
      .setMyName(profile.my_name.trim())
      .catch((error: unknown) => console.error("[bot] setMyName 失败:", error));
  }
  if (profile.description?.trim()) {
    await bot.api
      .setMyDescription(profile.description.trim())
      .catch((error: unknown) => console.error("[bot] setMyDescription 失败:", error));
  }
  if (profile.short_description?.trim()) {
    await bot.api
      .setMyShortDescription(profile.short_description.trim())
      .catch((error: unknown) => console.error("[bot] setMyShortDescription 失败:", error));
  }
  if (Array.isArray(profile.commands) && profile.commands.length > 0) {
    const commands = profile.commands
      .filter((item) => item.command?.trim() && item.description?.trim())
      .map((item) => ({ command: item.command.trim(), description: item.description.trim() }));
    if (commands.length > 0) {
      await bot.api
        .setMyCommands(commands)
        .catch((error: unknown) => console.error("[bot] setMyCommands 失败:", error));
    }
  }
  // v1.1.0：菜单按钮 setChatMenuButton（default/commands/web_app Mini App）
  if (profile.menuButton?.type) {
    await applyMenuButton(bot, profile.menuButton).catch((error) => {
      console.warn("setChatMenuButton failed:", error);
    });
  }
  // v1.1.0：默认管理员权限 setMyDefaultAdministratorRights（群组/频道）
  const rights = profile.defaultAdminRights;
  if (rights?.group) {
    await bot.api
      .setMyDefaultAdministratorRights({ rights: buildAdminRights(rights.group), for_channels: false })
      .catch((error) => console.warn("setMyDefaultAdministratorRights(group) failed:", error));
  }
  if (rights?.channel) {
    await bot.api
      .setMyDefaultAdministratorRights({ rights: buildAdminRights(rights.channel), for_channels: true })
      .catch((error) => console.warn("setMyDefaultAdministratorRights(channel) failed:", error));
  }
}

async function createMenuBot(row: BotRow, menuConfig: BotMenuConfig, mode: EffectiveTransport): Promise<MenuBotInstance> {
  const bot: Bot<BotContext> = new Bot(row.token, telegramBotClientOptions());
  // grammY 官方插件 + 会话外部存储（单项配置覆盖全局）
  const profile = parseBotProfile(row.config);
  const plugins = profile.plugins ?? {};
  if (plugins.autoRetry !== false) {
    bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));
  }
  if (plugins.throttler !== false) {
    bot.api.config.use(apiThrottler());
  }
  const { middleware: sessionMiddleware } = await buildSessionMiddleware(plugins.sessionStorage);
  bot.use(sessionMiddleware);
  // 真实群组自动登记（v1.1.1）：被拉进群/收到群事件即登记 chat_id / 群名，
  // 管理后台「同步真实群组」与机器人测试页才能看到机器人真实所在的群组
  registerChatTracking(bot, row.token);
  // v2.1.2 邀请链接台账：任何路径 createChatInviteLink 成功后统一落库（群组管理可查看/撤销）
  registerInviteLinkTracking(bot, row.token);
  // 官方 @grammyjs/menu 菜单插件（v1.1.1）：回调路由/子菜单导航/过期恢复全由插件处理
  // v2.1.10：同实例创建「执行指令」按钮注册表（能力注册阶段按指令菜单弹窗勾选填充）
  const menuCommands = createMenuCommandRegistry();
  const instanceMenu = installBotMenu(bot, menuConfig, menuCommands);
  // v2.1.12 菜单「外部验证 API」按钮：验证码回复通道（force-reply StatelessQuestion）。
  // 必须装在会话中间件之后（handler 读写 ctx.session.menuVerify）；与群组验证
  // codeQuestion（tgcode）并列独立问题，按消息内嵌 id 精确路由互不串扰。
  bot.use(menuVerifyQuestion.middleware());
  // 实例菜单注入（ctx.botMenu）：官方插件约束 Menu 实例只能发给安装它的 bot，
  // cmdStart/cmdMenu 优先用本实例菜单，避免误发主 bot 的全局 mainMenu 而抛
  // "Cannot send menu"（轮询/Webhook 下菜单 bot 私聊 /start 均命中）
  bot.use(async (ctx, next) => {
    ctx.botMenu = instanceMenu;
    await next();
  });
  bot.catch((error) => {
    console.error(`Menu bot #${row.id} update error:`, error.error);
  });
  return {
    bot,
    running: false,
    mode,
    capabilitiesReady: false,
    transportState: null,
    started: false,
    startError: null,
    menuCommands,
  };
}

/**
 * 为机器人实例注册验证与指令能力（真实生效）：
 * - stateless-question 中间件：加群验证码的隐私模式兼容输入通道
 * - 内置/自定义指令：仅注册「⌨️ 指令菜单」弹窗勾选的指令库条目（bots.config.commandIds；
 *   未勾选 = 不注册任何指令，运行时绝不按指令库启用状态自行补注册）
 * - 自定义指令：按隐私模式开关选择严格/宽松匹配策略（@grammyjs/commands）
 *
 * v1.1.1 性能修复：本函数只做中间件注册 + 库读取（毫秒级），不再同步等待
 * setMyCommands 网络调用；返回后台同步任务，由 startMenuBot 并行调度。
 */
async function registerBotCapabilities(
  bot: Bot<BotContext>,
  profile: BotProfileConfig,
  effectivePrivacy: boolean,
  botId?: bigint,
  menuCommands?: MenuCommandRegistry,
  menuConfig?: BotMenuConfig,
): Promise<() => Promise<void>> {
  const privacyMode = effectivePrivacy;

  // v2.1.6 TGAPI申请 机器人：启用 tgapi 配置后，实例切换为纯私聊对话工具机器人
  //（MyTelegramOrgRoBot 复刻：解锁门禁 + 手机号 → Telegram 登录码 → my.telegram.org
  // 抓取/创建 APP）。不注册群验证/指令库/AI 客服能力（私聊文本全部被对话流消费，
  // 群验证 handler 对该类型机器人无意义且可能干扰）。
  // v2.1.7：传入前先 normalize（parseBotProfile 是裸 JSON.parse，这里补齐缺省字段
  // 默认值，保证运行实例与管理后台读到同一份配置语义）。
  // v2.1.10：传入菜单配置与指令注册表 —— 按钮驱动新流程（欢迎+授权认证按钮→
  // 输码→成功+菜单键盘）+ 菜单「执行指令」按钮与自定义指令同源。
  if (profile.tgapi?.enabled) {
    const resolvedBotId = botId ?? BigInt(0);
    return await registerTgApiHandlers(
      bot,
      normalizeTgApiSection(profile.tgapi),
      resolvedBotId,
      {
        menuConfig: menuConfig ?? parseBotMenuConfig(undefined),
        registry: menuCommands ?? createMenuCommandRegistry(),
        // 「⌨️ 指令菜单」弹窗勾选（bots.config.commandIds）：TGAPI 实例据此注册指令，
        // 弹窗保存后经 restartMenuBot 热更新生效；运行时绝不按指令库自行补注册
        commandIds: Array.isArray(profile.commandIds) ? profile.commandIds : [],
      },
    );
  }

  // 加群验证入口：收到真实加群申请 → 群内验证（默认）/私聊验证创建验证会话
  //（v1.1.1 修复：multi-runtime 此前完全缺失该 handler，机器人管理创建的验证机器人无法验证）
  bot.on("chat_join_request", handleJoinRequest);

  // 直连入群防线（v1.1.3）：普通邀请链接/被拉入群直接进来的成员 → 补验证，超时/失败踢出
  bot.on("chat_member", handleChatMemberUpdate);

  // 群内验证 4 选 1 点选回调（v2.0.5）：非本模块 callback 原样放行后续中间件（菜单等）
  bot.on("callback_query:data", handleVerificationChoice);

  // 加群验证：无状态问题（回复验证问题消息，隐私模式兼容）
  bot.use(codeQuestion.middleware());

  // 验证码输入宽松兑底（与主 bot index.ts 同序：codeQuestion 之后、指令之前）。
  // 严格隐私模式下仅处理「回复机器人消息」的输码；宽松模式下任意文本兜底。
  // 此前 multi-runtime 未注册该入口，菜单 bot 在宽松隐私模式/手动回复场景丢失验证码通道。
  bot.on("message:text", handleCodeInput);

  // 指令菜单：「⌨️ 指令菜单」弹窗勾选的指令库条目（bots.config.commandIds）是唯一注册来源
  // —— 未勾选/清空 = 该机器人不注册任何指令（运行时绝不按指令库启用状态自行补注册）；
  // 弹窗保存后经 restartMenuBot 热更新，注册与 Telegram 指令菜单同步始终同源。
  const selectedIds = Array.isArray(profile.commandIds)
    ? profile.commandIds.map((id) => BigInt(id))
    : [];
  // 指令归属过滤（v2.1.13）：机器人私有指令（bot_commands.bot_id）仅本机器人可注册；
  // 群组私有指令注册仍是机器人级，群组限制由 runner 校验（scopeCommandRunnerToGroup）
  const library =
    selectedIds.length > 0
      ? await listBotCommandsByIds(selectedIds, botId !== undefined ? { botId } : undefined)
      : [];
  // 内置指令：注册真实处理器（含 adminOnly/私聊限定包装；库中未实现的条目回退为介绍回复）
  // v2.1.10：同步填充菜单「执行指令」按钮注册表 —— 内置指令按钮点击与手输 /指令 同源
  registerBuiltinCommandHandlers(
    bot,
    library
      .filter((item) => item.type === "builtin")
      .map((item) => ({ name: item.name, intro: item.intro, description: item.description })),
    menuCommands,
  );

  const customItems = library.filter((item) => item.type === "custom");
  if (customItems.length > 0) {
    const group = new CommandGroup({
      matchOnlyAtStart: privacyMode,
      targetedCommands: privacyMode ? "ignored" : "optional",
    });
    for (const item of customItems) {
      const commandName = item.name;
      const intro = item.intro || item.description;
      // v2.1.13 群组私有指令：非绑定群组内不执行（含菜单按钮点击同一运行器）
      const runner: MenuCommandRunner = scopeCommandRunnerToGroup(
        item.groupId,
        commandName,
        async (ctx) => {
          await ctx.reply(`⌨️ /${commandName}\n\n${intro}`);
        },
      );
      // v2.1.10：同一运行器同步填充菜单「执行指令」按钮注册表 ——
      // 按钮点击与手输 /指令 完全同源真实执行
      menuCommands?.runners.set(commandName, runner);
      group.command(commandName, item.description, runner);
    }
    bot.use(group);
  }

  const syncCommandList = library.map((item) => ({
    command: item.name,
    description: item.description.slice(0, 256),
  }));
  // 返回后台同步任务：setMyCommands 写入 Telegram（网络调用，不阻塞轮询启动）
  return async () => {
    if (syncCommandList.length === 0) return;
    await bot.api.setMyCommands(syncCommandList).catch((error) => {
      console.warn("setMyCommands failed:", error);
    });
  };
}

/**
 * 确保实例具备验证/指令能力（幂等）：capabilitiesReady=false 时才注册。
 * polling、webhook、acquireMenuBot 兑底三条路径都必须经过本函数，
 * 否则 webhook/兑底实例是裸实例，加群申请/指令/输码全部静默落空
 * （2026-11-03 webhook 全链路实测抓到的生产级缺陷）。
 */
async function ensureMenuBotCapabilities(
  instance: MenuBotInstance,
  row: BotRow,
  profile: BotProfileConfig,
  effectivePrivacy: boolean,
): Promise<() => Promise<void>> {
  if (instance.capabilitiesReady) return async () => undefined;
  // v2.1.10：菜单配置 + 「执行指令」按钮注册表随能力注册一并传入
  //（TGAPI 机器人据此安装按钮驱动新流程；普通机器人据此填充自定义指令运行器）
  const menuConfig = parseBotMenuConfig(row.menuConfig);
  const syncCommands = await registerBotCapabilities(
    instance.bot,
    profile,
    effectivePrivacy,
    row.id,
    instance.menuCommands,
    menuConfig,
  );
  // TGAPI申请 机器人是纯私聊对话工具机器人：AI 客服等附加能力不叠加
  if (profile.aiSupport?.enabled && !profile.tgapi?.enabled) {
    registerAiSupport(instance.bot, profile.aiSupport, row.id);
  }
  instance.capabilitiesReady = true;
  return syncCommands;
}

/** 启动选项（v2.1.0 按需化） */
interface StartMenuBotOptions {
  /**
   * 是否推送 Telegram 侧档案/指令（setMyName/setMyDescription/setMyShortDescription/
   * setMyCommands/setChatMenuButton/setMyDefaultAdministratorRights）。
   * 仅管理后台显式操作（保存/新建/启停机器人 → restartMenuBot）默认触发；
   * 进程启动 / 运行时恢复 / 全局传输变更（startMenuBots 路径）一律静默启动 ——
   * 档案本就持久化在 Telegram 侧，启动重放纯属多余网络调用（且在代理抖动时
   * 会在 dev 首次请求/首页加载时刷网络报错）。
   */
  syncProfile?: boolean;
}

async function startMenuBot(row: BotRow, options: StartMenuBotOptions = {}): Promise<void> {
  const syncProfile = options.syncProfile ?? true;
  const instances = registry();
  if (row.token === config.bot.token) {
    console.warn(`Menu bot #${row.id} uses the main bot token; skip separate polling instance`);
    return;
  }
  const existing = instances.get(Number(row.id));
  if (existing?.running && existing.mode === "polling") return;

  // 解析生效模式与隐私（v2.0.2：单项配置 > 全局配置 > auto=Webhook；
  // Node 未配置 Webhook Base URL 时回退轮询）
  const { getTelegramRuntimeSettings, applyBotTransport } = await import("@/services/bot-transport");
  const global = await getTelegramRuntimeSettings();
  const profile = parseBotProfile(row.config);
  const mode = resolveEffectiveTransportWithFallback(
    profile.transportMode ?? "inherit",
    global.transportMode,
    isEdgeRuntime(),
    Boolean(global.webhookBaseUrl),
  );
  const effectivePrivacy = resolveEffectivePrivacy(
    profile.privacyModeSetting ?? "inherit",
    profile.privacyMode,
    global.privacyEnabled,
  );

  // Webhook 模式：本进程不轮询，注册 Webhook 后即返回。
  // 实例必须具备完整验证/指令能力（webhook 路由复用本实例处理全部更新）——
  // 此前本分支只建裸实例不注册能力，webhook 收到的加群申请/指令全部静默落空。
  if (mode === "webhook") {
    let instance: MenuBotInstance;
    if (existing) {
      if (existing.running) {
        // 由轮询切换而来：先停掉长轮询，避免与 Webhook 双消费
        try {
          await existing.bot.stop();
        } catch {
          /* never-started instance */
        }
        runningTokens().delete(row.token);
      }
      instance = { ...existing, mode: "webhook", running: false, transportState: null, started: false, startError: null };
    } else {
      instance = await createMenuBot(row, parseBotMenuConfig(row.menuConfig), "webhook");
    }
    // 能力幂等补齐：轮询切换来的实例已具备则跳过；新建/历史裸实例在此注册
    const syncCommandsWebhook = await ensureMenuBotCapabilities(instance, row, profile, effectivePrivacy);
    instances.set(Number(row.id), instance);
    const applied = await applyBotTransport(
      { token: row.token, botId: String(row.id) },
      "webhook",
      global.webhookBaseUrl,
    );
    // 部署结果必须落到实例上（此前只进 console，管理后台完全看不到成败）
    instance.transportState = { ok: applied.ok, error: applied.error, url: applied.url };
    console.log(
      `Menu bot #${row.id} transport=webhook ${applied.ok ? `registered: ${applied.url}` : `register failed: ${applied.error ?? "?"}`}`,
    );
    // 指令菜单同步后台执行（与轮询路径同款：不阻塞返回；v2.1.0 按需化 —— 仅显式操作触发）
    if (syncProfile) void syncCommandsWebhook();
    return;
  }

  // 轮询模式：确保没有残留 Webhook 抢走更新（幂等自愈）
  if (existing?.running) return;

  // 同 Token 去重：多个机器人条目可共用同一 Token（如「交付机器人」与「加群验证机器人」），
  // Telegram 仅允许一个 getUpdates 轮询实例，后创建的条目跳过轮询（仅作为配置实体存在）。
  if (runningTokens().has(row.token)) {
    console.warn(
      `Menu bot #${row.id} token already polled by another bot entry; skip duplicate polling instance`,
    );
    return;
  }

  // 【v2.0.10 远程消费者守卫】轮询启动前探测该 Token 是否已被另一环境（典型：线上
  // Cloudflare Pages 的 Webhook 消费者）接管 —— getUpdates 与 Webhook 在 Telegram
  // 侧严格互斥：此前本地轮询启动时无条件 deleteWebhook，会直接掐断线上事件推送
  // （新群组的 my_chat_member 丢失、线上库永远登记不了），且全部更新被本地轮询
  // 吃进本地库（2026-11-07「线上获取不到新创建的群组、沙盒却能看到」事故根因）。
  //
  // 默认一律让位（含显式 polling 配置 —— 历史遗留的显式配置同样会悄悄掐断线上，
  // 沙盒实测：全局 transport_mode=polling 的遗留配置让初版「显式放行」守卫失效）。
  // 确需本环境接管（本地调试机器人）时设置环境变量 TG_FORCE_LOCAL_POLLING=1，
  // 或先在远程环境停用其 Webhook。
  const explicitPolling =
    resolveEffectiveTransport(profile.transportMode ?? "inherit", global.transportMode) === "polling";
  {
    const { probeRemoteWebhook } = await import("@/services/bot-transport");
    const remote = await probeRemoteWebhook(row.token);
    // v2.1.10 类型收窄修复：probeRemoteWebhook 恒返回对象（none/active/unknown），
    // 旧 truthy 判断会把 status="none"（无远程消费者）误判为存在远程消费者，
    // 导致轮询机器人永远拒绝启动（v2.1.9 遗留回归）。按 status 精确分支：
    if (remote.status === "active") {
      const forced = process.env.TG_FORCE_LOCAL_POLLING === "1";
      const intent = explicitPolling ? "显式配置了本地长轮询" : "隐式回退本地轮询";
      if (!forced) {
        console.warn(
          `[multi-runtime] Menu bot #${row.id} ${intent}，检测到远程 Webhook 消费者（${remote.url}，待处理更新 ${remote.pendingUpdateCount} 条），` +
            "本地长轮询已停用：getUpdates 与 Webhook 互斥，删除远程 Webhook 会掐断另一环境（如线上部署）的事件推送。" +
            "如需本环境接管，请设置 TG_FORCE_LOCAL_POLLING=1 或先在远程环境停用其 Webhook。",
        );
        return;
      }
      console.warn(
        `[multi-runtime] Menu bot #${row.id} ${intent}，检测到远程 Webhook 消费者（${remote.url}），` +
          "但 TG_FORCE_LOCAL_POLLING=1 —— 按强制接管执行，远程 Webhook 将被删除（远程环境停止收到该机器人事件）。",
      );
    } else if (remote.status === "unknown") {
      // v2.1.9 语义：探测连续失败（无法判定）时严禁删除/接管任何 Webhook —— 宁可让位
      console.warn(
        `[multi-runtime] Menu bot #${row.id} 远程 Webhook 探测连续失败（无法判定是否存在线上消费者），` +
          "本地长轮询已停用：按让位处理避免掐断线上事件推送；确需本环境接管，请设置 TG_FORCE_LOCAL_POLLING=1。",
      );
      return;
    } else {
      console.log(
        `[multi-runtime] Menu bot #${row.id} 未探测到远程 Webhook 消费者（无 webhook），按本地轮询启动` +
          `${explicitPolling ? "（显式配置）" : "（隐式回退）"}。`,
      );
    }
  }

  if (existing) {
    try {
      await existing.bot.stop();
    } catch {
      /* ignore stop errors for a bot that never started */
    }
    instances.delete(Number(row.id));
  }

  const menuConfig = parseBotMenuConfig(row.menuConfig);
  const instance = await createMenuBot(row, menuConfig, "polling");
  instances.set(Number(row.id), instance);

  // v1.1.1 性能修复：只等中间件注册 + 指令库读取（毫秒级，不碰网络），
  // 轮询立即启动；官方资料/指令菜单/deleteWebhook 全部并行后台执行，
  // 管理后台保存机器人不再被逐个串行的 Telegram API 调用拖到 10s+。
  // （能力注册含 AI 客服，统一走 ensureMenuBotCapabilities 幂等入口）
  let syncCommands: () => Promise<void> = async () => undefined;
  try {
    syncCommands = await ensureMenuBotCapabilities(instance, row, profile, effectivePrivacy);
  } catch (error) {
    console.warn(`Menu bot #${row.id} capabilities register failed:`, error);
  }

  // grammY 官方「long polling 错误自动重启」生产模式（详见 ./polling-restart.ts）：
  // bot.catch 只兜 update 处理错误；polling 循环自身的致命错误（getMe 初始化失败 /
  // getUpdates 401/409 rethrow 等）从 bot.start() 的 Promise 抛出，官方文档要求调用方
  // 捕获，否则机器人永久停止且无人恢复。此处自动重启并完整记录每次错误（绝不吞错），
  // 仅 401（token 永久无效）与实例已被替换时不重启。
  void runPollingWithAutoRestart(
    instance.bot,
    {
      // 显式声明更新类型（v1.1.3）：确保 chat_member（直连入群防线）与
      // callback_query（菜单按钮）必定送达，不受同步操作遗留 allowed_updates 影响
      allowed_updates: [...POLLING_ALLOWED_UPDATES],
      // 短轮询窗口（0 = 立即返回不持连接）：中转/受限网络无法承载持连接长轮询，
      // 实测 timeout>0 的 getUpdates 在代理侧被随机抬断，bot 显示已启动却收不到任何更新
      timeout: LONG_POLL_TIMEOUT_SECONDS,
      onStart: (me) => {
        // Telegram 侧确认启动成功（getMe 已过）：部署状态以此为凭，不预先假报成功
        instance.started = true;
        instance.transportState = { ok: true, url: `@${me.username ?? row.id}` };
        console.log(`Menu bot #${row.id} started: @${me.username}`);
      },
    },
    {
      label: `Menu bot #${row.id}`,
      // 每次轮询致命错误（401/409/网络）都记录到实例（部署状态展示与日志双出口，绝不静默）
      onError: (error) => {
        instance.startError = error instanceof Error ? error.message : String(error);
      },
      shouldContinue: (error) =>
        // 实例已被替换/移除（stopMenuBot / restartMenuBot / 同 token 去重）→ 交由新实例接管
        instances.get(Number(row.id)) === instance &&
        // 401 = token 永久无效（grammY 官方对 unauthorized 直接 rethrow 不重试）
        isPollingRestartable(error),
      onExit: () => {
        if (instances.get(Number(row.id)) === instance) {
          instance.running = false;
          runningTokens().delete(row.token);
        }
      },
    },
  );
  instance.running = true;
  runningTokens().add(row.token);

  // Telegram 侧配置同步（互相独立，并行后台执行，单调用有传输层超时兜底）。
  // v2.1.0 按需化：档案/指令推送仅在管理后台显式操作时执行（syncProfile）；
  // 启动路径只做传输应用（deleteWebhook 确保 getUpdates 不与残留 Webhook 互斥）
  void Promise.allSettled([
    applyBotTransport(
      { token: row.token, botId: String(row.id) },
      "polling",
      global.webhookBaseUrl,
    ),
    ...(syncProfile ? [applyBotProfile(instance.bot, profile), syncCommands()] : []),
  ]);
}

export async function startMenuBots(): Promise<void> {
  // v2.1.0 按需化：本函数的三处调用方（instrumentation 进程启动 /
  // telegram-sync 运行时恢复 / bot-transport 全局传输变更）都不是档案操作 ——
  // 静默启动，不推送档案/指令（dev 模式下首次请求触发 instrumentation，
  // 此前会在打开首页时对每个 bot 重放 setMyName/setMyCommands/… 并刷网络报错）。
  // 档案/指令推送的按需入口：管理后台保存机器人（restartMenuBot）/ 应用档案 /
  // 同步指令（syncBotCommandsToTelegram）。
  const rows = await listEnabledBots();
  for (const row of rows) {
    try {
      await startMenuBot(row, { syncProfile: false });
    } catch (error) {
      console.error(`Failed to start menu bot #${row.id}:`, error);
    }
  }
}

export async function stopMenuBot(botId: bigint): Promise<void> {
  const instance = registry().get(Number(botId));
  if (!instance) return;
  instance.running = false;
  registry().delete(Number(botId));
  try {
    const rows = await listEnabledBots();
    for (const row of rows) {
      if (Number(row.id) === Number(botId)) runningTokens().delete(row.token);
    }
  } catch (error) {
    console.error(`[multi-runtime] 停止机器人 #${String(botId)} 时读取启用列表失败:`, error);
  }
  // Webhook 模式实例：停止时同步注销 Webhook，避免 Telegram 继续推送到已停用机器人
  if (instance.mode === "webhook") {
    try {
      await instance.bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (error) {
      console.warn(`Menu bot #${String(botId)} deleteWebhook error:`, error);
    }
    return;
  }
  try {
    await instance.bot.stop();
  } catch (error) {
    console.warn(`Menu bot #${String(botId)} stop error:`, error);
  }
}

export async function restartMenuBot(botId: bigint): Promise<void> {
  await stopMenuBot(botId);
  const row = await getBot(botId);
  if (!row || !row.enabled) return;
  // 管理后台显式重启 = 按需推送档案/指令（syncProfile 默认 true）
  await startMenuBot(row);
}

export async function stopAllMenuBots(): Promise<void> {
  const instances = Array.from(registry().keys());
  for (const botId of instances) {
    await stopMenuBot(BigInt(botId)).catch((error: unknown) => {
      console.error(`[multi-runtime] 全局停止时停止机器人 #${botId} 失败:`, error);
    });
  }
}

export interface MenuBotHandle {
  bot: Bot<BotContext>;
}

export async function acquireMenuBot(botId: bigint): Promise<MenuBotHandle | null> {
  const row = await getBot(botId);
  if (!row) return null;
  const running = registry().get(Number(botId));
  if (running) {
    return { bot: running.bot };
  }
  const menuConfig = parseBotMenuConfig(row.menuConfig);
  const instance = await createMenuBot(row, menuConfig, "polling");
  // 兑底实例必须具备完整能力（验证/指令/输码通道），否则 webhook 更新静默落空。
  // 隐私解析与 startMenuBot 同款：单项配置 > 全局配置 > 默认开启。
  const profile = parseBotProfile(row.config);
  const { getTelegramRuntimeSettings } = await import("@/services/bot-transport");
  const globalSettings = await getTelegramRuntimeSettings();
  const effectivePrivacy = resolveEffectivePrivacy(
    profile.privacyModeSetting ?? "inherit",
    profile.privacyMode,
    globalSettings.privacyEnabled,
  );
  await ensureMenuBotCapabilities(instance, row, profile, effectivePrivacy);
  registry().set(Number(botId), instance);
  return { bot: instance.bot };
}

/**
 * 立即同步机器人指令菜单（不重启轮询实例）：
 * 读取 bots.config.commandIds 选中的指令库条目，调用 setMyCommands 写入 Telegram。
 */
export async function syncBotCommandsToTelegram(botId: bigint): Promise<{
  ok: boolean;
  count: number;
  error?: string;
}> {
  const row = await getBot(botId);
  if (!row) {
    return { ok: false, count: 0, error: "机器人不存在" };
  }
  const profile = parseBotProfile(row.config);
  // 唯一来源：「⌨️ 指令菜单」弹窗勾选（bots.config.commandIds）；未勾选 = 清空 Telegram 指令菜单
  // 指令归属过滤（v2.1.13）：机器人私有指令不出现在其他机器人的 Telegram 指令菜单
  const selectedIds = Array.isArray(profile.commandIds)
    ? profile.commandIds.map((id) => BigInt(id))
    : [];
  const library =
    selectedIds.length > 0 ? await listBotCommandsByIds(selectedIds, { botId }) : [];
  const menuCommands = library.map((item) => ({
    command: item.name,
    description: item.description.slice(0, 256),
  }));
  try {
    const running = registry().get(Number(botId));
    const api = running?.bot.api ?? new Bot(row.token, telegramBotClientOptions()).api;
    if (menuCommands.length > 0) {
      await api.setMyCommands(menuCommands);
    } else {
      await api.setMyCommands([]);
    }
    return { ok: true, count: menuCommands.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, count: 0, error: message };
  }
}
