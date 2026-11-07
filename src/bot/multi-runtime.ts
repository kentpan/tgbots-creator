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
  listBotCommands,
  type BotRow,
} from "@/database/operations";
import { installBotMenu, parseBotMenuConfig, type BotMenuConfig } from "@/services/bot-menu";
import { CommandGroup } from "@grammyjs/commands";
import { codeQuestion } from "./verification-question";
import { registerAiSupport, type AiSupportConfig } from "./handlers/ai-support";
import { registerBuiltinCommandHandlers } from "./handlers/builtin-commands";
import { buildSessionMiddleware } from "./session-storage";
import { registerChatTracking } from "./chat-tracking";
import { handleJoinRequest, handleChatMemberUpdate } from "./handlers/chat-member";
import { handleVerificationChoice } from "./handlers/group-verification";
import { handleCodeInput } from "./handlers/code-input";
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
  /** 机器人指令菜单：应用的指令库 id 列表；未配置时默认应用全部已启用指令 */
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
  // 官方 @grammyjs/menu 菜单插件（v1.1.1）：回调路由/子菜单导航/过期恢复全由插件处理
  const instanceMenu = installBotMenu(bot, menuConfig);
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
  return { bot, running: false, mode, capabilitiesReady: false };
}

/**
 * 为机器人实例注册验证与指令能力（真实生效）：
 * - stateless-question 中间件：加群验证码的隐私模式兼容输入通道
 * - 内置指令：按指令库启用状态注册官方内置指令真实处理器（start/help/menu/… 共 23 条）
 * - 自定义指令：按隐私模式开关选择严格/宽松匹配策略（@grammyjs/commands）
 *
 * v1.1.1 性能修复：本函数只做中间件注册 + 库读取（毫秒级），不再同步等待
 * setMyCommands 网络调用；返回后台同步任务，由 startMenuBot 并行调度。
 */
async function registerBotCapabilities(
  bot: Bot<BotContext>,
  profile: BotProfileConfig,
  effectivePrivacy: boolean,
): Promise<() => Promise<void>> {
  const privacyMode = effectivePrivacy;

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

  // 指令菜单：选中的指令同步到 Telegram 用户菜单（setMyCommands）并注册响应
  const selectedIds =
    Array.isArray(profile.commandIds) && profile.commandIds.length > 0
      ? profile.commandIds.map((id) => BigInt(id))
      : null;
  const library = selectedIds
    ? await listBotCommandsByIds(selectedIds)
    : (
        await Promise.all([
          listBotCommands({ type: "builtin", enabledOnly: true }),
          listBotCommands({ type: "custom", enabledOnly: true }),
        ])
      ).flatMap((page) => page.rows);

  // 内置指令：注册真实处理器（含 adminOnly/私聊限定包装；库中未实现的条目回退为介绍回复）
  registerBuiltinCommandHandlers(
    bot,
    library
      .filter((item) => item.type === "builtin")
      .map((item) => ({ name: item.name, intro: item.intro, description: item.description })),
  );

  const customItems = library.filter((item) => item.type === "custom");
  if (customItems.length > 0) {
    const group = new CommandGroup({
      matchOnlyAtStart: privacyMode,
      targetedCommands: privacyMode ? "ignored" : "optional",
    });
    for (const item of customItems) {
      group.command(item.name, item.description, async (ctx) => {
        const intro = item.intro || item.description;
        await ctx.reply(`⌨️ /${item.name}\n\n${intro}`);
      });
    }
    bot.use(group);
  }

  const menuCommands = library.map((item) => ({
    command: item.name,
    description: item.description.slice(0, 256),
  }));
  // 返回后台同步任务：setMyCommands 写入 Telegram（网络调用，不阻塞轮询启动）
  return async () => {
    if (menuCommands.length === 0) return;
    await bot.api.setMyCommands(menuCommands).catch((error) => {
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
  const syncCommands = await registerBotCapabilities(instance.bot, profile, effectivePrivacy);
  if (profile.aiSupport?.enabled) {
    registerAiSupport(instance.bot, profile.aiSupport, row.id);
  }
  instance.capabilitiesReady = true;
  return syncCommands;
}

async function startMenuBot(row: BotRow): Promise<void> {
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
      instance = { ...existing, mode: "webhook", running: false };
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
    console.log(
      `Menu bot #${row.id} transport=webhook ${applied.ok ? `registered: ${applied.url}` : `register failed: ${applied.error ?? "?"}`}`,
    );
    // 指令菜单同步后台执行（与轮询路径同款：不阻塞返回）
    void syncCommandsWebhook();
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
    if (remote) {
      const forced = process.env.TG_FORCE_LOCAL_POLLING === "1";
      const intent = explicitPolling ? "显式配置了本地长轮询" : "隐式回退本地长轮询";
      if (forced) {
        console.warn(
          `[multi-runtime] Menu bot #${row.id} ${intent}，检测到远程 Webhook 消费者（${remote.url}），` +
            "但 TG_FORCE_LOCAL_POLLING=1 —— 按强制接管执行，远程 Webhook 将被删除（远程环境停止收到该机器人事件）。",
        );
      } else {
        console.warn(
          `[multi-runtime] Menu bot #${row.id} ${intent}，但检测到远程 Webhook 消费者（${remote.url}，待处理更新 ${remote.pendingUpdateCount} 条），` +
            "本地长轮询已停用：getUpdates 与 Webhook 互斥，删除远程 Webhook 会掐断另一环境（如线上部署）的事件推送。" +
            "如需本环境接管，请设置 TG_FORCE_LOCAL_POLLING=1 或先在远程环境停用其 Webhook。",
        );
        return;
      }
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
        console.log(`Menu bot #${row.id} started: @${me.username}`);
      },
    },
    {
      label: `Menu bot #${row.id}`,
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

  // Telegram 侧配置同步（互相独立，并行后台执行，单调用有传输层超时兜底）
  void Promise.allSettled([
    applyBotProfile(instance.bot, profile),
    syncCommands(),
    applyBotTransport(
      { token: row.token, botId: String(row.id) },
      "polling",
      global.webhookBaseUrl,
    ),
  ]);
}

export async function startMenuBots(): Promise<void> {
  const rows = await listEnabledBots();
  for (const row of rows) {
    try {
      await startMenuBot(row);
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
  const selectedIds =
    Array.isArray(profile.commandIds) && profile.commandIds.length > 0
      ? profile.commandIds.map((id) => BigInt(id))
      : null;
  const library = selectedIds
    ? await listBotCommandsByIds(selectedIds)
    : (
        await Promise.all([
          listBotCommands({ type: "builtin", enabledOnly: true }),
          listBotCommands({ type: "custom", enabledOnly: true }),
        ])
      ).flatMap((page) => page.rows);
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
