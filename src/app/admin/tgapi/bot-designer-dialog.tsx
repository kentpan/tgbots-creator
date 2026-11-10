"use client";

import { useEffect, useCallback, useMemo, useRef, useState } from "react";
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
import {
  countMenuStats,
  defaultTgApiMenuRoot,
  isTgApiDesignerConfig,
  isValidTgApiPlatformValue,
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_DEPTH,
  parseBotMenuConfig,
  renderMenuTemplate,
  TGAPI_PLATFORM_LABELS,
  type MenuButton,
  type MenuButtonAction,
  type MenuNode,
  type MenuRow,
} from "@/services/menu-config";
import {
  TGAPI_APP_PLATFORMS,
  TGAPI_DEFAULT_APP,
  TGAPI_TEXT_FIELD_KEYS,
  TGAPI_TEXTS_EN,
  TGAPI_TEXTS_ZH,
  tgApiInterfaceMode,
  type TgApiBotConfig,
} from "@/services/tgapi-config";
import {
  parseCustomKeyboardConfig,
  type CustomKeyboardConfig,
} from "@/services/custom-keyboard";
import { CustomKeyboardDesigner } from "@/components/admin/custom-keyboard-dialog";
import { TgApiGatePanel } from "@/components/admin/tgapi-gate-panel";
import { SubmitButton } from "@/components/admin/submit-button";
import { TgApiKeyboardFlowSim } from "@/components/admin/tgapi-keyboard-flow";
import { saveTgApiBotAction, saveTgApiCustomKeyboardAction } from "./actions";

/**
 * TGAPI 申请机器人「菜单和键盘」统一弹窗（v2.2.1）：
 *
 * - 自包含切换按钮组：内嵌按钮 ⇄ 自定义键盘（互斥模式一目了然，带「生效中」标记）；
 * - 🔘 内嵌按钮页签：与机器人管理页「消息内嵌按钮」弹窗完全同一实现
 *  （components/admin/menu-designer-editor.tsx 的 NodeEditor/SelectedButtonPanel，
 *   按钮文案/行编辑/子菜单树/交互下拉逐字一致），TGAPI 差异仅两处：
 *   ① 交互下拉前置 TGAPI 固定指令列表；② 选中指令按钮时显示「首次对话解锁门禁」
 *   开关与「指令消息配置」（发送消息/成功消息/失败消息，双语 {{变量}}）。
 * - ⌨️ 自定义键盘页签：CustomKeyboardDesigner（模块化通用组件）+
 *   TgApiKeyboardFlowSim 完整对话流程仿真（/start → 门禁 → 主键盘 →
 *   创建API（参数→手机号→登录码→结果）/ 我的API / 设置平台 / 语言 / 帮助 /
 *   客服支持 / 设置Title / 设置Description / 跳过，文案与分派与运行端同一来源）。
 * - 仿真屏：与机器人管理页完全同一 TgSimulator（Telegram 风格聊天界面、
 *   消息气泡、键盘逐像素一致）。
 * - 群组信息：仿真屏群名取机器人已部署的真实群组（useRealGroups，零假数据）；
 *   无真实群组时不显示成员数（绝不显示编造的数字）。
 *
 * 存量机器人：首次打开时按钮默认按图1生成（不迁移旧 menu_config 按钮文案，
 * menu_config 无 tgapiDesigner 标记即视为未迁移）；消息正文沿用其已自定义的欢迎语。
 */

function inputClassOf(): string {
  return "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
}

function uidGen(prefix: string, counter: { current: number }): string {
  return uid(prefix, counter);
}

function newRow(counter: { current: number }, buttons: MenuButton[]): MenuRow {
  return { id: uidGen("row", counter), buttons };
}

/** 仿真对话状态机（弹窗内仿真流程推进，与真实端 handlers/tgapi.ts 状态一一对应） */
interface SimFlowState {
  /** idle=未开始 / unlock=等待解锁验证码 / phone=手机号 / code=登录码 / prefTitle|prefDesc=设置Title|设置Description 偏好收集 */
  stage: "idle" | "unlock" | "phone" | "code" | "prefTitle" | "prefDesc";
  unlocked: boolean;
  /** 仿真中已记住的平台（设置平台按钮 tgapi_value 绑定；创建时优先使用） */
  platform?: string;
  phone?: string;
  /** 仿真中已创建的 API（我的API/已创建检测的数据源；demo 值明确标注仿真） */
  created: { phone: string; apiId: string; apiHash: string } | null;
  /** 当前按钮配置的结果消息模板（创建流程结束时渲染 success/fail 槽位） */
  pendingSuccess?: { zh: string; en: string };
  pendingFail?: { zh: string; en: string };
}

const SIM_DEMO_API = { apiId: "2049583", apiHash: "b6f1d4e2a9c8372f5d0e1a4b8c7d6e5f" };

export function TgApiMenuKeyboardDialog({
  bot,
  methods,
  defaultOpen = false,
  defaultTab = "inline",
  trigger,
  triggerClassName,
}: {
  bot?: {
    id: string;
    name: string;
    username: string | null;
    enabled: boolean;
    config: string;
    menuConfig: string;
  };
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  /** URL ?edit=1 时自动打开（历史「消息与按钮」跳转入口） */
  defaultOpen?: boolean;
  /** 打开时的页签：inline=消息内嵌按钮 / keyboard=自定义键盘（默认按生效模式） */
  defaultTab?: "inline" | "keyboard";
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  // 每次打开重置到宿主指定模式（新增机器人固定 inline）
  useEffect(() => {
    if (defaultOpen) {
      setOpen(true);
      setMode(defaultTab);
    }
  }, [defaultOpen, defaultTab]);
  const cfg: TgApiBotConfig = useMemo(
    () =>
      bot
        ? (() => {
            try {
              const parsed = JSON.parse(bot.config) as { tgapi?: unknown };
              const tgapi = (parsed.tgapi ?? {}) as Record<string, unknown>;
              return {
                enabled: tgapi.enabled === true,
                unlockMode: tgapi.unlockMode === "stars" ? ("stars" as const) : ("captcha" as const),
                verificationMethodId:
                  typeof tgapi.verificationMethodId === "number" ? tgapi.verificationMethodId : undefined,
                starsAmount: typeof tgapi.starsAmount === "number" ? tgapi.starsAmount : undefined,
                starsTitle: typeof tgapi.starsTitle === "string" ? tgapi.starsTitle : undefined,
                appTitle: typeof tgapi.appTitle === "string" && tgapi.appTitle ? tgapi.appTitle : TGAPI_DEFAULT_APP.appTitle,
                appShortName:
                  typeof tgapi.appShortName === "string" && tgapi.appShortName
                    ? tgapi.appShortName
                    : TGAPI_DEFAULT_APP.appShortName,
                appUrl:
                  typeof tgapi.appUrl === "string" && tgapi.appUrl ? tgapi.appUrl : TGAPI_DEFAULT_APP.appUrl,
                appPlatforms: Array.isArray(tgapi.appPlatforms)
                  ? (tgapi.appPlatforms as string[])
                  : [...TGAPI_DEFAULT_APP.appPlatforms],
                appDescription:
                  typeof tgapi.appDescription === "string" && tgapi.appDescription
                    ? tgapi.appDescription
                    : TGAPI_DEFAULT_APP.appDescription,
                footerText: typeof tgapi.footerText === "string" ? tgapi.footerText : TGAPI_DEFAULT_APP.footerText,
                texts:
                  typeof tgapi.texts === "object" && tgapi.texts !== null
                    ? (tgapi.texts as TgApiBotConfig["texts"])
                    : undefined,
                customKeyboard: parseCustomKeyboardConfig(tgapi.customKeyboard) ?? undefined,
                interfaceMode:
                  tgapi.interfaceMode === "inline" || tgapi.interfaceMode === "keyboard"
                    ? tgapi.interfaceMode
                    : undefined,
              } satisfies TgApiBotConfig;
            } catch {
              return { enabled: false, unlockMode: "captcha" as const, ...TGAPI_DEFAULT_APP };
            }
          })()
        : { enabled: false, unlockMode: "captcha" as const, ...TGAPI_DEFAULT_APP },
    [bot],
  );
  const suffix = bot ? String(bot.id) : "new";
  const selectedPlatforms = useMemo(() => new Set(cfg.appPlatforms), [cfg.appPlatforms]);

  // ---------------------------------------------------------------------------
  // v2.2.6 解耦：mode 仅切换「内嵌按钮配置 ⇄ 自定义键盘配置」两个编辑区（checkbox
  // 单选，勾选即切换编辑区草稿）；真正生效模式是 tgapi.interfaceMode（保存并部署后
  // 生效）——「生效中」标签按已保存数据（activeMode）打标，绝不随草稿切换。
  // ---------------------------------------------------------------------------
  const [mode, setMode] = useState<"inline" | "keyboard">(defaultTab);
  const activeMode = tgApiInterfaceMode(cfg);
  // 键盘编辑器当前载荷（onConfigChange 同步；初始值 = 已保存配置，未编辑过时原样回存）
  const [kbPayload, setKbPayload] = useState<string>(() =>
    cfg.customKeyboard ? JSON.stringify(cfg.customKeyboard) : "",
  );
  const handleKbConfigChange = useCallback((config: CustomKeyboardConfig): void => {
    setKbPayload(config.root.rows.length === 0 ? "" : JSON.stringify(config));
  }, []);

  // 消息配置（中英双语；当前仿真语言文案实时同步仿真屏）
  const [zhStart, setZhStart] = useState(
    cfg.texts?.zh?.start?.trim() || TGAPI_TEXTS_ZH.start,
  );
  const [enStart, setEnStart] = useState(
    cfg.texts?.en?.start?.trim() || TGAPI_TEXTS_EN.start,
  );

  // 内嵌按钮（存量未迁移按图1默认生成）
  const counter = useRef(0);
  const [menuRoot, setMenuRoot] = useState<MenuNode>(() => {
    if (bot && isTgApiDesignerConfig(bot.menuConfig)) {
      const parsed = parseBotMenuConfig(bot.menuConfig);
      if (parsed.root.rows.length > 0) return parsed.root;
    }
    return defaultTgApiMenuRoot();
  });
  const [selected, setSelected] = useState<{ path: string[]; buttonId: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);

  // ---------------------------------------------------------------------------
  // 仿真屏状态（TgSimulator 宿主驱动）
  // ---------------------------------------------------------------------------
  const simRef = useRef<TgSimulatorHandle>(null);
  const [simLang, setSimLang] = useState<"zh" | "en">("zh");
  const [simView, setSimView] = useState<"group" | "private">("group");
  const [joinPhase, setJoinPhase] = useState<"idle" | "awaiting_code" | "joined">("idle");
  // 键盘页签：对话流程仿真重置计数（重新从 /start 开始）
  const [kbSimKey, setKbSimKey] = useState(0);
  // 仿真屏当前预览的菜单节点（子菜单导航；与机器人管理弹窗同一交互）
  const [simNodeId, setSimNodeId] = useState("root");
  const simFlow = useRef<SimFlowState>({ stage: "idle", unlocked: false, created: null });
  // 机器人已部署的真实群组（弹窗打开时读取数据库登记，零 Telegram 请求）
  const realGroups = useRealGroups({ botId: bot ? String(bot.id) : null, enabled: open && Boolean(bot) });
  const realGroupTitle = realGroups.groups[0]?.chatTitle?.trim() || "My Telegram API";

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

  /** 当前仿真语言的初始消息文案 */
  const langStartText = simLang === "zh" ? zhStart : enStart;

  const simulatorConfig = useMemo(
    () => ({
      content: { type: "text" as const, text: langStartText, mediaUrl: "", items: [] },
      root: menuRoot,
    }),
    [langStartText, menuRoot],
  );

  // ---------------------------------------------------------------------------
  // 按钮树操作（与机器人管理弹窗同一语义，path 版本支持子菜单树）
  // ---------------------------------------------------------------------------

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
    const id = uidGen("btn", counter);
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

  const botDisplayName = bot?.username ? `@${bot.username}` : bot?.name ?? "TGAPI申请机器人";

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

  // ---------------------------------------------------------------------------
  // 仿真流程（与真实端 handlers/tgapi.ts 一一对应）
  // ---------------------------------------------------------------------------

  /** 双语槽位文案取值（优先当前语言，为空回落另一语言） */
  const slotText = (template: { zh: string; en: string } | undefined): string => {
    if (!template) return "";
    return (simLang === "zh" ? template.zh : template.en).trim() ||
      (simLang === "zh" ? template.en : template.zh).trim();
  };

  /** 开始创建流程（已解锁，v2.2.2 精简）：直接手机号（APP 参数用预配置或默认值，不再收集） */
  const startSimCreate = (): void => {
    const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
    simFlow.current.stage = "phone";
    simRef.current?.appendMessage("dm", { from: "bot", text: texts.askPhone });
  };

  /** 「申请加群」按钮：仿真屏恢复申请加群初始状态 */
  const handleResetSimulator = (): void => {
    setResetKey((prev) => prev + 1);
    setSimView("group");
    setJoinPhase("idle");
    setSimLang("zh");
    setSimNodeId("root");
    simFlow.current = { stage: "idle", unlocked: false, created: null };
    simRef.current?.clearStream("group");
    simRef.current?.clearStream("dm");
  };

  /** 点击「申请加入群组」：申请 → 自动通过（真实端 chat_join_request 自动 approve）→ 跳转私聊 */
  const handleSimRequestJoin = async (): Promise<{ ok: boolean; message: string }> => {
    simRef.current?.appendMessage("group", {
      from: "system",
      text: "📩 加入群组申请已发送（chat_join_request）",
    });
    window.setTimeout(() => {
      simRef.current?.appendMessage("group", {
        from: "system",
        text: "✅ 管理员（机器人）已自动通过你的申请",
      });
    }, 700);
    window.setTimeout(() => {
      setJoinPhase("joined");
      setSimView("private");
      simFlow.current.stage = "idle";
      window.setTimeout(() => {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text: "🤖 机器人已发送初始消息与内嵌按钮（见上方，随左侧配置实时同步）",
        });
      }, 350);
    }, 1400);
    return { ok: true, message: "" };
  };

  /** TGAPI 功能按钮点击（创建API/我的API/启动机器人）——真实端执行流程仿真 */
  const handleSimTgApiFunc = (button: MenuButton): void => {
    const action = button.action;
    if (action.type !== "tgapi_func") return;
    const func = action.tgapi_func ?? "start";
    const flow = simFlow.current;
    // 私聊会话外的点击（仿真中按钮都在私聊）与真实端一致按私聊处理
    const response = slotText(action.tgapi_response);
    if (response) {
      simRef.current?.appendMessage("dm", {
        from: "bot",
        text: renderMenuTemplate(response, {
          user_id: "777000",
          username: "preview_user",
          first_name: "预览",
          chat_id: "-1001998877661",
        }),
      });
    }
    if (func === "start") {
      // 重发新初始消息+内嵌按钮，旧消息和按钮过时失效（真实端：旧键盘移除 + 台账拦截）
      simRef.current?.clearStream("dm");
      simRef.current?.appendMessage("dm", {
        from: "system",
        text: "🔄 已重新发送初始消息：之前的消息与内嵌按钮已过时失效",
      });
      flow.stage = "idle";
      return;
    }
    if (func === "create") {
      // 1. 已创建检测（解锁门禁前）
      if (flow.created) {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text: "✅ 你的 api_id 和 api_hash 已创建，点击「🗂 我的 API」按钮查看。",
        });
        return;
      }
      // 2. 解锁门禁（每按钮可选；任意按钮通过后所有按钮不再需要验证）—— 唯一门禁提示
      if (action.tgapi_unlock === true && !flow.unlocked) {
        const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
        flow.stage = "unlock";
        flow.pendingSuccess = action.tgapi_success;
        flow.pendingFail = action.tgapi_fail;
        simRef.current?.appendMessage("dm", { from: "bot", text: texts.unlockPrompt });
        return;
      }
      // 3. 已解锁/未开启门禁 → 创建流程
      flow.pendingSuccess = action.tgapi_success;
      flow.pendingFail = action.tgapi_fail;
      startSimCreate();
      return;
    }
    if (func === "my") {
      if (!flow.created) {
        const failText = slotText(action.tgapi_fail) ||
          (simLang === "zh"
            ? "💎 你还没有创建 API。\n\n点击 🗝 创建API 开始申请。"
            : "💎 You haven't created an API yet.\n\nTap 🗝 Create API to start.");
        simRef.current?.appendMessage("dm", { from: "bot", text: failText });
        return;
      }
      const vars = {
        phone: flow.created.phone,
        api_id: flow.created.apiId,
        api_hash: flow.created.apiHash,
      };
      const successText = slotText(action.tgapi_success) ||
        (simLang === "zh"
          ? `📱 号码：${vars.phone}\n🆔 api_id：${vars.api_id}\n🔑 api_hash：${vars.api_hash}`
          : `📱 Number: ${vars.phone}\n🆔 api_id: ${vars.api_id}\n🔑 api_hash: ${vars.api_hash}`);
      simRef.current?.appendMessage("dm", { from: "bot", text: renderMenuTemplate(successText, vars) });
      return;
    }
    // v2.2.0 固定指令全量仿真（设置平台/帮助/客服支持/跳过/设置Title/设置Description）
    if (func === "platform") {
      if (action.tgapi_value && isValidTgApiPlatformValue(action.tgapi_value)) {
        simFlow.current.platform = action.tgapi_value;
        const label = TGAPI_PLATFORM_LABELS[action.tgapi_value] ?? action.tgapi_value;
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text: renderMenuTemplate(
            slotText(action.tgapi_success) ||
              (simLang === "zh"
                ? `✅ APP 平台已设置为 ${label}，创建 API 时将优先使用。`
                : `✅ App platform set to ${label}; it will be used when creating your API.`),
            { platform: label },
          ),
        });
        return;
      }
      simRef.current?.appendMessage("dm", {
        from: "bot",
        text:
          simLang === "zh"
            ? "📱 请在子菜单中选择平台（每行 2 个共 8 个平台按钮）；选中平台用于创建 APP 时提交。"
            : "📱 Please pick a platform in the submenu (8 options, 2 per row).",
      });
      return;
    }
    if (func === "help") {
      simRef.current?.appendMessage("dm", {
        from: "bot",
        text: renderMenuTemplate(response, {
          user_id: "777000",
          username: "preview_user",
          first_name: "预览",
        }) ||
          (simLang === "zh"
            ? "🆘 使用帮助：\n\n🗝 创建 API — 自动生成 api_id 和 api_hash\n🗂 我的 API — 查看已创建的 api_id 与 api_hash\n📱 设置平台 — 选择创建 APP 时的平台\n✅ 语言 — 中文/English 切换\n✏️ 设置Title / 📝 设置Description — 自定义 APP 名称与描述\n🎫 客服支持 — 联系管理员获取人工支持"
            : "🆘 How to use:\n\n🗝 Create API — generate api_id and api_hash\n🗂 My API — view your api_id and api_hash\n📱 Set Platform — choose the APP platform\n✅ Language — 中文/English\n✏️ Set Title / 📝 Set Description\n🎫 Support — contact the admin"),
      });
      return;
    }
    if (func === "support") {
      simRef.current?.appendMessage("dm", {
        from: "bot",
        text: renderMenuTemplate(response, {
          user_id: "777000",
          username: "preview_user",
          first_name: "预览",
        }) || (simLang === "zh" ? "🎫 如需人工支持，请联系管理员。" : "🎫 For human support, please contact the admin."),
      });
      return;
    }
    if (func === "settitle" || func === "setdescription") {
      flow.stage = func === "settitle" ? "prefTitle" : "prefDesc";
      simRef.current?.appendMessage("dm", {
        from: "bot",
        text:
          func === "settitle"
            ? TGAPI_TEXTS_ZH.askAppTitle.replaceAll("{default}", cfg.appTitle)
            : TGAPI_TEXTS_ZH.askAppDescription.replaceAll("{default}", cfg.appDescription),
      });
      return;
    }
  };

  /** 语言切换按钮：仿真屏实时切换双语文案 */
  const handleSimLanguageToggle = (): boolean => {
    const next = simLang === "zh" ? "en" : "zh";
    setSimLang(next);
    simRef.current?.appendMessage("dm", {
      from: "bot",
      text: `✅ 语言已切换 / Language switched：${next === "zh" ? "中文" : "English"}`,
    });
    return true;
  };

  /** 私聊输入（解锁验证码 / APP 名称 / 描述 / 手机号 / 登录码）——仿真状态机推进 */
  const handleSimUserSend = async (
    text: string,
  ): Promise<{ ok: boolean; text: string; joined?: boolean }> => {
    const flow = simFlow.current;
    const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
    const input = text.trim();
    // 设置Title/设置Description 偏好收集仿真（只记录，不进入创建流程）
    if (flow.stage === "prefTitle") {
      if (!input || input.length > 32) {
        return { ok: false, text: "APP 名称不合法：请输入 1-32 个字符。" };
      }
      flow.stage = "idle";
      return { ok: true, text: `✅ APP 名称已设置为：${input}` };
    }
    if (flow.stage === "prefDesc") {
      if (!input || input.length > 200) {
        return { ok: false, text: "APP 描述不合法：请输入 1-200 个字符。" };
      }
      flow.stage = "idle";
      return { ok: true, text: `✅ APP 描述已设置为：${input}` };
    }
    if (flow.stage === "unlock") {
      // 仿真：任意非空验证码通过（真实端走外部 API 核验）；解锁一次永久有效
      if (!input) return { ok: false, text: "请输入解锁验证码" };
      flow.unlocked = true;
      flow.stage = "idle";
      window.setTimeout(() => startSimCreate(), 300);
      return { ok: true, text: "🔐 验证通过（仿真：任意验证码即可通过，真实端走外部 API 核验）" };
    }
    if (flow.stage === "phone") {
      const phone = input.replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(phone)) {
        return { ok: false, text: texts.invalidPhone };
      }
      flow.phone = phone;
      flow.stage = "code";
      return { ok: true, text: texts.afterRecvdCode };
    }
    if (flow.stage === "code") {
      // 登录码 → 抓取/创建 APP → 结果（仿真演示值；真实端登录 my.telegram.org 真实抓取）
      flow.stage = "idle";
      window.setTimeout(() => {
        const created = { phone: flow.phone ?? "+8613800138000", ...SIM_DEMO_API };
        flow.created = created;
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text:
            `Phone Number: ${created.phone}\n\n` +
            "App Configuration\n" +
            `APP ID: ${created.apiId}\n` +
            `API HASH: ${created.apiHash}\n\n` +
            "（仿真演示数据；真实端登录 my.telegram.org 抓取/创建后返回真实值）",
        });
        const successRaw = slotText(flow.pendingSuccess);
        if (successRaw) {
          simRef.current?.appendMessage("dm", {
            from: "bot",
            text: renderMenuTemplate(successRaw, { ...created, api_id: created.apiId, api_hash: created.apiHash }),
          });
        }
      }, 1200);
      return { ok: true, text: texts.beforeSuccLogin };
    }
    return { ok: true, text: texts.start };
  };

  const stats = countMenuStats(menuRoot);

  /**
   * 解锁门禁配置模块（v2.2.5 抽为全站通用组件 src/components/admin/tgapi-gate-panel.tsx）：
   * 内嵌页签与自定义键盘页签共用同一渲染（两表单互斥渲染，id 无冲突）；
   * unlock_mode/verification_method_id/stars_amount/stars_title 随宿主表单提交 ——
   * 键盘页签由 saveTgApiCustomKeyboardAction 兼收，内嵌页签由 saveTgApiBotAction 收取。
   * 机器人管理页「自定义键盘」弹窗（TGAPI 机器人）同用本组件。
   */
  const gateConfigPanel = (idScope: string) => (
    <TgApiGatePanel
      idScope={idScope}
      methods={methods}
      unlockMode={cfg.unlockMode}
      verificationMethodId={cfg.verificationMethodId}
      starsAmount={cfg.starsAmount}
      starsTitle={cfg.starsTitle}
    />
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
            通用配置（基本信息 / 机器人所在真实群组 / my.telegram.org APP 创建参数 / 门禁 / 消息）为内嵌按钮与自定义键盘共用；
            「界面模式」checkbox 单选仅切换下方两个配置编辑区，勾选并保存（部署）后才对运行实例生效，此处仅按已保存数据打「生效中」标签。
            保存仅落库配置；上线/更新运行实例请到「仿真APP」页面部署。
          </DialogDescription>
        </DialogHeader>
        <form action={saveTgApiBotAction} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="id" value={bot ? String(bot.id) : ""} />
          <input type="hidden" name="menu_config" value={menuConfigPayload} />
          {/* v2.2.6：生效模式（checkbox 单选，保存并部署后生效）+ 自定义键盘附加属性载荷 */}
          <input type="hidden" name="kb_mode" value={mode} />
          <input type="hidden" name="custom_keyboard" value={kbPayload} />
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
            <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
              {/* 左侧配置区 */}
              <div className="min-w-0 space-y-4">
                {/* 1. 基本信息 */}
                <div className="space-y-4 rounded-xl border bg-card p-4">
                  <p className="text-sm font-semibold">1️⃣ 基本信息</p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor={`name-${suffix}`}>
                        名称 *
                      </label>
                      <input
                        id={`name-${suffix}`}
                        name="name"
                        required
                        defaultValue={bot?.name ?? "TGAPI申请机器人"}
                        placeholder="例如：TGAPI申请机器人"
                        className={inputClassOf()}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor={`token-${suffix}`}>
                        Bot Token {bot ? "（留空保留原值）" : "*"}
                      </label>
                      <input
                        id={`token-${suffix}`}
                        name="token"
                        defaultValue=""
                        placeholder={bot ? "留空保留原 Token" : "从 @BotFather 获取：123456:AA..."}
                        className={inputClassOf()}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id={`enabled-${suffix}`}
                      name="enabled"
                      type="checkbox"
                      value="1"
                      defaultChecked={bot ? bot.enabled : true}
                      className="h-4 w-4"
                    />
                    <label className="text-sm font-medium" htmlFor={`enabled-${suffix}`}>
                      启用机器人
                    </label>
                  </div>
                </div>

                {/* 2. 真实群组 + 申请加群按钮 */}
                <div className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">2️⃣ 🧭 机器人所在真实群组</p>
                    <button
                      type="button"
                      onClick={handleResetSimulator}
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

                {/* 3. my.telegram.org APP 创建参数 */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
                  <p className="text-sm font-semibold">3️⃣ 📱 my.telegram.org APP 创建参数</p>
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
                        className={inputClassOf()}
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
                        className={inputClassOf()}
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
                        className={inputClassOf()}
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
                        className={inputClassOf()}
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

                {/* 解锁门禁全局配置（通用组件：内嵌/键盘两页签共用同一渲染） */}
                {gateConfigPanel(suffix)}

                {/* 4. 消息配置（中英双语） */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                  <p className="text-sm font-semibold">
                    4️⃣ 💬 消息配置（中英文双语：按用户语言自动识别，「✅ 语言」按钮可手动切换）
                  </p>
                  <div className="space-y-1">
                    <label className="text-sm font-medium" htmlFor={`text-zh-start-${suffix}`}>
                      中文欢迎语（START_TEXT · 初始消息正文，右侧仿真屏实时预览）
                    </label>
                    <textarea
                      id={`text-zh-start-${suffix}`}
                      name={`text_zh_start`}
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
                      name={`text_en_start`}
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
                          defaultValue={
                            cfg.texts?.zh?.[field.name] ?? TGAPI_TEXTS_ZH[field.name]
                          }
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
                          defaultValue={
                            cfg.texts?.en?.[field.name] ?? TGAPI_TEXTS_EN[field.name]
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* 5. 界面模式选择（v2.2.6 checkbox 单选）：仅切换下方两个编辑区；生效标签按已保存数据打标 */}
                <div className="space-y-3 rounded-xl border bg-card p-4">
                  <p className="text-sm font-semibold">5️⃣ 界面模式（checkbox 单选：勾选即切换下方编辑区）</p>
                  <p className="text-xs text-muted-foreground">
                    两种界面互斥生效：勾选并「保存机器人」（再到「仿真APP」页部署）后才对运行实例正式生效 —— 此处「生效中」标签按已保存数据打标，不随草稿切换。
                  </p>
                  <div className="flex flex-col gap-2">
                    <label
                      className={`inline-flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                        mode === "inline" ? "border-primary/50 bg-primary/5" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="kb_mode"
                        value="inline"
                        checked={mode === "inline"}
                        onChange={() => setMode("inline")}
                        className="h-4 w-4"
                      />
                      🔘 消息内嵌按钮（初始消息底部 InlineKeyboard）
                      {activeMode === "inline" ? (
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">生效中</span>
                      ) : null}
                    </label>
                    <label
                      className={`inline-flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                        mode === "keyboard" ? "border-primary/50 bg-primary/5" : ""
                      } ${!bot ? "opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        name="kb_mode"
                        value="keyboard"
                        checked={mode === "keyboard"}
                        onChange={() => setMode("keyboard")}
                        disabled={!bot}
                        className="h-4 w-4"
                      />
                      ⌨️ 自定义键盘（ReplyKeyboard 对话流程）
                      {activeMode === "keyboard" ? (
                        <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">生效中</span>
                      ) : null}
                      {!bot ? <span className="text-xs text-muted-foreground">（先保存机器人，再配置自定义键盘）</span> : null}
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {kbPayload
                      ? "自定义键盘配置已保留（附加属性）：切换到内嵌按钮模式不会清除键盘配置。"
                      : "尚未配置自定义键盘；勾选键盘模式后可在下方编辑区设计。"}
                  </p>
                </div>

                {/* 6. 内嵌按钮配置（与机器人管理「消息内嵌按钮」弹窗完全同一编辑器实现；仅内嵌模式显示，切换保留草稿） */}
                <div className={mode === "inline" ? "space-y-3" : "hidden"}>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">
                        🔘 内嵌按钮配置（初始消息底部的按钮，仿真屏实时预览；交互下拉 = TGAPI 固定指令列表（10 条）+ 通用项）
                      </p>
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
                    </div>
                    {cfg.customKeyboard && activeMode === "keyboard" ? (
                      <p className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
                        ⌨️ 自定义键盘对话流程当前生效（互斥）：本弹窗配置的内嵌按钮不会被发送；
                        勾选「消息内嵌按钮」并保存即可切回内嵌模式（键盘配置保留不清除）。
                      </p>
                    ) : null}
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
              </div>

              {/* 右侧仿真屏（与机器人管理页完全同一 TgSimulator；仅内嵌模式显示 —— 键盘模式见下方整宽键盘编辑区） */}
              <div
                className={`min-w-0 lg:sticky lg:top-0 lg:self-start ${mode === "inline" ? "" : "hidden"}`}
                key={resetKey}
              >
                <TgSimulator
                  ref={simRef}
                  config={simulatorConfig}
                  botName={botDisplayName}
                  groupTitle={realGroupTitle}
                  memberCount={realGroups.groups.length > 0 ? "已部署的真实群组" : ""}
                  nodeId={simNodeId}
                  onNodeNavigate={setSimNodeId}
                  systemNote={
                    simView === "group"
                      ? "TGAPI 申请群组 · 点击下方「申请加入群组」开始仿真"
                      : undefined
                  }
                  view={simView}
                  joinPhase={joinPhase}
                  onRequestJoin={handleSimRequestJoin}
                  onUserSend={handleSimUserSend}
                  showMenuInPrivate={simView === "private"}
                  onTgApiFunc={handleSimTgApiFunc}
                  onLanguageToggle={handleSimLanguageToggle}
                />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  仿真流程与真实机器人完全一致：申请加入群组 → 自动通过并跳转私聊 → 初始消息+内嵌按钮 →
                  创建API（解锁门禁 → APP 参数 → 手机号 → 登录码 → api_id/api_hash）→ 我的API → 语言切换 → /start 重发。
                  共 {stats.buttons} 个按钮 · {stats.submenus} 个子菜单。
                </p>
              </div>
            </div>

            {/* ⌨️ 自定义键盘配置区（v2.2.6：仅键盘模式显示；embedded 无独立表单/保存按钮，
                键盘载荷经 onConfigChange 同步到统一表单 hidden custom_keyboard 字段提交；
                切换保留草稿 —— 编辑器始终保持挂载，仅 CSS 隐藏） */}
            <div className={mode === "keyboard" ? "" : "hidden"}>
              {bot ? (
                <CustomKeyboardDesigner
                  botId={String(bot.id)}
                  botName={botDisplayName}
                  initialConfig={cfg.customKeyboard ?? null}
                  isTgApi
                  embedded
                  action={saveTgApiCustomKeyboardAction}
                  onConfigChange={handleKbConfigChange}
                  tgapiModeHint={
                    activeMode === "keyboard"
                      ? "自定义键盘对话流程当前生效：消息内嵌按钮不再渲染（互斥）。勾选「消息内嵌按钮」并保存可切回内嵌模式（本键盘配置保留不清除）。"
                      : "当前生效的是消息内嵌按钮模式：设计好键盘并保存后，勾选「自定义键盘」为生效模式（保存并部署后生效）。"
                  }
                  renderSimulator={(kbConfig) => (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          TGAPI 对话流程仿真（与部署后真实行为一致）：/start → 门禁 → 主键盘 → 按钮交互
                        </p>
                        <button
                          type="button"
                          onClick={() => setKbSimKey((prev) => prev + 1)}
                          className="inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-xs hover:bg-accent"
                          title="重新从 /start 开始仿真"
                        >
                          🔄 重新仿真
                        </button>
                      </div>
                      <TgApiKeyboardFlowSim
                        key={`kbflow-${kbSimKey}`}
                        cfg={cfg}
                        keyboard={kbConfig}
                        botName={botDisplayName}
                      />
                    </div>
                  )}
                />
              ) : (
                <p className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                  ⌨️ 自定义键盘：先保存机器人（填写名称与 Token 后点「保存机器人」），再次打开本弹窗即可配置。
                </p>
              )}
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
