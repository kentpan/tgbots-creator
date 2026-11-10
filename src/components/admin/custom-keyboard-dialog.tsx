"use client";

import { useMemo, useRef, useState } from "react";
import { Keyboard as KeyboardIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TgSimulator } from "@/components/admin/tg-simulator";
import {
  KeyboardOptionsEditor,
  KeyboardRowList,
  buildKeyboardActionForType,
  createKeyboardButtonId,
  createKeyboardRowId,
  defaultKeyboardAction,
  emptyKeyboardOptions,
  findKeyboardButton,
  type KeyboardDesignerState,
} from "@/components/admin/custom-keyboard-editor";
import type { MenuCommandOption } from "@/components/admin/menu-designer-editor";
import {
  defaultTgApiCustomKeyboard,
  type CustomKeyboardButton,
  type CustomKeyboardConfig,
} from "@/services/custom-keyboard";
import { renderMenuTemplate } from "@/services/menu-config";
import { SubmitButton } from "@/components/admin/submit-button";
import { TgApiGatePanel } from "@/components/admin/tgapi-gate-panel";
import { TgApiKeyboardFlowSim } from "@/components/admin/tgapi-keyboard-flow";
import { parseTgApiBotConfig, type TgApiBotConfig } from "@/services/tgapi-config";

/**
 * 「自定义键盘」通用组件（v2.2.1 模块化）：
 *
 * - CustomKeyboardDesigner：弹窗内嵌的键盘设计器表单体（编辑器 + 仿真屏 + 底部按钮），
 *   机器人管理页弹窗与 TGAPI「菜单和键盘」统一弹窗（键盘页签）共用；
 *   renderSimulator 允许宿主替换右侧仿真屏（TGAPI 用对话流程仿真组件）。
 * - CustomKeyboardDialog：机器人管理页「⌨️ 自定义键盘」独立弹窗外壳（普通机器人：
 *   自定义键盘附加到 /start 欢迎消息，与消息内嵌按钮不互斥），默认仿真屏带
 *   真实交互仿真（点击按钮 = 发送文本，机器人按「点击后的交互」真实响应）。
 *
 * TGAPI 互斥条件（isTgApi=true）：tgapi.customKeyboard 配置非空 = 自定义键盘对话
 * 流程生效，消息内嵌按钮不再渲染；保存空键盘 = 回到消息内嵌按钮模式。
 */

function KeyboardButtonPreview({ config }: { config: CustomKeyboardConfig }) {
  return (
    <div className="space-y-[3px] rounded-lg border bg-muted/20 p-2">
      {config.root.rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">（空键盘 = 未启用自定义键盘模式）</p>
      ) : null}
      {config.root.rows.map((row, rowIndex) => (
        <div key={row.id || rowIndex} className="flex gap-[3px]">
          {row.buttons.map((button) => (
            <div
              key={button.id || button.text}
              className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-center text-xs font-medium ${
                button.style === "primary"
                  ? "bg-[#54a9eb] text-white"
                  : button.style === "danger"
                    ? "bg-[#ec5e5e] text-white"
                    : button.style === "success"
                      ? "bg-[#63cf64] text-white"
                      : "bg-white text-[#1c1e21] shadow-sm"
              }`}
            >
              {button.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 仿真屏通用变量（与管理端既有仿真一致的演示上下文） */
const SIM_VARS = {
  user_id: "777000",
  username: "preview_user",
  first_name: "预览",
  chat_id: "-1001998877661",
};

export function CustomKeyboardDesigner({
  botId,
  botName,
  initialConfig,
  isTgApi,
  action,
  onSaved,
  onCancel,
  builtinCommands = [],
  customCommands = [],
  tgapiModeHint,
  renderSimulator,
  extraFields,
  saveLabel = "保存键盘",
  embedded = false,
  onConfigChange,
}: {
  botId: string;
  botName: string;
  /** 初始配置（宿主从 bots.config 解析；null = 尚未配置） */
  initialConfig: CustomKeyboardConfig | null;
  isTgApi: boolean;
  /** 保存 server action：表单字段 id + custom_keyboard（JSON；空串 = 清除配置） */
  action: (formData: FormData) => Promise<void>;
  /** 保存成功回调（宿主关闭弹窗/刷新） */
  onSaved?: () => void;
  /** 取消回调（独立弹窗 = 关闭；统一弹窗键盘页签不传 = 不渲染取消按钮） */
  onCancel?: () => void;
  builtinCommands?: MenuCommandOption[];
  customCommands?: MenuCommandOption[];
  /** TGAPI 模式下的互斥说明 */
  tgapiModeHint?: string;
  /** 宿主替换右侧仿真屏（TGAPI 统一弹窗注入对话流程仿真组件） */
  renderSimulator?: (config: CustomKeyboardConfig) => React.ReactNode;
  /** v2.2.2 宿主注入的额外表单字段（TGAPI 键盘页签内嵌门禁配置模块），随表单一并提交 */
  extraFields?: React.ReactNode;
  saveLabel?: string;
  /**
   * v2.2.6 嵌入模式：不渲染 <form> 外壳/hidden 字段/底部保存按钮/extraFields，
   * 仅渲染编辑区 + 仿真区两栏 —— 由宿主统一表单（TGAPI「菜单和键盘」弹窗）
   * 携带 hidden custom_keyboard 字段与统一保存按钮提交。
   */
  embedded?: boolean;
  /** v2.2.6 嵌入模式：配置每次变更回调宿主（宿主序列化到统一表单 hidden 字段） */
  onConfigChange?: (config: CustomKeyboardConfig) => void;
}) {
  const counter = useRef(0);
  const [config, setConfigState] = useState<CustomKeyboardConfig>(
    () => initialConfig ?? { options: emptyKeyboardOptions(), root: { rows: [] } },
  );
  // v2.2.6 嵌入模式：每次配置变更同步回调宿主（统一表单 hidden custom_keyboard 载荷）
  const setConfig = (updater: (prev: CustomKeyboardConfig) => CustomKeyboardConfig): void => {
    setConfigState((prev) => {
      const next = updater(prev);
      onConfigChange?.(next);
      return next;
    });
  };
  const [selected, setSelected] = useState<string | null>(null);

  const mutate = (mutator: (draft: CustomKeyboardConfig) => void): void => {
    setConfig((prev) => {
      const draft: CustomKeyboardConfig = JSON.parse(JSON.stringify(prev));
      mutator(draft);
      return draft;
    });
  };

  const state: KeyboardDesignerState = {
    config,
    selected,
    isTgApi,
    builtinCommands,
    customCommands,
    actions: {
      addRow: () =>
        mutate((draft) => {
          if (draft.root.rows.length >= 10) return;
          draft.root.rows.push({ id: createKeyboardRowId(), buttons: [] });
        }),
      moveRow: (rowIndex, direction) =>
        mutate((draft) => {
          const target = rowIndex + direction;
          if (target < 0 || target >= draft.root.rows.length) return;
          const [row] = draft.root.rows.splice(rowIndex, 1);
          draft.root.rows.splice(target, 0, row);
        }),
      deleteRow: (rowId) =>
        mutate((draft) => {
          draft.root.rows = draft.root.rows.filter((row) => row.id !== rowId);
        }),
      addButton: (rowId) => {
        const id = createKeyboardButtonId(counter);
        mutate((draft) => {
          for (const row of draft.root.rows) {
            if (row.id !== rowId) continue;
            row.buttons.push({
              id,
              text: `按钮 ${row.buttons.length + 1}`,
              kind: "text",
              style: "default",
              ...(isTgApi ? { action: defaultKeyboardAction() } : {}),
            });
            break;
          }
        });
        setSelected(id);
      },
      selectButton: (buttonId) => setSelected(buttonId),
      updateButton: (buttonId, mutator) =>
        mutate((draft) => {
          for (const row of draft.root.rows) {
            const found = row.buttons.find((item) => item.id === buttonId);
            if (found) {
              mutator(found);
              return;
            }
          }
        }),
      deleteButton: (buttonId) => {
        mutate((draft) => {
          for (const row of draft.root.rows) {
            row.buttons = row.buttons.filter((item) => item.id !== buttonId);
          }
          draft.root.rows = draft.root.rows.filter((row) => row.buttons.length > 0);
        });
        setSelected(null);
      },
      changeActionType: (buttonId, value) => {
        mutate((draft) => {
          const button = findKeyboardButton(draft, buttonId);
          if (!button) return;
          if (value === "none") {
            delete button.action;
            return;
          }
          const next = buildKeyboardActionForType(value, button.action);
          if (next.action) button.action = next.action;
        });
      },
    },
  };

  /** 默认仿真屏：点击键盘按钮 = 发送按钮文本，机器人按「点击后的交互」真实响应 */
  const handleSimReplyClick = (button: CustomKeyboardButton): void => {
    if (button.kind === "web_app") {
      if (button.url) window.open(button.url, "_blank", "noopener");
      return;
    }
    if (button.kind === "request_contact" || button.kind === "request_location") {
      handleSimAppend("user", button.kind === "request_contact" ? "📱 （联系人卡片）" : "📍 （位置信息）");
      handleSimAppend(
        "bot",
        button.kind === "request_contact"
          ? "（真实端将以 contact 消息收到用户授权共享的手机号）"
          : "（真实端将以 location 消息收到用户当前位置）",
      );
      return;
    }
    handleSimAppend("user", button.text);
    const action = button.action;
    if (!action) {
      handleSimAppend("bot", "（该按钮未配置点击后的交互：机器人不会响应）");
      return;
    }
    if (action.type === "reply") {
      const raw = action.content?.text || action.text || "";
      if (action.content && action.content.type !== "text") {
        const label =
          action.content.type === "photo"
            ? "🖼 图片"
            : action.content.type === "video"
              ? "🎬 视频"
              : "🖼 相册";
        handleSimAppend("bot", `${label}\n${renderMenuTemplate(raw, SIM_VARS)}`);
        return;
      }
      handleSimAppend(
        "bot",
        renderMenuTemplate(raw, SIM_VARS) || "（未配置回复内容）",
      );
      return;
    }
    if (action.type === "command") {
      const name = (action.target ?? "").trim().replace(/^\//, "");
      handleSimAppend(
        "bot",
        name
          ? `⌨️ /${name}\n\n（真实机器人将真实执行 /${name} 指令：内置指令或指令管理中启用的自定义指令）`
          : "⚠️ 该按钮还没有绑定指令：请在按钮配置中选择要执行的指令",
      );
      return;
    }
    if (action.type === "language") {
      handleSimAppend("bot", "✅ 语言已切换 / Language switched：中文 ⇄ English\n（真实机器人点击后在 中文/English 之间切换并回复切换结果）");
      return;
    }
    if (action.type === "tgapi_func") {
      handleSimAppend("bot", `（TGAPI 功能按钮 ${action.tgapi_func ?? "start"}：真实机器人将执行对应指令流程）`);
      return;
    }
  };

  /** 默认仿真屏消息追加（renderSimulator 未提供时使用；TgSimulator 内部状态自渲染） */
  const simAppendRef = useRef<((from: "bot" | "user", text: string) => void) | null>(null);
  const handleSimAppend = (from: "bot" | "user", text: string): void => {
    simAppendRef.current?.(from, text);
  };

  const payload = useMemo(() => {
    if (config.root.rows.length === 0) return "";
    return JSON.stringify(config);
  }, [config]);

  // v2.2.6 嵌入模式：纯字段编辑区（无 form 外壳/隐藏字段/保存按钮 —— 宿主统一表单提交）
  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
          <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
            <div className="min-w-0 space-y-4">
              {tgapiModeHint ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                  ⚠️ {tgapiModeHint}
                </p>
              ) : null}
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <p className="text-sm font-semibold">键盘选项</p>
                <KeyboardOptionsEditor
                  options={config.options}
                  onChange={(options) => setConfig((prev) => ({ ...prev, options }))}
                />
                <div>
                  <p className="mb-1 text-sm font-medium">键盘预览（随消息发送，右屏同步）</p>
                  <KeyboardButtonPreview config={config} />
                </div>
                {isTgApi ? (
                  <button
                    type="button"
                    onClick={() => {
                      setConfig(() =>
                        JSON.parse(JSON.stringify(defaultTgApiCustomKeyboard())) as CustomKeyboardConfig,
                      );
                      setSelected(null);
                    }}
                    className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                    title="恢复图1默认键盘（创建API/我的API/设置平台/语言/帮助/客服支持）"
                  >
                    ↺ 恢复图1默认键盘
                  </button>
                ) : null}
              </div>
              <KeyboardRowList state={state} />
              {!selected ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  点击任意按钮可配置名称、类型、样式与交互行为
                  {isTgApi ? "（TGAPI 固定指令列表 + 解锁门禁 + 指令消息）" : ""}
                </p>
              ) : null}
            </div>
            <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
              {renderSimulator ? (
                renderSimulator(config)
              ) : (
                <TgSimulator
                  config={{
                    content: {
                      type: "text",
                      text: isTgApi
                        ? "💀 欢迎使用 API 生成机器人！\n\n本机器人可为您自己的 Telegram 账号自动生成 api_id 和 api_hash。\n\n👇 请使用下方键盘按钮："
                        : "👋 欢迎使用本机器人！\n\n👇 请使用下方自定义键盘：",
                      mediaUrl: "",
                      items: [],
                    },
                    root: { rows: [] },
                  }}
                  botName={botName}
                  view="private"
                  nodeId="root"
                  onNodeNavigate={() => undefined}
                  systemNote="自定义键盘模式 · 点击键盘按钮模拟用户发送，机器人真实响应"
                  replyKeyboard={config}
                  onReplyButtonClick={handleSimReplyClick}
                  ref={(node) => {
                    simAppendRef.current =
                      node &&
                      ((from: "bot" | "user", text: string) =>
                        node.appendMessage("dm", { from, text }));
                  }}
                />
              )}
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                仿真屏为 Telegram 私聊视图：蓝色=primary 主色、红色=danger 危险色、绿色=success 成功色。
                {isTgApi
                  ? "保存非空键盘后，真实机器人 /start 即以此键盘开启对话流程。"
                  : "保存后键盘附加到 /start 欢迎消息。"}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      action={async (formData) => {
        await action(formData);
        onSaved?.();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <input type="hidden" name="id" value={botId} />
      <input type="hidden" name="custom_keyboard" value={payload} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
        <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
          <div className="min-w-0 space-y-4">
            {extraFields ? <div className="space-y-4">{extraFields}</div> : null}
            {tgapiModeHint ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                ⚠️ {tgapiModeHint}
              </p>
            ) : null}

            <div className="space-y-3 rounded-xl border bg-card p-4">
              <p className="text-sm font-semibold">键盘选项</p>
              <KeyboardOptionsEditor
                options={config.options}
                onChange={(options) => setConfig((prev) => ({ ...prev, options }))}
              />
              <div>
                <p className="mb-1 text-sm font-medium">键盘预览（随消息发送，右屏同步）</p>
                <KeyboardButtonPreview config={config} />
              </div>
              {isTgApi ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfig(() => JSON.parse(JSON.stringify(defaultTgApiCustomKeyboard())) as CustomKeyboardConfig);
                    setSelected(null);
                  }}
                  className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                  title="恢复图1默认键盘（创建API/我的API/设置平台/语言/帮助/客服支持）"
                >
                  ↺ 恢复图1默认键盘
                </button>
              ) : null}
            </div>

            <KeyboardRowList state={state} />
            {!selected ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                点击任意按钮可配置名称、类型、样式与交互行为
                {isTgApi ? "（TGAPI 固定指令列表 + 解锁门禁 + 指令消息）" : ""}
              </p>
            ) : null}
          </div>

          <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
            {renderSimulator ? (
              renderSimulator(config)
            ) : (
              <TgSimulator
                config={{
                  content: {
                    type: "text",
                    text: isTgApi
                      ? "💀 欢迎使用 API 生成机器人！\n\n本机器人可为您自己的 Telegram 账号自动生成 api_id 和 api_hash。\n\n👇 请使用下方键盘按钮："
                      : "👋 欢迎使用本机器人！\n\n👇 请使用下方自定义键盘：",
                    mediaUrl: "",
                    items: [],
                  },
                  root: { rows: [] },
                }}
                botName={botName}
                view="private"
                nodeId="root"
                onNodeNavigate={() => undefined}
                systemNote="自定义键盘模式 · 点击键盘按钮模拟用户发送，机器人真实响应"
                replyKeyboard={config}
                onReplyButtonClick={handleSimReplyClick}
                ref={(node) => {
                  simAppendRef.current =
                    node &&
                    ((from: "bot" | "user", text: string) =>
                      node.appendMessage("dm", { from, text }));
                }}
              />
            )}
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              仿真屏为 Telegram 私聊视图：蓝色=primary 主色、红色=danger 危险色、绿色=success 成功色。
              {isTgApi
                ? "保存非空键盘后，真实机器人 /start 即以此键盘开启对话流程。"
                : "保存后键盘附加到 /start 欢迎消息。"}
            </p>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            取消
          </button>
        ) : null}
        <SubmitButton
          className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          pendingLabel="保存中…"
        >
          {saveLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

/** 机器人管理页「⌨️ 自定义键盘」独立弹窗（普通机器人：键盘附加到 /start 欢迎消息）
 *  v2.2.5 TGAPI 形态内置（机器人管理列表兼容 TGAPI 申请机器人）：isTgApi=true 且提供
 *  methods/tgapiCfg 时，弹窗自动内嵌门禁配置面板（TgApiGatePanel）与对话流程仿真
 *  （TgApiKeyboardFlowSim），与 TGAPI申请页「菜单和键盘」键盘页签同一形态 ——
 *  保存动作同走 saveTgApiCustomKeyboardAction（customKeyboard + 门禁字段一并提交） */
export function CustomKeyboardDialog({
  botId,
  botName,
  initialConfig,
  isTgApi,
  action,
  trigger,
  triggerClassName,
  builtinCommands = [],
  customCommands = [],
  tgapiModeHint,
  methods,
  tgapiConfig,
}: {
  botId: string;
  botName: string;
  initialConfig: CustomKeyboardConfig | null;
  isTgApi: boolean;
  action: (formData: FormData) => Promise<void>;
  trigger: React.ReactNode;
  triggerClassName?: string;
  builtinCommands?: MenuCommandOption[];
  customCommands?: MenuCommandOption[];
  /** TGAPI 模式下的互斥说明（已配置内嵌按钮时的提示） */
  tgapiModeHint?: string;
  /** v2.2.5 TGAPI 机器人（isTgApi=true）：门禁配置面板的验证方式列表（不传 = 不渲染门禁模块） */
  methods?: { id: number; name: string; enabled: boolean; type: string }[];
  /** v2.2.5 TGAPI 机器人：bots.config 原始 JSON（宿主传 bot.config），门禁初始值与对话仿真来源 */
  tgapiConfig?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  // 对话流程仿真重置计数（重新从 /start 开始）
  const [kbSimKey, setKbSimKey] = useState(0);
  // 弹窗每次打开时按最新配置重置（避免读到上一会话的陈旧状态）
  const openKey = useMemo(() => `${open}-${savedKey}`, [open, savedKey]);

  const tgapiCfg: TgApiBotConfig | null = useMemo(() => {
    if (!isTgApi) return null;
    try {
      return parseTgApiBotConfig(tgapiConfig ?? "{}");
    } catch {
      return null;
    }
  }, [isTgApi, tgapiConfig]);

  const gateFields =
    isTgApi && methods && tgapiCfg ? (
      <TgApiGatePanel
        idScope={`bots-kb-${botId}`}
        methods={methods}
        unlockMode={tgapiCfg.unlockMode}
        verificationMethodId={tgapiCfg.verificationMethodId}
        starsAmount={tgapiCfg.starsAmount}
        starsTitle={tgapiCfg.starsTitle}
      />
    ) : undefined;

  const flowSimulator =
    isTgApi && tgapiCfg
      ? (kbConfig: CustomKeyboardConfig) => (
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
            <TgApiKeyboardFlowSim key={`kbflow-${kbSimKey}`} cfg={tgapiCfg} keyboard={kbConfig} botName={botName} />
          </div>
        )
      : undefined;

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
            <KeyboardIcon className="h-5 w-5 text-primary" />
            自定义键盘 · {botName}
          </DialogTitle>
          <DialogDescription>
            {isTgApi
              ? "自定义键盘（对话流程）= 用户点击底部键盘按钮发送文本，机器人按配置真实响应。保存非空键盘后 TGAPI 对话流程生效（互斥：消息内嵌按钮不再发送）；保存空键盘回到消息内嵌按钮模式。"
              : "自定义键盘附加到 /start 欢迎消息底部；用户点击按钮 = 发送按钮文本，机器人按「点击后的交互」真实响应。"}
          </DialogDescription>
        </DialogHeader>
        <CustomKeyboardDesigner
          key={openKey}
          botId={botId}
          botName={botName}
          initialConfig={initialConfig}
          isTgApi={isTgApi}
          action={action}
          onSaved={() => {
            setSavedKey((prev) => prev + 1);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
          builtinCommands={builtinCommands}
          customCommands={customCommands}
          tgapiModeHint={tgapiModeHint}
          extraFields={gateFields}
          renderSimulator={flowSimulator}
        />
      </DialogContent>
    </Dialog>
  );
}
