"use client";

import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { TgapiProxyConfigSection } from "@/components/admin/tgapi-proxy-config-section";
import { ListTree } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  TgSimulator,
  type TgSimulatorHandle,
} from "@/components/admin/tg-simulator";
import {
  NodeEditor,
  uid,
  type DesignerState,
} from "@/components/admin/menu-designer-editor";
import { TgApiBotGroupsPanel } from "@/components/admin/tgapi-bot-groups-panel";
import { useRealGroups } from "@/components/admin/use-real-groups";
import { parseBotFeatureConfig } from "@/services/bot-feature-config";
import {
  countMenuStats,
  defaultTgApiMenuRoot,
  isValidTgApiPlatformValue,
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_DEPTH,
  parseBotMenuConfig,
  renderMenuTemplate,
  TGAPI_PLATFORM_LABELS,
  type BotMenuConfig,
  type MenuButton,
  type MenuButtonAction,
  type MenuNode,
  type MenuRow,
} from "@/services/menu-config";
import {
  TGAPI_APP_PLATFORMS,
  TGAPI_TEXT_FIELD_KEYS,
  TGAPI_TEXTS_EN,
  TGAPI_TEXTS_ZH,
  tgApiInterfaceMode,
} from "@/services/tgapi-config";
import type { CustomKeyboardConfig } from "@/services/custom-keyboard";
import { emptyKeyboardOptions } from "@/components/admin/custom-keyboard-editor";
import { CustomKeyboardDesigner } from "@/components/admin/custom-keyboard-dialog";
import { TgApiGatePanel } from "@/components/admin/tgapi-gate-panel";
import { SubmitButton } from "@/components/admin/submit-button";
import { Switch } from "@/components/ui/switch";
import {
  CommandMenuConfigFields,
  type CommandLibraryItem,
} from "@/app/admin/bots/command-menu-dialog";
import { saveTgApiBotAction } from "./actions";
import {
  DesignerBasicInfo,
  parseDesignerProfile,
  parseDesignerTgApiCfg,
  type DesignerBotInfo,
} from "./bot-designer-shared";
import { useDesignerSimChat } from "./use-designer-sim-chat";

/**
 * TGAPI 申请机器人「菜单和键盘」统一弹窗（v2.3 重构：独立组件，仅 TGAPI 全模块形态）：
 *
 * 数据驱动模型（单一事实源）：
 * - 左侧 = 配置状态（menuRoot 按钮树 / zhStart+enStart 双语文案 / customKeyboard 载荷 /
 *   指令勾选 / APP 参数），全部为弹窗 state；
 * - 右侧 = 固定仿真屏容器（TgSimulator），配置经 props 实时呈现 —— 「界面模式」checkbox
 *   只切换左侧编辑区与生效配置，仿真屏随配置即时渲染，不改容器。
 * - 会话状态（视图 / 加群阶段 / TGAPI 对话流程）由 useDesignerSimChat 维护。
 *
 * 模块：1️⃣基本信息 / 2️⃣真实群组 / 3️⃣my.telegram.org APP 创建参数 / 🔐解锁门禁 /
 * 4️⃣消息配置（双语）/ 🧩功能开关（消息内嵌按钮 ⇄ 自定义键盘互斥 + 指令菜单，平铺模块，
 * 与机器人管理「功能配置」弹窗同一模型）。
 * 保存走 saveTgApiBotAction；上线/更新运行实例在「仿真APP」页部署。
 */

function newRow(counter: { current: number }, buttons: MenuButton[]): MenuRow {
  return { id: uid("row", counter), buttons };
}

export function TgApiMenuKeyboardDialog({
  bot,
  methods,
  library,
  defaultOpen = false,
  defaultTab = "inline",
  trigger,
  triggerClassName,
}: {
  bot?: DesignerBotInfo;
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  /** 指令库（SSR 按当前机器人过滤后的可见指令：内置 + 全局/群组/本机器人自定义） */
  library: CommandLibraryItem[];
  /** URL ?edit=1 时自动打开 */
  defaultOpen?: boolean;
  /** 打开时的编辑区：inline=消息内嵌按钮 / keyboard=自定义键盘（默认按生效模式） */
  defaultTab?: "inline" | "keyboard";
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const cfg = useMemo(() => parseDesignerTgApiCfg(bot), [bot]);
  const profile = useMemo(() => parseDesignerProfile(bot), [bot]);
  const suffix = bot ? String(bot.id) : "new";
  const selectedPlatforms = useMemo(() => new Set(cfg.appPlatforms), [cfg.appPlatforms]);
  const botDisplayName = bot?.username ? `@${bot.username}` : bot?.name ?? "TGAPI申请机器人";
  const activeMode = tgApiInterfaceMode(cfg);

  // —— 🧩 功能开关（与机器人管理「功能配置」弹窗同一模型）：互斥 check 可全关 +
  //     指令菜单独立勾选 + 各面板门禁解锁开关；每次打开按最新已保存数据重置 ——
  const readUiDraft = (
    botInfo?: DesignerBotInfo,
  ): {
    uiMode: "inline" | "keyboard" | "none";
    commandsEnabled: boolean;
    gateMenuRequired: boolean;
    gateKeyboardRequired: boolean;
    gateCommandsRequired: boolean;
  } => {
    if (!botInfo) {
      return { uiMode: "inline", commandsEnabled: false, gateMenuRequired: false, gateKeyboardRequired: false, gateCommandsRequired: false };
    }
    const feature = parseBotFeatureConfig(botInfo.config, false);
    return {
      uiMode: feature.keyboard.enabled ? "keyboard" : feature.menu.enabled ? "inline" : "none",
      commandsEnabled: feature.commands.enabled,
      gateMenuRequired: feature.gateMenuRequired === true,
      gateKeyboardRequired: feature.gateKeyboardRequired === true,
      gateCommandsRequired: feature.gateCommandsRequired === true,
    };
  };
  const initialUi = readUiDraft(bot);
  const [uiMode, setUiMode] = useState<"inline" | "keyboard" | "none">(initialUi.uiMode);
  const [commandsEnabled, setCommandsEnabled] = useState(initialUi.commandsEnabled);
  const [gateMenuRequired, setGateMenuRequired] = useState(initialUi.gateMenuRequired);
  const [gateKeyboardRequired, setGateKeyboardRequired] = useState(initialUi.gateKeyboardRequired);
  const [gateCommandsRequired, setGateCommandsRequired] = useState(initialUi.gateCommandsRequired);
  // 3️⃣ APP 创建参数 / 4️⃣ 消息配置 可折叠(默认收起, 参考 TGAPI代理模块)
  const [appParamsOpen, setAppParamsOpen] = useState(false);
  const [msgConfigOpen, setMsgConfigOpen] = useState(false);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
    if (open) {
      const draft = readUiDraft(bot);
      setUiMode(draft.uiMode);
      setCommandsEnabled(draft.commandsEnabled);
      setGateMenuRequired(draft.gateMenuRequired);
      setGateKeyboardRequired(draft.gateKeyboardRequired);
      setGateCommandsRequired(draft.gateCommandsRequired);
    }
  }, [defaultOpen, open, bot]);

  // —— 自定义键盘载荷（编辑器 onConfigChange 同步；初始值 = 已保存配置） ——
  const [kbPayload, setKbPayload] = useState<string>(() =>
    cfg.customKeyboard ? JSON.stringify(cfg.customKeyboard) : "",
  );
  const handleKbConfigChange = useCallback((config: CustomKeyboardConfig): void => {
    // CustomKeyboardDesigner 在 render 中回调 onConfigChange（React 受控同步），
    // 直接 setState 会触发「render 期间更新其他组件」告警 —— 延迟到微任务执行
    queueMicrotask(() => {
      setKbPayload(config.root.rows.length === 0 ? "" : JSON.stringify(config));
    });
  }, []);
  const currentKb = useMemo<CustomKeyboardConfig>(() => {
    if (!kbPayload) return { options: emptyKeyboardOptions(), root: { rows: [] } };
    try {
      return JSON.parse(kbPayload) as CustomKeyboardConfig;
    } catch {
      return { options: emptyKeyboardOptions(), root: { rows: [] } };
    }
  }, [kbPayload]);

  // —— 指令菜单配置（隐私模式 + 指令勾选） ——
  const [privacyMode, setPrivacyMode] = useState(profile.privacyMode);
  const [selectedCommandIds, setSelectedCommandIds] = useState<number[]>(profile.commandIds);
  useEffect(() => {
    if (open) {
      setPrivacyMode(profile.privacyMode);
      setSelectedCommandIds(profile.commandIds);
    }
  }, [open, profile]);

  // —— 内嵌按钮配置状态（按钮树 + 双语欢迎语；配置 → 仿真屏实时呈现） ——
  const [zhStart, setZhStart] = useState(cfg.texts?.zh?.start?.trim() || TGAPI_TEXTS_ZH.start);
  const [enStart, setEnStart] = useState(cfg.texts?.en?.start?.trim() || TGAPI_TEXTS_EN.start);
  const counter = useRef(0);
  const [menuRoot, setMenuRoot] = useState<MenuNode>(() => {
    if (bot) {
      const parsed = parseBotMenuConfig(bot.menuConfig);
      if (parsed.root.rows.length > 0) return parsed.root;
    }
    return defaultTgApiMenuRoot();
  });
  const [selected, setSelected] = useState<{ path: string[]; buttonId: string } | null>(null);

  const mutateRoot = (mutator: (draft: MenuNode) => void): void => {
    setMenuRoot((prev) => {
      const draft: MenuNode = JSON.parse(JSON.stringify(prev));
      mutator(draft);
      return draft;
    });
  };

  /** 按 path 深定位节点后修改（path = 按钮 id 链，[] = 根节点） */
  const mutateAt = (path: string[], mutator: (node: MenuNode) => void): void => {
    mutateRoot((draft) => {
      let node: MenuNode = draft;
      for (const id of path) {
        let next: MenuButton | null = null;
        for (const row of node.rows) {
          const found = row.buttons.find((b) => b.id === id);
          if (found) {
            next = found;
            break;
          }
        }
        if (!next?.submenu) return;
        node = next.submenu;
      }
      mutator(node);
    });
  };

  const updateButtonAt = (
    path: string[],
    buttonId: string,
    mutator: (draft: MenuButton) => void,
  ): void => {
    mutateAt(path, (node) => {
      for (const row of node.rows) {
        const found = row.buttons.find((b) => b.id === buttonId);
        if (found) {
          mutator(found);
          return;
        }
      }
    });
  };

  // —— 按钮树操作（与机器人管理弹窗同一语义，path 版本支持子菜单树） ——
  const updateSelected = (mutator: (draft: MenuButton) => void): void => {
    if (!selected) return;
    updateButtonAt(selected.path, selected.buttonId, mutator);
  };

  const addRow = (path: string[]): void => {
    mutateAt(path, (node) => {
      if (node.rows.length >= 20) return;
      node.rows.push(newRow(counter, []));
    });
  };

  const addButton = (path: string[], rowId: string): void => {
    const id = uid("btn", counter);
    mutateAt(path, (node) => {
      for (const row of node.rows) {
        if (row.id !== rowId) continue;
        if (row.buttons.length >= MENU_MAX_BUTTONS_PER_ROW) return;
        row.buttons.push({
          id,
          text: `按钮 ${row.buttons.length + 1}`,
          action: { type: "tgapi_func", tgapi_func: "start", tgapi_unlock: false },
        });
        break;
      }
    });
    setSelected({ path, buttonId: id });
  };

  const deleteButton = (path: string[], buttonId: string): void => {
    mutateAt(path, (node) => {
      for (const row of node.rows) {
        row.buttons = row.buttons.filter((item) => item.id !== buttonId);
      }
      node.rows = node.rows.filter((row) => row.buttons.length > 0);
    });
    setSelected(null);
  };

  const moveRow = (path: string[], rowIndex: number, direction: -1 | 1): void => {
    mutateAt(path, (node) => {
      const target = rowIndex + direction;
      if (target < 0 || target >= node.rows.length) return;
      const [row] = node.rows.splice(rowIndex, 1);
      node.rows.splice(target, 0, row);
    });
  };

  const deleteRow = (path: string[], rowId: string): void => {
    mutateAt(path, (node) => {
      node.rows = node.rows.filter((row) => row.id !== rowId);
    });
    setSelected(null);
  };

  const createSubmenu = (path: string[], buttonId: string): void => {
    updateButtonAt(path, buttonId, (draft) => {
      if (path.length + 1 >= MENU_MAX_DEPTH) return;
      draft.action = { type: "submenu" };
      draft.submenu = { rows: [] };
    });
  };

  const deleteSubmenu = (path: string[], buttonId: string): void => {
    updateButtonAt(path, buttonId, (draft) => {
      draft.action = { type: "tgapi_func", tgapi_func: "start", tgapi_unlock: false };
      draft.submenu = undefined;
    });
    setSelected(null);
  };

  /** 交互类型变更：TGAPI 指令为复合值（tgapi_func:<func>），其余与机器人管理弹窗同语义 */
  const changeActionType = (path: string[], buttonId: string, value: string): void => {
    const [type, func] = value.split(":");
    if (type === "tgapi_func") {
      updateButtonAt(path, buttonId, (draft) => {
        // TGAPI 功能项之间切换：保留按钮已配置的门禁开关与消息槽位（重建会清掉管理员配置）
        const isSameType = draft.action.type === "tgapi_func";
        const next: MenuButtonAction = {
          type: "tgapi_func",
          tgapi_func: func ?? "start",
          tgapi_unlock: isSameType ? draft.action.tgapi_unlock : true,
        };
        if (isSameType && draft.action.tgapi_value) next.tgapi_value = draft.action.tgapi_value;
        if (isSameType) {
          if (draft.action.tgapi_response) next.tgapi_response = draft.action.tgapi_response;
          if (draft.action.tgapi_success) next.tgapi_success = draft.action.tgapi_success;
          if (draft.action.tgapi_fail) next.tgapi_fail = draft.action.tgapi_fail;
        }
        draft.action = next;
        draft.submenu = undefined;
      });
      return;
    }
    updateButtonAt(path, buttonId, (draft) => {
      if (type === "submenu") {
        draft.action = { type: "submenu" };
      } else if (type === "back") {
        draft.action = { type: "back" };
      } else if (type === "language") {
        draft.action = { type: "language" };
      } else if (type === "reply") {
        draft.action = { type: "reply", text: "你好！", content: { type: "text", text: "你好！", mediaUrl: "", items: [] } };
      } else if (type === "url") {
        draft.action = { type: "url", url: "https://" };
      } else {
        draft.action = { type: "reply", text: "" };
      }
      if (type !== "submenu") draft.submenu = undefined;
    });
  };

  // —— 仿真屏（固定容器；会话状态在 Hook，配置状态在此处 props 下发） ——
  const simRef = useRef<TgSimulatorHandle>(null);
  const sim = useDesignerSimChat({ simRef, cfg });
  const [simNodeId, setSimNodeId] = useState("root");
  const realGroups = useRealGroups({
    botId: bot ? String(bot.id) : null,
    enabled: open && Boolean(bot),
  });
  const realGroupTitle = realGroups.groups[0]?.chatTitle?.trim() || "My Telegram API";

  /** 当前仿真语言的初始消息文案（配置 → 仿真屏实时同步） */
  const langStartText = sim.simLang === "zh" ? zhStart : enStart;
  const simulatorConfig = useMemo<BotMenuConfig>(
    () => ({
      content: { type: "text", text: langStartText, mediaUrl: "", items: [] },
      root: menuRoot,
    }),
    [langStartText, menuRoot],
  );
  const stats = countMenuStats(menuRoot);

  // 指令菜单数据驱动：已勾选指令 → 仿真屏输入区「菜单」按钮 + 指令滑屏
  const configuredCommands = useMemo(
    () =>
      library
        .filter((item) => selectedCommandIds.map(String).includes(item.id))
        .map((item) => ({ name: item.name, description: item.description })),
    [library, selectedCommandIds],
  );

  const designerState: DesignerState = {
    config: simulatorConfig,
    selected,
    storageKind: "local",
    isTgApi: true,
    tgapiActionSource: "designer",
    builtinCommands: [],
    customCommands: [],
    verificationMethods: [],
    actions: {
      selectButton: (path, buttonId) => setSelected({ path, buttonId }),
      addRow,
      addButton,
      deleteButton,
      moveRow,
      deleteRow,
      updateButton: updateButtonAt,
      createSubmenu,
      deleteSubmenu,
      changeActionType,
      enterSubmenu: (buttonId) => setSimNodeId(buttonId),
    },
  };

  const menuConfigPayload = useMemo(
    () =>
      JSON.stringify({
        tgapiDesigner: true,
        content: { type: "text", text: zhStart, mediaUrl: "", items: [] },
        root: menuRoot,
      }),
    [zhStart, menuRoot],
  );

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
            菜单和键盘 · {bot ? bot.name : "新增 TGAPI 申请机器人"}
          </DialogTitle>
          <DialogDescription>
            通用配置（基本信息 / 机器人所在真实群组 / my.telegram.org APP 创建参数 / 门禁 / 消息 / 指令菜单）为内嵌按钮与自定义键盘共用；
            「界面模式」checkbox 单选仅切换左侧编辑区，勾选并保存（部署）后才对运行实例生效；右侧仿真屏随配置实时预览（数据驱动）。
            保存仅落库配置；上线/更新运行实例请到「仿真APP」页面部署。
          </DialogDescription>
        </DialogHeader>
        <form action={saveTgApiBotAction} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="id" value={bot ? String(bot.id) : ""} />
          <input type="hidden" name="menu_config" value={menuConfigPayload} />
          <input type="hidden" name="kb_mode" value={uiMode === "none" ? "" : uiMode} />
          <input type="hidden" name="menu_enabled" value={uiMode === "inline" ? "1" : "0"} />
          <input type="hidden" name="keyboard_enabled" value={uiMode === "keyboard" ? "1" : "0"} />
          <input type="hidden" name="commands_enabled" value={commandsEnabled ? "1" : "0"} />
          <input type="hidden" name="gate_menu_required" value={gateMenuRequired ? "1" : "0"} />
          <input type="hidden" name="gate_keyboard_required" value={gateKeyboardRequired ? "1" : "0"} />
          <input type="hidden" name="gate_commands_required" value={gateCommandsRequired ? "1" : "0"} />
          <input type="hidden" name="custom_keyboard" value={kbPayload} />
          <input type="hidden" name="privacyMode" value={privacyMode ? "1" : "0"} />
          <input type="hidden" name="commandIds" value={JSON.stringify(selectedCommandIds)} />

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
            <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
              {/* —— 左侧配置区 —— */}
              <div className="min-w-0 space-y-4">
                <DesignerBasicInfo bot={bot} suffix={suffix} defaultName="TGAPI申请机器人" />

                {/* 2️⃣ 真实群组 + 申请加群按钮 */}
                <div className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">2️⃣ 🧭 机器人所在真实群组</p>
                    <button
                      type="button"
                      onClick={sim.resetSimChat}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/20"
                      title="右侧仿真屏恢复到申请加群的初始状态（群组界面 + 底部「申请加入群组」按钮）"
                    >
                      📲 申请加群
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仿真屏群名为机器人已部署的真实群组（下方面板数据）；点「申请加群」恢复申请加群初始状态 ——
                    点击「申请加入群组」后机器人自动通过（真实端 chat_join_request 自动审批）并跳转私聊，全流程与真实 APP 一致。
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

                {/* TGAPI代理模块(TGAPI申请机器人专用, 在 APP 创建参数前) */}
                <TgapiProxyConfigSection />

                {/* 3️⃣ my.telegram.org APP 创建参数（可折叠, 默认收起） */}
                <div className="rounded-lg border bg-muted/20">
                  <button
                    type="button"
                    onClick={() => setAppParamsOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left"
                  >
                    <span className="text-sm font-semibold">3️⃣ 📱 my.telegram.org APP 创建参数</span>
                    <span className="text-xs text-muted-foreground">{appParamsOpen ? "收起 ▲" : "展开 ▼"}</span>
                  </button>
                  {appParamsOpen ? (
                    <div className="space-y-4 px-4 pb-4">
                      <p className="text-xs text-muted-foreground">
                        创建 API 直接手机号 → 登录码（不再对话中收集）；APP 名称/描述可用键盘
                        「✏️ 设置Title / 📝 设置Description」预配置（未配置时使用下方默认值），
                        平台未预配置时随机选一。
                      </p>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-sm font-medium" htmlFor={`app-title-${suffix}`}>
                            APP_TITLE（默认值）
                          </label>
                          <input
                            id={`app-title-${suffix}`}
                            name="app_title"
                            defaultValue={cfg.appTitle}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium" htmlFor={`app-short-name-${suffix}`}>
                            APP_SHORT_NAME
                          </label>
                          <input
                            id={`app-short-name-${suffix}`}
                            name="app_short_name"
                            defaultValue={cfg.appShortName}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium" htmlFor={`app-url-${suffix}`}>
                            APP_URL
                          </label>
                          <input
                            id={`app-url-${suffix}`}
                            name="app_url"
                            defaultValue={cfg.appUrl}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium" htmlFor={`footer-${suffix}`}>
                            页脚署名（FTEXT）
                          </label>
                          <input
                            id={`footer-${suffix}`}
                            name="footer_text"
                            defaultValue={cfg.footerText}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor={`app-desc-${suffix}`}>
                          APP_DESCRIPTION（默认值）
                        </label>
                        <textarea
                          id={`app-desc-${suffix}`}
                          name="app_description"
                          rows={2}
                          defaultValue={cfg.appDescription}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">
                          APP_PLATFORM（创建时随机选一，对应原 random.choice）
                        </p>
                        <div className="flex flex-wrap gap-3">
                          {TGAPI_APP_PLATFORMS.map((platform) => (
                            <label key={platform} className="inline-flex items-center gap-1.5 text-sm">
                              <input
                                type="checkbox"
                                name="app_platforms"
                                value={platform}
                                defaultChecked={selectedPlatforms.has(platform)}
                                className="h-4 w-4"
                              />
                              {TGAPI_PLATFORM_LABELS[platform] ?? platform}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : <></>
                  }
                </div>

                {/* 🔐 解锁门禁全局配置（通用组件：unlock_mode 恒 captcha + verification_method_id 随表单提交） */}
                <TgApiGatePanel
                  idScope={`gate-${suffix}`}
                  methods={methods}
                  verificationMethodId={cfg.verificationMethodId}
                />

                {/* 4️⃣ 消息配置（中英双语；当前仿真语言文案实时同步仿真屏）可折叠, 默认收起 */}
                <div className="rounded-lg border bg-muted/20">
                  <button
                    type="button"
                    onClick={() => setMsgConfigOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left"
                  >
                    <span className="text-sm font-semibold">4️⃣ 💬 消息配置（中英文双语：按用户语言自动识别，「✅ 语言」按钮可手动切换）</span>
                    <span className="text-xs text-muted-foreground">{msgConfigOpen ? "收起 ▲" : "展开 ▼"}</span>
                  </button>
                  {msgConfigOpen ? (
                    <div className="space-y-3 px-4 pb-4">
                  <div className="space-y-1">
                    <label className="text-sm font-medium" htmlFor={`text-zh-start-${suffix}`}>
                      中文欢迎语（START_TEXT · 初始消息正文，右侧仿真屏实时预览）
                    </label>
                    <textarea
                      id={`text-zh-start-${suffix}`}
                      name="text_zh_start"
                      rows={4}
                      value={zhStart}
                      onChange={(event) => setZhStart(event.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium" htmlFor={`text-en-start-${suffix}`}>
                      English 欢迎语（START_TEXT · 初始消息正文）
                    </label>
                    <textarea
                      id={`text-en-start-${suffix}`}
                      name="text_en_start"
                      rows={4}
                      value={enStart}
                      onChange={(event) => setEnStart(event.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  {TGAPI_TEXT_FIELD_KEYS.filter((field) => field.name !== "start").map((field) => (
                    <div key={field.name} className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor={`text-zh-${field.name}-${suffix}`}>
                          中文 · {field.label}
                        </label>
                        <textarea
                          id={`text-zh-${field.name}-${suffix}`}
                          name={`text_zh_${field.name}`}
                          rows={2}
                          defaultValue={cfg.texts?.zh?.[field.name] ?? TGAPI_TEXTS_ZH[field.name]}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor={`text-en-${field.name}-${suffix}`}>
                          English · {field.label}
                        </label>
                        <textarea
                          id={`text-en-${field.name}-${suffix}`}
                          name={`text_en_${field.name}`}
                          rows={2}
                          defaultValue={cfg.texts?.en?.[field.name] ?? TGAPI_TEXTS_EN[field.name]}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                        />
                      </div>
                    </div>
                  ))}
                  </div>
                  ) : <></>}
                </div>

                {/* 🧩 功能开关（显式开启才生效）：消息内嵌按钮 ⇄ 自定义键盘互斥 + 指令菜单独立；
                    平铺配置模块 —— 与机器人管理「功能配置」弹窗同一模型（复用，无割裂模块） */}
                <div className="space-y-3 rounded-xl border bg-card p-4">
                  <div>
                    <p className="text-sm font-semibold">🧩 功能开关（显式开启才生效）</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      消息内嵌按钮与自定义键盘互斥（check 单选，可都取消）；指令菜单独立勾选。
                      关闭后配置保留不清空，重新开启原样回显；右侧仿真屏随开关实时响应。
                    </p>
                  </div>
                  <div className="grid gap-2 md:grid-cols-3">
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        uiMode === "inline" ? "border-primary/50 bg-primary/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={uiMode === "inline"}
                        onChange={() => setUiMode(uiMode === "inline" ? "none" : "inline")}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">💬 消息内嵌按钮
                          {activeMode === "inline" ? <span className="ml-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">生效中</span> : null}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">初始消息底部 InlineKeyboard</span>
                      </span>
                    </label>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        uiMode === "keyboard" ? "border-sky-500/50 bg-sky-500/5" : ""
                      } ${!bot ? "opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={uiMode === "keyboard"}
                        onChange={() => setUiMode(uiMode === "keyboard" ? "none" : "keyboard")}
                        disabled={!bot}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">⌨️ 自定义键盘
                          {activeMode === "keyboard" ? <span className="ml-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">生效中</span> : null}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">ReplyKeyboard 对话流程{!bot ? "（先保存机器人）" : ""}</span>
                      </span>
                    </label>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
                        commandsEnabled ? "border-emerald-500/50 bg-emerald-500/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={commandsEnabled}
                        onChange={(event) => setCommandsEnabled(event.target.checked)}
                        className="h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">📋 指令菜单</span>
                        <span className="block text-[11px] text-muted-foreground">独立勾选，可与上面共存</span>
                      </span>
                    </label>
                  </div>

                    {/* —— 平铺：消息内嵌按钮配置（TGAPI 固定指令 + 通用项；配置 → 仿真屏实时同步） —— */}
                    {uiMode === "inline" ? (
                      <div className="space-y-2 rounded-xl border border-primary/30 bg-muted/10 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold">🔘 内嵌按钮配置（初始消息底部 InlineKeyboard，右侧仿真屏实时预览）</p>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setMenuRoot(defaultTgApiMenuRoot());
                                setSelected(null);
                                setSimNodeId("root");
                              }}
                              className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-sm hover:bg-accent"
                              title="重新生成默认按钮组：9 个按钮（创建API/我的API/设置平台/语言/帮助/客服支持/设置Title/设置Description/跳过），设置平台含 8 平台子菜单"
                            >
                              ↺ 恢复默认按钮组
                            </button>
                            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                              <span className="text-xs font-medium">🔒 门禁解锁（本面板全部按钮点击先验证）</span>
                              <Switch
                                checked={gateMenuRequired}
                                onCheckedChange={setGateMenuRequired}
                                aria-label="内嵌按钮门禁解锁"
                              />
                            </div>
                          </div>
                        </div>
                        <NodeEditor
                          node={menuRoot}
                          levelName={
                            <>
                              主菜单按钮布局
                              <span className="text-sm font-normal text-muted-foreground">
                                （每行最多 {MENU_MAX_BUTTONS_PER_ROW} 个按钮，最多 {MENU_MAX_DEPTH} 层）
                              </span>
                            </>
                          }
                          path={[]}
                          depth={1}
                          state={designerState}
                          isRoot
                        />
                        {!selected ? (
                          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                            点击任意按钮可配置名称、交互（TGAPI 指令列表）、解锁门禁与指令消息；选择「进入子菜单」后可直接创建下一级菜单
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {/* —— 平铺：自定义键盘配置（TGAPI 对话流程；载荷 → 仿真屏底部 ReplyKeyboard 实时同步） —— */}
                    {uiMode === "keyboard" ? (
                      <div className="space-y-2 rounded-xl border border-sky-500/30 bg-muted/10 p-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">⌨️ 自定义键盘配置（点击按钮=发送按钮文本，对话流程真实响应；右侧仿真屏底部实时预览）</p>
                          <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                            <span className="text-xs font-medium">🔒 门禁解锁（本面板全部按钮点击先验证）</span>
                            <Switch
                              checked={gateKeyboardRequired}
                              onCheckedChange={setGateKeyboardRequired}
                              aria-label="自定义键盘门禁解锁"
                            />
                          </div>
                        </div>
                        {bot ? (
                          <CustomKeyboardDesigner
                            botId={String(bot.id)}
                            botName={botDisplayName}
                            initialConfig={cfg.customKeyboard ?? null}
                            isTgApi
                            embedded
                            onConfigChange={handleKbConfigChange}
                          />
                        ) : (
                          <p className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                            ⌨️ 自定义键盘：先保存机器人（填写名称与 Token 后点「保存机器人」），再次打开本弹窗即可配置。
                          </p>
                        )}
                      </div>
                    ) : null}

                    {/* —— 平铺：指令菜单配置 —— */}
                    {commandsEnabled ? (
                      <div className="space-y-2 rounded-xl border border-emerald-500/30 bg-muted/10 p-3">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">📋 指令菜单配置（指令注册唯一来源，部署后同步 Telegram；仿真屏输入框左侧「菜单」按钮）</p>
                          <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                            <span className="text-xs font-medium">🔒 门禁解锁（使用指令前先验证）</span>
                            <Switch
                              checked={gateCommandsRequired}
                              onCheckedChange={setGateCommandsRequired}
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

              </div>

              {/* —— 右侧仿真屏（固定容器，数据驱动）：配置 state → props 即时呈现 —— */}
              <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                <div key={sim.resetKey}>
                  <TgSimulator
                    ref={simRef}
                    config={simulatorConfig}
                    botName={botDisplayName}
                    groupTitle={realGroupTitle}
                    memberCount={realGroups.groups.length > 0 ? "已部署的真实群组" : ""}
                    nodeId={simNodeId}
                    onNodeNavigate={setSimNodeId}
                    view={sim.simView}
                    joinPhase={sim.joinPhase}
                    onRequestJoin={sim.requestJoin}
                    onUserSend={sim.onUserSend}
                    showMenuInPrivate={sim.simView === "private" && uiMode === "inline"}
                    replyKeyboard={uiMode === "keyboard" ? currentKb : undefined}
                    onTgApiFunc={sim.onTgApiFunc}
                    onLanguageToggle={sim.onLanguageToggle}
                    commands={commandsEnabled ? configuredCommands : undefined}
                    systemNote={
                      sim.simView === "group"
                        ? "TGAPI 申请群组 · 点击下方「申请加入群组」开始仿真"
                        : uiMode === "none"
                          ? "未开启消息内嵌按钮 / 自定义键盘：机器人 /start 仅回复纯文本欢迎语"
                          : undefined
                    }
                  />
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    仿真屏随功能开关实时响应：
                    {uiMode === "inline" ? `内嵌按钮 ${stats.buttons} 个 · ${stats.submenus} 个子菜单（初始消息随文案实时同步）` : "内嵌按钮未开启"}
                    {uiMode === "keyboard" ? "；自定义键盘面板在私聊输入框下方（⌨️ 展开）" : ""}
                    {uiMode === "none" ? "；界面模块全部关闭 → /start 纯文本欢迎" : ""}
                    。仿真流程与真实机器人完全一致：申请加入群组 → 自动通过并跳转私聊 → 创建API（解锁门禁 → 手机号 → 登录码）→ /start 重发。
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
