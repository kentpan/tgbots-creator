"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListTree } from "lucide-react";
import { EditorMobileSwitch } from "@/components/admin/editor-mobile-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  TgSimulator,
  type TgSimulatorHandle,
} from "@/components/admin/tg-simulator";
import { TgApiBotGroupsPanel } from "@/components/admin/tgapi-bot-groups-panel";
import { useRealGroups } from "@/components/admin/use-real-groups";
import { CustomKeyboardDesigner } from "@/components/admin/custom-keyboard-dialog";
import { emptyKeyboardOptions } from "@/components/admin/custom-keyboard-editor";
import type { CustomKeyboardConfig } from "@/services/custom-keyboard";
import { ConfigPanel } from "@/components/admin/config-panel";
import { SubmitButton } from "@/components/admin/submit-button";
import { TgApiGatePanel } from "@/components/admin/tgapi-gate-panel";
import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";
import { MenuDesignerFields } from "@/components/admin/menu-designer-fields";
import {
  CommandMenuConfigFields,
  type CommandLibraryItem,
} from "@/app/admin/bots/command-menu-dialog";
import { saveBotFeatureConfigAction } from "./actions";
import {
  DesignerBasicInfo,
  designerInputClass,
  parseDesignerProfile,
  parseDesignerTgApiCfg,
  type DesignerBotInfo,
} from "../tgapi/bot-designer-shared";
import { useDesignerSimChat } from "../tgapi/use-designer-sim-chat";
import {
  emptyMenuConfig,
  parseBotMenuConfig,
  countMenuStats,
  renderMenuTemplate,
  type BotMenuConfig,
} from "@/services/menu-config";
import type { CustomKeyboardButton } from "@/services/custom-keyboard";
import {
  parseBotFeatureConfig,
  type GateFeatureConfig,
} from "@/services/bot-feature-config";

/**
 * 机器人管理「功能配置」弹窗（v2.3 重构：独立组件，不再与 TGAPI 弹窗共用 variant 分支）：
 *
 * 数据驱动模型（单一事实源）：
 * - 左侧 = 配置状态（feature 开关 / menu / keyboard / joinVerify / gate），全部为弹窗 state；
 * - 右侧 = 固定仿真屏容器（TgSimulator），配置经 props 实时呈现 —— 开关只切换「哪些配置
 *   生效」，仿真屏随配置变化即时渲染，不改容器、不做两套仿真屏。
 *
 * 模块：基本信息 / 加群验证 / 门禁解锁 / 功能开关（消息内嵌按钮 ⇄ 自定义键盘互斥 +
 * 指令菜单独立）/ 真实群组。保存走 saveBotFeatureConfigAction（一次落库 + 热更新）。
 */

interface FeatureDraft {
  /** 互斥界面开关：inline=内嵌按钮 / keyboard=自定义键盘 / none=全关（配置保留） */
  uiMode: "inline" | "keyboard" | "none";
  commandsEnabled: boolean;
  gateMenuRequired: boolean;
  gateKeyboardRequired: boolean;
  gateCommandsRequired: boolean;
  joinVerifyEnabled: boolean;
  gateEnabled: boolean;
}

function readFeatureDraft(bot?: DesignerBotInfo): FeatureDraft {
  if (!bot) {
    return {
      uiMode: "none",
      commandsEnabled: false,
      gateMenuRequired: false,
      gateKeyboardRequired: false,
      gateCommandsRequired: false,
      joinVerifyEnabled: false,
      gateEnabled: false,
    };
  }
  const feature = parseBotFeatureConfig(bot.config, false);
  const uiMode: FeatureDraft["uiMode"] = feature.keyboard.enabled
    ? "keyboard"
    : feature.menu.enabled
      ? "inline"
      : "none";
  return {
    uiMode,
    commandsEnabled: feature.commands.enabled,
    gateMenuRequired: feature.gateMenuRequired === true,
    gateKeyboardRequired: feature.gateKeyboardRequired === true,
    gateCommandsRequired: feature.gateCommandsRequired === true,
    joinVerifyEnabled: feature.joinVerify.enabled,
    gateEnabled: feature.gate.enabled,
  };
}

function readMenuDraft(bot?: DesignerBotInfo): BotMenuConfig {
  if (!bot) return emptyMenuConfig();
  try {
    const parsed = JSON.parse(bot.menuConfig) as {
      content?: BotMenuConfig["content"];
      root?: BotMenuConfig["root"];
    };
    if (parsed.root && Array.isArray(parsed.root.rows)) {
      return {
        content: parsed.content ?? emptyMenuConfig().content,
        root: parsed.root,
      } as BotMenuConfig;
    }
  } catch {
    /* 坏数据按空菜单处理 */
  }
  return emptyMenuConfig();
}

function readWelcomeText(bot?: DesignerBotInfo): string {
  if (!bot) return "";
  try {
    const parsed = JSON.parse(bot.config) as { welcomeText?: unknown };
    return typeof parsed.welcomeText === "string" ? parsed.welcomeText : "";
  } catch {
    return "";
  }
}

export function FeatureConfigDialog({
  bot,
  methods,
  library,
  trigger,
  triggerClassName,
}: {
  bot?: DesignerBotInfo;
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  /** 指令库（SSR 按当前机器人过滤后的可见指令：内置 + 全局/群组/本机器人自定义） */
  library: CommandLibraryItem[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"config" | "preview">("config");
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const cfg = useMemo(() => parseDesignerTgApiCfg(bot), [bot]);
  const profile = useMemo(() => parseDesignerProfile(bot), [bot]);
  const suffix = bot ? String(bot.id) : "new";
  const botDisplayName = bot?.username ? `@${bot.username}` : bot?.name ?? "机器人";

  // —— 配置状态（单一事实源；每次打开按最新已保存数据重置） ——
  const [feature, setFeature] = useState<FeatureDraft>(() => readFeatureDraft(bot));
  const [menu, setMenu] = useState<BotMenuConfig>(() => readMenuDraft(bot));
  const [welcomeText, setWelcomeText] = useState(() => readWelcomeText(bot));
  const [kbPayload, setKbPayload] = useState<string>(() =>
    cfg.customKeyboard ? JSON.stringify(cfg.customKeyboard) : "",
  );
  const [privacyMode, setPrivacyMode] = useState(profile.privacyMode);
  const [selectedCommandIds, setSelectedCommandIds] = useState<number[]>(profile.commandIds);
  const featureGate = useMemo<GateFeatureConfig>(() => {
    if (!bot) return { enabled: false, verificationMethodId: null };
    return parseBotFeatureConfig(bot.config, false).gate;
  }, [bot]);
  const joinVerifyMethodId = useMemo(() => {
    if (!bot) return null;
    return parseBotFeatureConfig(bot.config, false).joinVerify.methodId;
  }, [bot]);
  const joinVerifyOverride = useMemo(() => {
    if (!bot) return {} as { timeout_seconds?: number; max_attempts?: number };
    return {
      timeout_seconds: parseBotFeatureConfig(bot.config, false).joinVerify.override?.timeout_seconds,
      max_attempts: parseBotFeatureConfig(bot.config, false).joinVerify.override?.max_attempts,
    };
  }, [bot]);

  useEffect(() => {
    if (open) {
      setFeature(readFeatureDraft(bot));
      setMenu(readMenuDraft(bot));
      setWelcomeText(readWelcomeText(bot));
      setKbPayload(cfg.customKeyboard ? JSON.stringify(cfg.customKeyboard) : "");
      setPrivacyMode(profile.privacyMode);
      setSelectedCommandIds(profile.commandIds);
    }
  }, [open, bot, cfg.customKeyboard, profile]);

  const patch = (partial: Partial<FeatureDraft>): void =>
    setFeature((prev) => ({ ...prev, ...partial }));

  // 子编辑器在 commit 后通过 effect 回传变更；宿主直接更新待保存载荷。
  const handleKbConfigChange = useCallback((config: CustomKeyboardConfig): void => {
    setKbPayload(config.root.rows.length === 0 ? "" : JSON.stringify(config));
  }, []);
  const currentKb = useMemo<CustomKeyboardConfig>(() => {
    if (!kbPayload) return { options: emptyKeyboardOptions(), root: { rows: [] } };
    try {
      return JSON.parse(kbPayload) as CustomKeyboardConfig;
    } catch {
      return { options: emptyKeyboardOptions(), root: { rows: [] } };
    }
  }, [kbPayload]);

  // —— 仿真屏（固定容器，配置驱动） ——
  const simRef = useRef<TgSimulatorHandle>(null);
  const sim = useDesignerSimChat({ simRef, cfg });
  const realGroups = useRealGroups({
    botId: bot ? String(bot.id) : null,
    enabled: open && Boolean(bot),
  });
  const realGroupTitle = realGroups.groups[0]?.chatTitle?.trim() || "My Bot Group";
  const [simNodeId, setSimNodeId] = useState("root");
  const simulatorConfig = useMemo<BotMenuConfig>(
    () => ({ content: menu.content, root: menu.root }),
    [menu],
  );
  // 仿真屏键盘按钮点击响应（replyKeyboard 面板）：按按钮配置给出真实语义预览
  const handleSimReplyClick = (button: CustomKeyboardButton): void => {
    if (button.kind === "web_app" && button.url) {
      window.open(button.url, "_blank", "noopener");
      return;
    }
    const simAppend = (from: "bot" | "user", text: string): void => {
      simRef.current?.appendMessage("dm", { from, text });
    };
    simAppend("user", button.text);
    const action = button.action;
    if (!action) {
      simAppend("bot", "（该按钮未配置点击后的交互：机器人不会响应）");
      return;
    }
    if (action.gateRequired === true) {
      simAppend("bot", "🔒 已开启「门禁解锁」：真实端未解锁用户点击先收到验证挑战，解锁后重新点击执行。");
    }
    if (action.type === "reply") {
      const raw = action.content?.text || action.text || "";
      simAppend("bot", renderMenuTemplate(raw, {
        user_id: "777000",
        username: "preview_user",
        first_name: "预览",
        chat_id: "-1001998877661",
      }) || "（未配置回复内容）");
      return;
    }
    if (action.type === "url") {
      simAppend("bot", `🔗 打开链接：${action.url || "（未配置）"}（真实端发送携带 URL 内联按钮的消息）`);
      return;
    }
    if (action.type === "web_app") {
      simAppend("bot", `🪟 打开 WebApp：${action.url || "（未配置）"}（真实端发送携带 WebApp 内联按钮的消息）`);
      return;
    }
    if (action.type === "command") {
      simAppend("bot", `⌨️ 执行指令 /${action.target || "（未选择）"}：真实端等同用户发送该指令`);
      return;
    }
    if (action.type === "verify") {
      simAppend("bot", "🔐 外部验证 API：真实端在输入框直接发送验证码，机器人调用绑定验证方式核验；无需回复提示消息。");
      return;
    }
    if (action.type === "switch_inline") {
      simAppend("bot", `↗️ 切换到其他聊天的内联查询（预填：${action.switch_query || "（未配置）"}）`);
      return;
    }
    if (action.type === "switch_inline_current") {
      simAppend("bot", `⌨️ 在当前聊天输入框预填内容：${action.switch_query || "（未配置）"}`);
      return;
    }
    if (action.type === "submenu") {
      simAppend("bot", "📂 进入子菜单：真实端机器人发送子菜单键盘替换当前键盘（保存并部署后生效）。");
      return;
    }
    if (action.type === "back") {
      simAppend("bot", "🔙 返回上一级：真实端机器人发送上一级键盘替换当前键盘（保存并部署后生效）。");
      return;
    }
    simAppend("bot", "（该交互类型暂无仿真预览；真实行为以部署后运行为准）");
  };

  const menuStats = useMemo(() => countMenuStats(menu.root), [menu]);
  const keyboardButtonCount = currentKb.root.rows.reduce((n, row) => n + row.buttons.length, 0);

  // 指令库/验证方式选项（与机器人管理页同一过滤规则）
  const builtinCommands = useMemo(
    () =>
      library
        .filter((item) => item.type === "builtin")
        .map((item) => ({ id: item.id, name: item.name, label: `/${item.name} — ${item.description}` })),
    [library],
  );
  const customCommands = useMemo(
    () =>
      library
        .filter((item) => item.type === "custom")
        .map((item) => ({ id: item.id, name: item.name, label: `/${item.name} — ${item.description}` })),
    [library],
  );
  // 指令菜单数据驱动：开关开启且已勾选指令时，仿真屏输入区出现「菜单」按钮与指令滑屏
  const configuredCommands = useMemo(
    () =>
      library
        .filter((item) => selectedCommandIds.map(String).includes(item.id))
        .map((item) => ({ name: item.name, description: item.description })),
    [library, selectedCommandIds],
  );

  const verificationOptions = useMemo(
    () =>
      methods.map((method) => ({
        id: String(method.id),
        name: method.name,
        enabled: method.enabled,
        type: method.type,
      })),
    [methods],
  );

  const inlineOn = feature.uiMode === "inline";
  const keyboardOn = feature.uiMode === "keyboard";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1560px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1560px]">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <ListTree className="h-5 w-5 text-primary" />
            功能配置 · {bot ? bot.name : "新机器人"}
          </DialogTitle>
          <DialogDescription>
            机器人功能统一配置：自动响应加群申请（加群验证）/ 门禁解锁 / 功能开关（消息内嵌按钮 ⇄
            自定义键盘互斥 + 指令菜单）/ 真实群组；右侧仿真屏随配置实时预览（数据驱动）。
            保存仅落库配置，上线/更新运行实例请到「仿真APP」页面部署。
          </DialogDescription>
        </DialogHeader>
        <form action={saveBotFeatureConfigAction} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="id" value={bot ? String(bot.id) : ""} />
          <input
            type="hidden"
            name="menu_config"
            value={JSON.stringify({ content: menu.content, root: menu.root })}
          />
          <input type="hidden" name="kb_mode" value={feature.uiMode === "none" ? "" : feature.uiMode} />
          <input type="hidden" name="custom_keyboard" value={kbPayload} />
          <input type="hidden" name="privacyMode" value={privacyMode ? "1" : "0"} />
          <input type="hidden" name="commandIds" value={JSON.stringify(selectedCommandIds)} />
          <input type="hidden" name="menu_enabled" value={inlineOn ? "1" : "0"} />
          <input type="hidden" name="keyboard_enabled" value={keyboardOn ? "1" : "0"} />
          <input type="hidden" name="commands_enabled" value={feature.commandsEnabled ? "1" : "0"} />
          <input type="hidden" name="gate_menu_required" value={feature.gateMenuRequired ? "1" : "0"} />
          <input type="hidden" name="gate_keyboard_required" value={feature.gateKeyboardRequired ? "1" : "0"} />
          <input type="hidden" name="gate_commands_required" value={feature.gateCommandsRequired ? "1" : "0"} />
          <input type="hidden" name="join_verify_enabled" value={feature.joinVerifyEnabled ? "1" : "0"} />
          <input type="hidden" name="welcome_text" value={welcomeText} />
          <input type="hidden" name="gate_enabled" value={feature.gateEnabled ? "1" : "0"} />

          <div ref={editorScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 sm:px-6 sm:py-4">
            <div className="mb-3 lg:hidden">
              <EditorMobileSwitch
                value={mobilePane}
                onChange={(pane) => {
                  setMobilePane(pane);
                  editorScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            </div>
            <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
              {/* —— 左侧配置区 —— */}
              <div className={`min-w-0 space-y-4 ${mobilePane === "config" ? "block" : "hidden"} lg:block`}>
                <DesignerBasicInfo bot={bot} suffix={suffix} defaultName="机器人" />

                <nav aria-label="功能配置快速导航" className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur">
                  {[
                    ["#welcome-config", "欢迎消息"],
                    ["#join-verify-config", "加群验证"],
                    ["#gate-config", "门禁解锁"],
                    ["#interface-config", "菜单与键盘"],
                    ["#groups-config", "真实群组"],
                  ].map(([href, label]) => (
                    <a
                      key={href}
                      href={href}
                      className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {label}
                    </a>
                  ))}
                </nav>

                <section id="welcome-config" className="scroll-mt-16 rounded-xl border bg-card p-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold">💬 /start 欢迎消息（可自定义）</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      这里编辑用户首次打开机器人看到的整段介绍。留空使用 TGuard 默认文案；支持换行与变量 {"{{bot_name}}"}、{"{{bot_username}}"}。菜单按钮仍由下方菜单配置控制。
                    </p>
                  </div>
                  <textarea
                    value={welcomeText}
                    onChange={(event) => setWelcomeText(event.target.value)}
                    rows={8}
                    maxLength={3500}
                    placeholder="🤖 欢迎使用……\n\n🛡️ 功能介绍……\n\n使用 /help 查看更多信息"
                    className={`${designerInputClass()} min-h-36 resize-y font-mono text-sm leading-relaxed`}
                    aria-label="机器人 /start 欢迎消息"
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>纯文本安全发送，不需要转义 Markdown 特殊字符。</span>
                    <span>{welcomeText.length}/3500</span>
                  </div>
                </section>

                {/* 🚪 加群验证 */}
                <div id="join-verify-config" className="scroll-mt-16">
                <ConfigPanel
                  title="🚪 自动响应加群申请（加群验证）"
                  description="开启后，被群组指定为「自动审核机器人」时自动验证加群申请：私聊发送验证消息，通过后静默放行，失败 3 次拒绝。还需在群组「群组信息 → 新成员审核」中选择本机器人。"
                  checked={feature.joinVerifyEnabled}
                  onCheckedChange={(checked) => patch({ joinVerifyEnabled: checked })}
                >
                  <div className="space-y-4">
                    <TgApiUnlockMethodBinding
                      initialMethods={methods}
                      initialMethodId={
                        joinVerifyMethodId && /^\d+$/.test(joinVerifyMethodId)
                          ? Number(joinVerifyMethodId)
                          : null
                      }
                      hiddenName="join_verify_method_id"
                    />
                    <p className="text-xs text-muted-foreground">
                      上方下拉选择验证方式（验证方式库全部方式），点击「配置外部验证 API」可直接编辑该方式的
                      API 地址 / apikey / 传参 / 响应解析（保存到验证方式库，同一数据源）。列表没有需要的方式？到
                      <a href="/admin/verification-methods" className="mx-1 text-primary underline">验证方式页</a>
                      新增（支持 验证码核验 API / 自动验证码 / 人机验证）。
                    </p>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor={`jv-timeout-${suffix}`}>
                          验证超时（秒，留空用默认）
                        </label>
                        <input
                          id={`jv-timeout-${suffix}`}
                          name="join_verify_timeout"
                          type="number"
                          min="1"
                          defaultValue={joinVerifyOverride?.timeout_seconds ?? ""}
                          placeholder="300"
                          className={designerInputClass()}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor={`jv-attempts-${suffix}`}>
                          最大尝试次数（留空用默认）
                        </label>
                        <input
                          id={`jv-attempts-${suffix}`}
                          name="join_verify_attempts"
                          type="number"
                          min="1"
                          defaultValue={joinVerifyOverride?.max_attempts ?? ""}
                          placeholder="3"
                          className={designerInputClass()}
                        />
                      </div>
                    </div>
                  </div>
                </ConfigPanel>
                </div>

                {/* 🔐 门禁解锁 */}
                <div id="gate-config" className="scroll-mt-16">
                <ConfigPanel
                  title="🔐 门禁解锁（会话级，全局共享）"
                  description="挂在内嵌按钮/自定义键盘按钮/指令上的前置验证：未解锁用户点击后先完成验证，解锁一次对该机器人所有门禁入口永久生效。"
                  checked={feature.gateEnabled}
                  onCheckedChange={(checked) => patch({ gateEnabled: checked })}
                >
                  <TgApiGatePanel
                    idScope={`gate-${suffix}`}
                    methods={methods}
                    verificationMethodId={
                      featureGate?.verificationMethodId
                        ? Number(featureGate.verificationMethodId)
                        : undefined
                    }
                  />
                </ConfigPanel>
                </div>

                {/* 🧩 功能开关 + 平铺配置模块 */}
                <div id="interface-config" className="scroll-mt-16 space-y-3 rounded-xl border bg-card p-4">
                  <div>
                    <p className="text-sm font-semibold">🧩 功能开关（显式开启才生效）</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      消息内嵌按钮与自定义键盘互斥（check 单选，可都取消）；指令菜单独立勾选。
                      关闭后配置保留不清空，重新开启原样回显；全新机器人默认全部关闭。
                    </p>
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        inlineOn ? "border-primary/50 bg-primary/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={inlineOn}
                        onChange={() => patch({ uiMode: inlineOn ? "none" : "inline" })}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">💬 消息内嵌按钮</span>
                        <span className="block text-[11px] text-muted-foreground">初始消息底部 InlineKeyboard</span>
                      </span>
                    </label>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        keyboardOn ? "border-sky-500/50 bg-sky-500/5" : ""
                      } ${!bot ? "opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={keyboardOn}
                        onChange={() => patch({ uiMode: keyboardOn ? "none" : "keyboard" })}
                        disabled={!bot}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">⌨️ 自定义键盘</span>
                        <span className="block text-[11px] text-muted-foreground">ReplyKeyboard 对话流程</span>
                      </span>
                    </label>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        feature.commandsEnabled ? "border-emerald-500/50 bg-emerald-500/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={feature.commandsEnabled}
                        onChange={(event) => patch({ commandsEnabled: event.target.checked })}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">📋 指令菜单</span>
                        <span className="block text-[11px] text-muted-foreground">独立勾选，可与上面共存</span>
                      </span>
                    </label>
                  </div>

                  {/* 平铺：消息内嵌按钮配置（与「消息内嵌按钮」弹窗同一编辑器；配置 → 仿真屏实时同步） */}
                  {inlineOn ? (
                    <div className="space-y-2 rounded-xl border border-primary/30 bg-muted/10 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">💬 消息内嵌按钮配置（右侧仿真屏实时预览）</p>
                        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                          <span className="text-xs font-medium">🔒 门禁解锁（本面板全部按钮点击先验证）</span>
                          <Switch
                            checked={feature.gateMenuRequired}
                            onCheckedChange={(checked) => patch({ gateMenuRequired: checked })}
                            aria-label="内嵌按钮门禁解锁"
                          />
                        </div>
                      </div>
                      <MenuDesignerFields
                        key={bot?.id ?? "new"}
                        config={menu}
                        onChange={setMenu}
                        isTgApi={false}
                        tgapiActionSource="legacy"
                        builtinCommands={builtinCommands}
                        customCommands={customCommands}
                        verificationMethods={verificationOptions}
                        storageKind="local"
                        botName={botDisplayName}
                        botUsername={bot?.username ?? null}
                        hideSimulator
                      />
                    </div>
                  ) : null}

                  {/* 平铺：自定义键盘配置（载荷 → 仿真屏底部 ReplyKeyboard 实时同步） */}
                  {keyboardOn ? (
                    <div className="space-y-2 rounded-xl border border-sky-500/30 bg-muted/10 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">⌨️ 自定义键盘配置（右侧仿真屏底部实时预览）</p>
                        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                          <span className="text-xs font-medium">🔒 门禁解锁（本面板全部按钮点击先验证）</span>
                          <Switch
                            checked={feature.gateKeyboardRequired}
                            onCheckedChange={(checked) => patch({ gateKeyboardRequired: checked })}
                            aria-label="自定义键盘门禁解锁"
                          />
                        </div>
                      </div>
                      {bot ? (
                        <CustomKeyboardDesigner
                          key={`kb-${bot.id}`}
                          botId={String(bot.id)}
                          botName={botDisplayName}
                          initialConfig={cfg.customKeyboard ?? null}
                          isTgApi={false}
                          embedded
                          builtinCommands={builtinCommands}
                          customCommands={customCommands}
                          verificationMethods={verificationOptions}
                          onConfigChange={handleKbConfigChange}
                        />
                      ) : (
                        <p className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                          ⌨️ 自定义键盘：先保存机器人（填写名称与 Token 后点「保存机器人」），再次打开本弹窗即可配置。
                        </p>
                      )}
                    </div>
                  ) : null}

                  {/* 平铺：指令菜单配置 */}
                  {feature.commandsEnabled ? (
                    <div className="space-y-2 rounded-xl border border-emerald-500/30 bg-muted/10 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">📋 指令菜单配置（指令注册唯一来源，部署后同步 Telegram）</p>
                        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                          <span className="text-xs font-medium">🔒 门禁解锁（使用指令前先验证）</span>
                          <Switch
                            checked={feature.gateCommandsRequired}
                            onCheckedChange={(checked) => patch({ gateCommandsRequired: checked })}
                            aria-label="指令菜单门禁解锁"
                          />
                        </div>
                      </div>
                      <CommandMenuConfigFields
                        privacyMode={privacyMode}
                        onPrivacyModeChange={setPrivacyMode}
                        selected={selectedCommandIds}
                        onToggle={(id) =>
                          setSelectedCommandIds((prev) =>
                            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
                          )
                        }
                        library={library}
                      />
                    </div>
                  ) : null}
                </div>

                {/* 🧭 真实群组 */}
                <div id="groups-config" className="scroll-mt-16 rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">🧭 机器人所在真实群组</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSimNodeId("root");
                        sim.resetSimChat();
                      }}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/20"
                      title="右侧仿真屏恢复到申请加群的初始状态"
                    >
                      📲 申请加群
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仿真屏群名为机器人已部署的真实群组（下方面板数据）；点「申请加群」恢复申请加群初始状态 ——
                    点击「申请加入群组」后机器人自动通过（真实端 chat_join_request 自动审批）并跳转私聊。
                  </p>
                  <div className="mt-2">
                    {bot ? (
                      <TgApiBotGroupsPanel botId={String(bot.id)} />
                    ) : (
                      <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        🧭 机器人所在真实群组：保存后再次打开本弹窗即可查看与同步（真实调用 Bot API 发现）。
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* —— 右侧仿真屏（固定容器，数据驱动）：配置 state → props 即时呈现 —— */}
              <div className={`min-w-0 lg:sticky lg:top-0 lg:self-start ${mobilePane === "preview" ? "block" : "hidden"} lg:block`}>
                <div key={sim.resetKey}>
                  <TgSimulator
                    ref={simRef}
                    config={simulatorConfig}
                    botName={botDisplayName}
                    startWelcomeText={welcomeText}
                    groupTitle={realGroupTitle}
                    memberCount={realGroups.groups.length > 0 ? "已部署的真实群组" : ""}
                    nodeId={simNodeId}
                    onNodeNavigate={setSimNodeId}
                    systemNote={
                      sim.simView === "group"
                        ? "仿真群组 · 点击下方「申请加入群组」开始仿真"
                        : inlineOn || keyboardOn
                          ? undefined
                          : "未开启消息内嵌按钮 / 自定义键盘：机器人 /start 仅回复纯文本欢迎语"
                    }
                    view={sim.simView}
                    joinPhase={sim.joinPhase}
                    onRequestJoin={sim.requestJoin}
                    showMenuInPrivate={inlineOn}
                    replyKeyboard={keyboardOn ? currentKb : undefined}
                    onReplyButtonClick={handleSimReplyClick}
                    commands={feature.commandsEnabled ? configuredCommands : undefined}
                  />
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    仿真屏为配置实时预览：
                    {inlineOn ? `内嵌按钮 ${menuStats.buttons} 个 · ${menuStats.submenus} 个子菜单` : "内嵌按钮未开启"}
                    {inlineOn && keyboardOn ? "；" : keyboardOn ? "；" : ""}
                    {keyboardOn ? `自定义键盘 ${keyboardButtonCount} 个按钮（私聊输入框下方）` : "自定义键盘未开启"}
                    。开关只切换生效配置，仿真屏随之更新；保存并到「仿真APP」部署后对真实用户生效。
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              取消
            </button>
            <SubmitButton
              className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              pendingLabel="保存中…"
            >
              保存机器人
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
