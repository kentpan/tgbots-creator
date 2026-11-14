/**
 * 机器人关键节点真实检测（v2.2.7）—— 仿真页「机器人检测」的唯一检测实现。
 *
 * 参考 grammy console-time 插件的调试哲学（https://grammy.dev/plugins/console-time）：
 * 对机器人消息链路上的每个关键环节逐项计时并输出真实结果 —— 本实现把该思路
 * 从「console 日志」升级为「管理端可视检测」：按顺序对每个节点做真实检测
 * （真实 Telegram API 调用 / 真实数据库读取 / 真实运行实例状态），每项记录耗时，
 * 通过打 ✅，失败打 ❌ 并停止（后续节点跳过），附详细错误与修复建议。
 *
 * 检测节点按消息链路顺序排列：
 *   Token 有效性（getMe）→ Webhook 注册（getWebhookInfo）→ 投递健康（last_error/积压）
 *   → 运行实例（本进程 registry）→ 指令菜单（getMyCommands）→ 群组连接与权限
 *   （getChat/getChatMember）→ TGAPI 门禁配置（验证方式库真实回读）→ TGAPI 界面配置
 *   （生效模式与「创建 API」按钮动作绑定）。
 * polling 模式无 Webhook 两节点；非 TGAPI 机器人无门禁/界面两节点。
 *
 * 红线：所有结论来自真实调用与真实读取 —— 绝不返回预期值、绝不吞错误。
 */

import {
  getVerificationMethod,
  listGroupBotAdmins,
  type BotRow,
} from "@/database/operations";
import { tgRawCall } from "@/lib/telegram/transport";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";
import { withTelegramTimeout, botByToken } from "@/services/telegram-sync";
import { getTelegramRuntimeSettings, resolveBotRuntime } from "@/services/bot-transport";
import { getMenuBotDeployState } from "@/bot/multi-runtime";
import { countMenuStats, parseBotMenuConfig } from "@/services/menu-config";
import {
  parseTgApiBotConfig,
  tgApiInterfaceMode,
  type TgApiBotConfig,
} from "@/services/tgapi-config";
import { isTgApiGateConfigured, checkTgApiGateMethod } from "@/bot/tgapi-gate";
import { parseCodeApiConfig } from "@/services/external-verify";
import { parseBotFeatureConfig } from "@/services/bot-feature-config";
import type { CustomKeyboardButton } from "@/services/custom-keyboard";

/** 检测节点计划项（点击「机器人检测」时先行展示的全部关键节点） */
export interface BotCheckNode {
  key: string;
  label: string;
  /** 检测内容说明（列表副标题） */
  hint: string;
}

/** 单节点真实检测结果（ms 为真实耗时，console-time 式） */
export interface BotCheckNodeResult {
  key: string;
  label: string;
  ok: boolean;
  ms: number;
  /** 真实检测数据摘要（✅ 展示） */
  detail: string;
  /** 失败详细错误（❌ 展示，原文不截断语义） */
  error?: string;
  /** 修复建议（❌ 展示） */
  suggestion?: string;
  /** 失败后停止检测：本节点未执行 */
  skipped?: boolean;
}

function briefErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 带计时的真实执行（console-time 式：开始计时 → 执行 → 结束计时） */
async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await run();
  return { value, ms: Date.now() - startedAt };
}

/** 该机器人配置是否为 TGAPI 申请机器人（bots.config.tgapi.enabled === true） */
export function isTgApiBotRow(config: string): boolean {
  try {
    const profile = JSON.parse(config) as { tgapi?: { enabled?: boolean } };
    return profile.tgapi?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * 生成该机器人的关键节点检测计划（只读、不发任何网络请求）。
 * 顺序即消息链路顺序：入站链路（Token → Webhook → 投递）→ 进程内（实例 → 指令）
 * → 业务面（群组 → 门禁 → 界面配置）。
 */
export async function planBotCheckNodes(bot: Pick<BotRow, "id" | "config">): Promise<BotCheckNode[]> {
  const global = await getTelegramRuntimeSettings();
  const runtime = resolveBotRuntime(String(bot.id), bot.config, global);
  const nodes: BotCheckNode[] = [
    { key: "token", label: "Bot Token 有效性", hint: "真实调用 getMe 验证 Token 与机器人身份" },
  ];
  if (runtime.mode === "webhook") {
    nodes.push(
      { key: "webhook", label: "Webhook 注册状态", hint: "真实调用 getWebhookInfo，校验回调地址与当前环境一致" },
      { key: "delivery", label: "Telegram 投递健康", hint: "检查 Telegram 自己报告的投递错误与消息积压" },
    );
  }
  nodes.push(
    {
      key: "runtime",
      label: "运行实例状态（本进程）",
      hint:
        runtime.mode === "webhook"
          ? "本进程运行实例是否加载并具备完整处理能力（能力注册真实状态）"
          : "长轮询是否在运行（本进程内存即权威）",
    },
    { key: "commands", label: "指令菜单（getMyCommands）", hint: "真实读取 Telegram 侧已注册的指令菜单" },
    { key: "groups", label: "群组连接与机器人权限", hint: "逐个真实调用 getChat / getChatMember 校验群组可达与管理员权限" },
  );
  if (isTgApiBotRow(bot.config)) {
    nodes.push(
      { key: "gate", label: "TGAPI 门禁配置", hint: "解锁方式与绑定验证方式的真实回读（验证方式库 + 配置解析）" },
      { key: "keyboard", label: "TGAPI 界面配置", hint: "生效模式、键盘按钮与「创建 API」动作绑定的真实校验" },
    );
  }
  return nodes;
}

/** 节点固定元数据（计划与结果按 key 对齐） */
function nodeLabel(key: string): string {
  const labels: Record<string, string> = {
    token: "Bot Token 有效性",
    webhook: "Webhook 注册状态",
    delivery: "Telegram 投递健康",
    runtime: "运行实例状态（本进程）",
    commands: "指令菜单（getMyCommands）",
    groups: "群组连接与机器人权限",
    gate: "TGAPI 门禁配置",
    keyboard: "TGAPI 界面配置",
  };
  return labels[key] ?? key;
}

/** Webhook 投递健康节点的真实响应结构（getWebhookInfo 权威字段） */
interface WebhookInfoResult {
  ok: boolean;
  description?: string;
  result?: {
    url?: string;
    last_error_message?: string;
    last_error_date?: number;
    pending_update_count?: number;
    allowed_updates?: string[];
  };
}

/**
 * 执行单个节点的真实检测（index 对应 planBotCheckNodes 的下标）。
 * 每次调用独立发起真实请求/读取 —— 耗时为本次真实执行的耗时。
 */
export async function runBotCheckNode(
  bot: Pick<BotRow, "id" | "enabled" | "config" | "token" | "menuConfig">,
  index: number,
): Promise<BotCheckNodeResult> {
  const plan = await planBotCheckNodes(bot);
  const node = plan[index];
  if (!node) {
    throw new Error(`检测节点下标越界：${index}（共 ${plan.length} 个节点）`);
  }
  const key = node.key;
  const global = await getTelegramRuntimeSettings();
  const runtime = resolveBotRuntime(String(bot.id), bot.config, global);
  const label = nodeLabel(key);

  // -- Token 有效性（getMe 真实调用） --------------------------------------
  if (key === "token") {
    if (!bot.token) {
      return { key, label, ok: false, ms: 0, detail: "", error: "机器人未配置 Token", suggestion: "在机器人管理/TGAPI 页填写 BotFather 下发的 Token 后保存并部署。" };
    }
    try {
      const { value: res, ms } = await timed(() => withTelegramTimeout(tgRawCall<{ ok: boolean; description?: string; result?: { id?: number; username?: string; can_join_groups?: boolean } }>(bot.token, "getMe")));
      if (!res.ok || !res.result) {
        return { key, label, ok: false, ms, detail: "", error: `Telegram API 拒绝：${res.description ?? "未知错误"}`, suggestion: "在 @BotFather 用 /mybots 确认 Token 未被重置（/revoke 会换新 Token）；更新 Token 后保存并重新部署。网络受限时检查「代理偏好设置」。" };
      }
      return { key, label, ok: true, ms, detail: `@${res.result.username ?? "?"}（id ${res.result.id ?? "?"}）身份有效` };
    } catch (error) {
      return { key, label, ok: false, ms: 0, detail: "", error: briefErrorText(error), suggestion: "无法连上 Telegram API：检查服务器网络与「代理偏好设置」后重试。" };
    }
  }

  // -- Webhook 注册状态（getWebhookInfo 权威值） ----------------------------
  if (key === "webhook") {
    try {
      const { value: res, ms } = await timed(() => withTelegramTimeout(tgRawCall<WebhookInfoResult>(bot.token, "getWebhookInfo")));
      if (!res.ok) {
        return { key, label, ok: false, ms, detail: "", error: `Telegram API 返回错误：${res.description ?? "未知"}`, suggestion: "稍后重试；持续失败请检查 Token 与代理。" };
      }
      const url = (res.result?.url ?? "").trim();
      if (!url) {
        return { key, label, ok: false, ms, detail: "", error: "Webhook 未注册（Telegram 报告 url 为空）—— 所有消息都不会推送给机器人（机器人表现为完全无反应）", suggestion: "在仿真页或机器人管理页点击「部署」重新注册 Webhook；若部署报错按部署消息修复。" };
      }
      if (runtime.webhookUrl && url !== runtime.webhookUrl) {
        return { key, label, ok: false, ms, detail: "", error: `Webhook 指向 ${url}，与当前环境期望的 ${runtime.webhookUrl} 不一致（消息在推给别的地址）`, suggestion: "重新部署本机器人，把 Webhook 覆盖为当前环境的回调地址。" };
      }
      const feature = parseBotFeatureConfig(bot.config, false);
      if (feature.joinVerify.enabled && !(res.result?.allowed_updates ?? []).includes("chat_join_request")) {
        return {
          key,
          label,
          ok: false,
          ms,
          detail: `已注册：${url}`,
          error: "Webhook 的 allowed_updates 未包含 chat_join_request；Telegram 不会把加群申请事件投递给看门狗机器人",
          suggestion: "在仿真APP页对该机器人重新部署，重新 setWebhook 后再运行机器人检测。",
        };
      }
      return { key, label, ok: true, ms, detail: `已注册：${url}${feature.joinVerify.enabled ? "；chat_join_request 订阅 ✓" : ""}` };
    } catch (error) {
      return { key, label, ok: false, ms: 0, detail: "", error: briefErrorText(error), suggestion: "getWebhookInfo 网络失败：检查网络/代理后重试。" };
    }
  }

  // -- 投递健康（Telegram 自己报告的 last_error / 积压） --------------------
  if (key === "delivery") {
    try {
      const { value: res, ms } = await timed(() => withTelegramTimeout(tgRawCall<WebhookInfoResult>(bot.token, "getWebhookInfo")));
      if (!res.ok) {
        return { key, label, ok: false, ms, detail: "", error: `Telegram API 返回错误：${res.description ?? "未知"}`, suggestion: "稍后重试。" };
      }
      const lastError = (res.result?.last_error_message ?? "").trim();
      const pending = res.result?.pending_update_count ?? 0;
      if (lastError) {
        const dateText = res.result?.last_error_date ? new Date(res.result.last_error_date * 1000).toLocaleString("zh-CN") : "未知时间";
        return { key, label, ok: false, ms, detail: "", error: `Telegram 投递失败（${dateText}）：${lastError}${pending > 0 ? `；积压 ${pending} 条未投递` : ""}`, suggestion: "常见原因：回调地址 HTTPS 不可达 / 密钥校验 401 / 处理超时。修复服务可达性后重新部署；部署成功后再跑一次本检测确认。" };
      }
      return { key, label, ok: true, ms, detail: pending > 0 ? `投递正常（积压 ${pending} 条待投递）` : "投递正常：无投递错误、无积压" };
    } catch (error) {
      return { key, label, ok: false, ms: 0, detail: "", error: briefErrorText(error), suggestion: "getWebhookInfo 网络失败：检查网络/代理后重试。" };
    }
  }

  // -- 运行实例（本进程 registry 即权威） -----------------------------------
  if (key === "runtime") {
    const { value: state, ms } = await timed(async () => getMenuBotDeployState(bot.id));
    if (!state.present) {
      // Workers/Edge 形态（isEdgeRuntime）没有常驻进程：isolate 内存不共享，
      // webhook 更新由 webhook 路由 acquireMenuBot 按请求懒加载实例处理 ——
      // 本进程 registry 无实例是形态常态而非故障；健康以「Webhook 注册状态」
      // 「投递健康」（getWebhookInfo，Telegram 侧权威）节点为准，不构成误报。
      if (isEdgeRuntime()) {
        return {
          key,
          label,
          ok: true,
          ms,
          detail:
            "Workers/Edge 形态：无常驻运行进程（按设计），Webhook 更新由边缘 Worker 按请求实例化处理；健康以「Webhook 注册状态」「投递健康」节点为准",
        };
      }
      return { key, label, ok: false, ms, detail: "", error: `本进程没有该机器人的运行实例（${runtime.mode === "webhook" ? "Webhook 推送进来将无人处理" : "长轮询未启动"}）`, suggestion: "点击「部署」启动运行实例；若刚重启服务器，部署一次即可恢复。" };
    }
    if (runtime.mode === "webhook") {
      if (state.transportOk === false) {
        return { key, label, ok: false, ms, detail: "", error: `运行实例存在但传输层部署失败：${state.transportError ?? "未知错误"}`, suggestion: "按部署错误修复（常见：Webhook Base URL 未配置/不可达）后重新部署。" };
      }
      return { key, label, ok: true, ms, detail: `运行实例已加载（Webhook 模式，能力注册就绪${state.transportUrl ? `，回调 ${state.transportUrl}` : ""}）` };
    }
    if (!state.running || !state.started) {
      return { key, label, ok: false, ms, detail: "", error: `长轮询未在运行：${state.startError ?? state.transportError ?? "实例已存在但轮询未确认启动"}`, suggestion: "重新部署启动长轮询；持续失败按错误信息排查 Token/网络。" };
    }
    return { key, label, ok: true, ms, detail: `长轮询运行中${state.transportUrl ? `（${state.transportUrl}）` : ""}` };
  }

  // -- 指令菜单（getMyCommands 真实读取） -----------------------------------
  if (key === "commands") {
    try {
      const { value: commands, ms } = await timed(() => withTelegramTimeout(botByToken(bot.token).api.getMyCommands()));
      if (commands.length === 0) {
        return { key, label, ok: true, ms, detail: "0 条指令（未在「⌨️ 指令菜单」勾选任何指令；自定义键盘模式不依赖指令菜单）" };
      }
      return { key, label, ok: true, ms, detail: `${commands.length} 条：${commands.map((item) => `/${item.command}`).join(" ")}` };
    } catch (error) {
      return { key, label, ok: false, ms: 0, detail: "", error: briefErrorText(error), suggestion: "getMyCommands 网络失败：检查网络/代理后重试。" };
    }
  }

  // -- 群组连接与权限（getChat / getChatMember 逐个真实校验） ----------------
  if (key === "groups") {
    const { value: rows, ms } = await timed(() => listGroupBotAdmins());
    const botRows = rows.filter((row) => row.botId === bot.id);
    if (botRows.length === 0) {
      return { key, label, ok: true, ms, detail: "未登记群组（TGAPI 申请机器人可纯私聊运行；加群验证机器人至少需要 1 个群组）" };
    }
    const tokenBotId = Number(bot.token.split(":")[0]);
    const api = botByToken(bot.token).api;
    const problems: string[] = [];
    const summaries: string[] = [];
    for (const row of botRows) {
      const chatId = row.chatId;
      try {
        const chat = await withTelegramTimeout(api.getChat(Number(chatId)));
        const title = "title" in chat && chat.title ? chat.title : `群组 ${chatId}`;
        try {
          const member = await withTelegramTimeout(api.getChatMember(Number(chatId), tokenBotId));
          if (member.status === "administrator") {
            const canInvite = "can_invite_users" in member ? member.can_invite_users === true : false;
            if (canInvite) {
              summaries.push(`「${title}」管理员 ✓ 邀请权限 ✓`);
            } else {
              problems.push(`「${title}」是管理员但缺少「邀请用户 via 链接」权限（入群申请事件将收不到）`);
            }
          } else if (member.status === "left" || member.status === "kicked") {
            problems.push(`「${title}」机器人已${member.status === "kicked" ? "被移出" : "离开"}群组`);
          } else {
            problems.push(`「${title}」机器人在群但不是管理员（无法生成邀请链接/收加群申请/删消息）`);
          }
        } catch (memberError) {
          problems.push(`「${title}」getChatMember 失败：${briefErrorText(memberError)}`);
        }
      } catch (chatError) {
        problems.push(`群组 ${chatId} 不可达：${briefErrorText(chatError)}（可能已被移出/群已升级迁移）`);
      }
    }
    if (problems.length > 0) {
      return { key, label, ok: false, ms, detail: summaries.join("；"), error: problems.join("；"), suggestion: "把机器人加回群组并设为管理员，勾选「邀请用户 via 链接」等权限后重新部署；群升级超级群后旧群组请在群组设置重新部署生成新链接。" };
    }
    return { key, label, ok: true, ms, detail: `${botRows.length} 个群组全部可达：${summaries.join("；")}` };
  }

  // -- TGAPI 门禁配置（验证方式库真实回读） ---------------------------------
  if (key === "gate") {
    const { value: out, ms } = await timed(async () => {
      const cfg = parseTgApiBotConfig(bot.config);
      if (!cfg.enabled) {
        return { ok: false, error: "TGAPI 功能未启用（tgapi.enabled=false）——运行实例不会注册任何 TGAPI 能力", suggestion: "在「TGAPI申请」页启用该机器人并部署。" } as const;
      }
      if (!isTgApiGateConfigured(cfg)) {
        return { ok: false, error: `门禁未配置：unlockMode=${cfg.unlockMode}${cfg.unlockMode === "captcha" ? " 但未绑定验证方式" : " 但星星金额未设置"}——未验证用户将永远无法通过门禁`, suggestion: "在「TGAPI申请 → 菜单和键盘 → 🔐 门禁」选择解锁方式：验证码模式需绑定一个 code_api 验证方式；星星模式需设置金额 ≥1。" } as const;
      }
      if (cfg.unlockMode === "captcha") {
        const check = await checkTgApiGateMethod({ cfg, botId: bot.id });
        if (check.kind !== "ready") {
          const reason = check.kind === "method-missing"
            ? "绑定的验证方式不存在"
            : check.kind === "method-unavailable"
              ? "绑定的验证方式已停用"
              : "验证方式配置无法解析为外部核验 API";
          return { ok: false, error: `门禁核验前置失败：${reason}（verificationMethodId=${String(cfg.verificationMethodId ?? "?")}）`, suggestion: "在「TGAPI申请 → 门禁」重新绑定一个启用中的 code_api 验证方式；也可在验证方式库里修复该条目的 API 配置。" } as const;
        }
        const method = await getVerificationMethod(BigInt(cfg.verificationMethodId ?? 0));
        const parsed = parseCodeApiConfig(method?.config ?? "");
        return { ok: true, detail: `验证码门禁 · 验证方式「${method?.name ?? "?"}」（#${String(cfg.verificationMethodId)}）外部核验配置有效（${parsed?.http_method ?? "?"} ${parsed?.url ?? "?"}）` } as const;
      }
      // v2.3 星星解锁已移除：非 captcha 视为未配置门禁
      return { ok: false, error: "门禁解锁方式无效（星星解锁已移除，仅支持验证码解锁）", suggestion: "在「TGAPI申请 → 门禁」绑定一个启用中的 code_api 验证方式。" } as const;
    });
    if (out.ok) {
      return { key, label, ok: true, ms, detail: out.detail };
    }
    return { key, label, ok: false, ms, detail: "", error: out.error, suggestion: out.suggestion };
  }

  // -- TGAPI 界面配置（生效模式与「创建 API」动作绑定） ----------------------
  if (key === "keyboard") {
    const cfg: TgApiBotConfig = parseTgApiBotConfig(bot.config);
    const mode = tgApiInterfaceMode(cfg);
    const menuConfig = parseBotMenuConfig(bot.menuConfig);
    const feature = parseBotFeatureConfig(bot.config, countMenuStats(menuConfig.root).buttons > 0);
    const keyboardEnabled = feature.keyboard.enabled;
    const menuEnabled = feature.menu.enabled;
    if (!keyboardEnabled && !menuEnabled) {
      return { key, label, ok: true, ms: 0, detail: "内嵌按钮与自定义键盘均已关闭；用户只能通过已单独启用的指令入口访问 TGAPI 流程" };
    }
    if (keyboardEnabled && mode === "keyboard") {
      const kb = cfg.customKeyboard;
      if (!kb) {
        return { key, label, ok: false, ms: 0, detail: "", error: "已开启自定义键盘，但键盘配置为空，无法显示可操作的主键盘", suggestion: "在「菜单和键盘 → 自定义键盘」保存至少一个文本按钮，或切回消息内嵌按钮模式。" };
      }
      const flatten = (rows: typeof kb.root.rows): CustomKeyboardButton[] =>
        rows.flatMap((row) => row.buttons.flatMap((button) => [button, ...(button.submenu ? flatten(button.submenu.rows) : [])]));
      const buttons = flatten(kb.root.rows);
      const createButton = buttons.find((item) => item.action?.type === "tgapi_func" && item.action.tgapi_func === "create");
      const myButton = buttons.find((item) => item.action?.type === "tgapi_func" && item.action.tgapi_func === "my");
      if (!createButton) {
        return { key, label, ok: false, ms: 0, detail: "", error: `键盘含 ${buttons.length} 个按钮，但没有绑定「创建API」动作的文本按钮——用户无法进入申请流程`, suggestion: "在「菜单和键盘 → 自定义键盘」把一个文本按钮绑定 TGAPI 指令「创建API」。" };
      }
      if (createButton.kind !== "text") {
        return { key, label, ok: false, ms: 0, detail: "", error: `「${createButton.text}」按钮类型为 ${createButton.kind}：点击不会发送按钮文本，创建流程无法开始`, suggestion: "把创建 API 按钮改为「文本」类型并绑定「创建API」指令。" };
      }
      return { key, label, ok: true, ms: 0, detail: `自定义键盘模式：${kb.root.rows.length} 行 ${buttons.length} 个按钮（含子菜单）；「${createButton.text}」→ 创建API ✓${myButton ? `；「${myButton.text}」→ 我的API ✓` : ""}` };
    }
    if (!menuEnabled) {
      return { key, label, ok: false, ms: 0, detail: "", error: "自定义键盘已开启，但界面模式不是键盘；内嵌按钮也已关闭", suggestion: "将界面模式切换为「自定义键盘」，或启用「消息内嵌按钮」。" };
    }
    const stats = countMenuStats(menuConfig.root);
    return { key, label, ok: true, ms: 0, detail: `消息内嵌按钮模式：菜单 ${stats.buttons} 个按钮${stats.submenus > 0 ? `（含 ${stats.submenus} 个子菜单）` : ""}` };
  }

  throw new Error(`未知检测节点：${key}`);
}
