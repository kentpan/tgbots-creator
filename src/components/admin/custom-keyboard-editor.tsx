"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import {
  ContentEditor,
  uid,
  type MenuCommandOption,
} from "@/components/admin/menu-designer-editor";
import {
  countCustomKeyboardStats,
  CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW,
  CUSTOM_KEYBOARD_MAX_BUTTONS_TOTAL,
  CUSTOM_KEYBOARD_MAX_DEPTH,
  CUSTOM_KEYBOARD_MAX_ROWS,
  CUSTOM_KEYBOARD_TEXT_MAX_LENGTH,
  type CustomKeyboardButton,
  type CustomKeyboardButtonKind,
  type CustomKeyboardRow,
  type CustomKeyboardButtonStyle,
  type CustomKeyboardConfig,
} from "@/services/custom-keyboard";
import { ACTION_OPTIONS } from "@/components/admin/menu-designer-editor";
import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";
import type { VerificationMethodOption } from "@/components/admin/menu-designer-editor";
import {
  isValidTgApiPlatformValue,
  TGAPI_MENU_FUNCS,
  TGAPI_PLATFORM_LABELS,
  type MenuButtonAction,
  type MenuMessageContent,
} from "@/services/menu-config";

/**
 * 自定义键盘编辑器（v2.2.0）——「自定义键盘」弹窗的配置模块唯一实现：
 * 机器人管理页弹窗与 TGAPI申请 弹窗共用（模块化通用组件）。
 * 布局/交互复刻消息内嵌按钮配置（menu-designer-editor 的 NodeEditor）：
 * 行/按钮 CRUD、选中按钮配置面板；差异点：
 * - 每行最多 4 个按钮（ReplyKeyboard 约束），无子菜单树（键盘不可嵌套）；
 * - 按钮类型：文本 / 请求联系方式（request_contact）/ 请求位置 / WebApp；
 * - 按钮样式：KeyboardButton.style（primary=蓝 / danger=红 / success=绿 / default）；
 * - TGAPI 差异经 isTgApi 注入：交互下拉 = TGAPI 固定指令列表（10 条） +
 *   通用项；选中指令按钮时提供「首次对话解锁门禁」开关与指令消息配置（双语 {{变量}}）。
 */

/** 键盘按钮类型选项 */
const KIND_OPTIONS: { value: CustomKeyboardButtonKind; label: string; desc: string }[] = [
  { value: "text", label: "文本按钮（点击发送按钮文本）", desc: "点击后机器人按「点击后的交互」真实响应" },
  {
    value: "request_contact",
    label: "请求联系方式（共享手机号）",
    desc: "点击弹出 Telegram 授权框，用户确认后以 contact 消息发送手机号（Keyboard#requestContact）",
  },
  { value: "request_location", label: "请求位置", desc: "点击后发送用户当前地理位置" },
  { value: "web_app", label: "打开 WebApp", desc: "点击后在机器人内打开 WebApp 页面" },
];

/** 按钮样式选项（KeyboardButton.style：Bot API 主色/危险色/成功色） */
const STYLE_OPTIONS: { value: CustomKeyboardButtonStyle; label: string; swatch: string }[] = [
  { value: "default", label: "默认", swatch: "bg-gray-200" },
  { value: "primary", label: "主色（蓝，Keyboard#primary）", swatch: "bg-[#54a9eb]" },
  { value: "danger", label: "危险（红，Keyboard#danger）", swatch: "bg-[#ec5e5e]" },
  { value: "success", label: "成功（绿，Keyboard#success）", swatch: "bg-[#63cf64]" },
];

export interface KeyboardDesignerState {
  config: CustomKeyboardConfig;
  /** 当前选中按钮 id（null = 未选中） */
  selected: string | null;
  isTgApi: boolean;
  builtinCommands: MenuCommandOption[];
  customCommands: MenuCommandOption[];
  /** v2.3 验证方式库（verify 动作绑定验证方法；与内嵌按钮同一数据源） */
  verificationMethods?: VerificationMethodOption[];
  /** 当前键盘层级（根键盘 = 1；子菜单编辑器递归 +1，达上限不可再建子菜单） */
  depth?: number;
  actions: {
    addRow: () => void;
    moveRow: (rowIndex: number, direction: -1 | 1) => void;
    deleteRow: (rowId: string) => void;
    addButton: (rowId: string) => void;
    selectButton: (buttonId: string | null) => void;
    updateButton: (buttonId: string, mutator: (draft: CustomKeyboardButton) => void) => void;
    deleteButton: (buttonId: string) => void;
    /** 交互类型变更：TGAPI 指令为复合值（tgapi_func:<func>），由宿主弹窗解析 */
    changeActionType: (buttonId: string, value: string) => void;
  };
}

export function createKeyboardRowId(): string {
  return `kbrow${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createKeyboardButtonId(counter: { current: number }): string {
  return uid("kbtn", counter);
}

export function emptyKeyboardOptions(): CustomKeyboardConfig["options"] {
  return { resize: true, persistent: true, oneTime: false, inputPlaceholder: "" };
}

export function defaultKeyboardAction(): MenuButtonAction {
  return { type: "tgapi_func", tgapi_func: "start" };
}

export function findKeyboardButton(
  config: CustomKeyboardConfig,
  buttonId: string,
): CustomKeyboardButton | null {
  for (const row of config.root.rows) {
    const found = row.buttons.find((item) => item.id === buttonId);
    if (found) return found;
  }
  return null;
}

export function KeyboardRowList({ state }: { state: KeyboardDesignerState }) {
  const { config, selected, actions } = state;
  const stats = countCustomKeyboardStats(config);
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          键盘按钮布局
          <span className="ml-1 text-sm font-normal text-muted-foreground">
            （每行最多 {CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW} 个按钮，共 {CUSTOM_KEYBOARD_MAX_ROWS} 行；
            点击按钮 = 用户发送按钮文本）
          </span>
        </p>
        <button
          type="button"
          onClick={actions.addRow}
          disabled={config.root.rows.length >= CUSTOM_KEYBOARD_MAX_ROWS}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
        >
          + 添加一行
        </button>
      </div>

      {config.root.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有按钮行，点击「添加一行」开始搭建键盘
        </p>
      ) : null}

      {config.root.rows.map((row, rowIndex) => (
        <div key={row.id || rowIndex} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            {row.buttons.map((button) => {
              const isSelected = selected === button.id;
              return (
                <button
                  key={button.id || button.text}
                  type="button"
                  onClick={() => actions.selectButton(button.id)}
                  className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm ${
                    isSelected ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"
                  }`}
                  title={button.text}
                >
                  {button.style !== "default" ? (
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        STYLE_OPTIONS.find((item) => item.value === button.style)?.swatch ?? ""
                      }`}
                    />
                  ) : null}
                  {button.kind !== "text" ? (
                    <span className="text-xs text-muted-foreground">
                      {button.kind === "request_contact" ? "📱" : button.kind === "request_location" ? "📍" : "🌐"}
                    </span>
                  ) : null}
                  {button.text}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => actions.addButton(row.id)}
              disabled={row.buttons.length >= CUSTOM_KEYBOARD_MAX_BUTTONS_PER_ROW}
              className="rounded-md border border-dashed px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              + 按钮
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => actions.moveRow(rowIndex, -1)}
                disabled={rowIndex === 0}
                className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                title="上移"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => actions.moveRow(rowIndex, 1)}
                disabled={rowIndex === config.root.rows.length - 1}
                className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                title="下移"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <ConfirmDialog
                trigger={
                  <>
                    <Trash2 className="h-3.5 w-3.5" /> 删行
                  </>
                }
                triggerClassName="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                title="删除该行按钮？"
                description="该行的全部按钮将一并删除，删除后不可恢复。"
                confirmLabel="确认删除"
                onConfirm={() => actions.deleteRow(row.id)}
              />
            </div>
          </div>
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        共 {stats.buttons}/{CUSTOM_KEYBOARD_MAX_BUTTONS_TOTAL} 个按钮 · {stats.rows} 行
      </p>

      {selected ? <SelectedKeyboardButtonPanel key={selected} state={state} /> : null}
    </div>
  );
}

/** 键盘按钮指令消息槽位 key → MenuButtonAction 字段名（与内嵌按钮设计器同一字段） */
const KEYBOARD_SLOT_FIELDS = {
  response: "tgapi_response",
  success: "tgapi_success",
  fail: "tgapi_fail",
} as const;

function SelectedKeyboardButtonPanel({ state }: { state: KeyboardDesignerState }) {
  const { config, selected, actions, isTgApi } = state;
  if (!selected) return null;
  const button = findKeyboardButton(config, selected);
  if (!button) return null;
  const update = (mutator: (draft: CustomKeyboardButton) => void): void =>
    actions.updateButton(selected, mutator);
  const action = button.action;
  const funcDef =
    isTgApi && action?.type === "tgapi_func"
      ? TGAPI_MENU_FUNCS.find((item) => item.func === action.tgapi_func)
      : undefined;

  const slotValue = (key: "response" | "success" | "fail"): { zh: string; en: string } | undefined => {
    if (!action) return undefined;
    if (key === "response") return action.tgapi_response;
    if (key === "success") return action.tgapi_success;
    return action.tgapi_fail;
  };
  const setSlot = (key: "response" | "success" | "fail", lang: "zh" | "en", value: string): void => {
    update((draft) => {
      if (!draft.action) draft.action = defaultKeyboardAction();
      const field = KEYBOARD_SLOT_FIELDS[key];
      const current = draft.action[field] ?? { zh: "", en: "" };
      const next = { ...current, [lang]: value };
      if (!next.zh.trim() && !next.en.trim()) delete draft.action[field];
      else draft.action[field] = next;
    });
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">按钮配置</p>
        <button
          type="button"
          onClick={() => actions.deleteButton(selected)}
          className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
        >
          删除该按钮
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium">按钮名称（发送的文本，最长 {CUSTOM_KEYBOARD_TEXT_MAX_LENGTH} 字符）</label>
          <input
            value={button.text}
            onChange={(event) =>
              update((draft) => void (draft.text = event.target.value.slice(0, CUSTOM_KEYBOARD_TEXT_MAX_LENGTH)))
            }
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">按钮类型</label>
          <select
            value={button.kind}
            onChange={(event) =>
              update((draft) => {
                draft.kind = event.target.value as CustomKeyboardButtonKind;
                if (draft.kind !== "web_app") delete draft.url;
              })
            }
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {KIND_OPTIONS.find((option) => option.value === button.kind)?.desc}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium">按钮样式（KeyboardButton.style）</label>
          <select
            value={button.style}
            onChange={(event) =>
              update((draft) => void (draft.style = event.target.value as CustomKeyboardButtonStyle))
            }
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2 pt-1">
            {STYLE_OPTIONS.map((option) => (
              <span key={option.value} className={`h-4 w-8 rounded ${option.swatch}`} title={option.label} />
            ))}
          </div>
        </div>
        {button.kind === "web_app" ? (
          <div className="space-y-1">
            <label className="block text-sm font-medium">WebApp 地址（https）</label>
            <input
              value={button.url ?? ""}
              onChange={(event) => update((draft) => void (draft.url = event.target.value))}
              placeholder="https://example.com/app"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            />
          </div>
        ) : null}
      </div>

      {button.kind === "text" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">点击后的交互</label>
          <select
            value={
              action?.type === "tgapi_func"
                ? `tgapi_func:${action.tgapi_func ?? "start"}`
                : action?.type ?? "none"
            }
            onChange={(event) => actions.changeActionType(selected, event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {isTgApi ? (
              <>
                {/* v2.3：TGAPI 固定指令前置 + 通用交互全量（与消息内嵌按钮/机器人管理页
                    同一动作模型；通用动作在 TGAPI 对话流程运行时真实承载） */}
                {TGAPI_MENU_FUNCS.map((item) => (
                  <option key={item.func} value={`tgapi_func:${item.func}`}>
                    {item.label}
                  </option>
                ))}
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === "submenu"
                      ? "进入子菜单（机器人发送子菜单键盘替换当前键盘）"
                      : option.value === "back"
                        ? "返回上一级菜单（机器人发送上一级键盘）"
                        : option.label}
                  </option>
                ))}
                <option value="language">语言切换（中文/English，点击即切换）</option>
                <option value="none">（无 —— 仅发送按钮文本，机器人不响应）</option>
              </>
            ) : (
              <>
                {/* v2.3：与消息内嵌按钮交互系统完全一致（ACTION_OPTIONS 单一来源） */}
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === "submenu"
                      ? "进入子菜单（机器人发送子菜单键盘替换当前键盘）"
                      : option.value === "back"
                        ? "返回上一级菜单（机器人发送上一级键盘）"
                        : option.label}
                  </option>
                ))}
                <option value="none">（无 —— 仅发送按钮文本，机器人不响应）</option>
              </>
            )}
          </select>
        </div>
      ) : null}

      {/* TGAPI 固定指令：解锁门禁开关（v2.2.0 保留项） */}
      {isTgApi && funcDef ? (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">{funcDef.hint}</p>
          {funcDef.func === "platform" ? (
            <div className="space-y-1 rounded-md border bg-background px-3 py-2">
              <label className="block text-sm font-medium">绑定的平台（tgapi_value）</label>
              <select
                value={action?.tgapi_value && isValidTgApiPlatformValue(action.tgapi_value) ? action.tgapi_value : ""}
                onChange={(event) =>
                  update((draft) => {
                    if (!draft.action) draft.action = defaultKeyboardAction();
                    if (event.target.value) draft.action.tgapi_value = event.target.value;
                    else delete draft.action.tgapi_value;
                  })
                }
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">（未绑定 —— 作为「设置平台」入口：点击后切换到平台键盘）</option>
                {Object.entries(TGAPI_PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
            <div className="min-w-0 pr-3">
              <p className="text-sm font-medium">🔒 首次对话解锁门禁</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                开启：未解锁用户点击该按钮时先进入验证码验证流程，通过后自动执行本按钮功能
                （解锁一次永久有效，任意按钮通过验证后所有按钮不再需要验证）。
                「指令 /createapi : 创建API」类按钮建议开启。
              </p>
            </div>
            <Switch
              checked={action?.tgapi_unlock === true}
              onCheckedChange={(checked) =>
                update((draft) => {
                  if (!draft.action) draft.action = defaultKeyboardAction();
                  if (checked) draft.action.tgapi_unlock = true;
                  else delete draft.action.tgapi_unlock;
                })
              }
              aria-label="首次对话解锁门禁"
            />
          </div>
        </>
      ) : null}

      {/* v2.3 门禁解锁（非 TGAPI 全交互类型通用，每按钮可选；与内嵌按钮同字段同语义） */}
      {!isTgApi && action ? (
        <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
          <div className="min-w-0 pr-3">
            <p className="text-sm font-medium">🔒 门禁解锁（点击先验证）</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              开启：未解锁用户点击该按钮时先完成门禁验证，通过后重新点击即执行本按钮功能
              （解锁一次永久有效，对该机器人的所有门禁入口通用）。验证方式在
              「功能配置 → 门禁解锁」面板配置；不开启 = 点击直接执行。
            </p>
          </div>
          <Switch
            checked={action.gateRequired === true}
            onCheckedChange={(checked) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "reply" };
                if (checked) draft.action.gateRequired = true;
                else delete draft.action.gateRequired;
              })
            }
            aria-label="门禁解锁"
          />
        </div>
      ) : null}

      {/* 通用机器人：回复内容配置（复用消息内嵌按钮的 ContentEditor） */}
      {action?.type === "reply" ? (
        <ContentEditor
          value={action.content ?? { type: "text", text: action.text ?? "", mediaUrl: "", items: [] }}
          onChange={(content: MenuMessageContent) =>
            update((draft) => {
              if (!draft.action) draft.action = { type: "reply" };
              draft.action.content = content;
              draft.action.text = content.text;
            })
          }
          mediaLabel="图片"
          storageKind="local"
        />
      ) : null}

      {/* 通用机器人：执行指令 */}
      {action?.type === "command" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">要执行的指令（不含 /）</label>
          <select
            value={action.target ?? ""}
            onChange={(event) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "command" };
                draft.action.target = event.target.value;
              })
            }
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="" disabled>
              请选择指令…
            </option>
            {[...state.builtinCommands, ...state.customCommands].map((option) => (
              <option key={option.name} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            点击键盘按钮等同用户发送 /指令：运行实例按指令名真实执行（内置指令 + 指令管理中启用的自定义指令）。
          </p>
        </div>
      ) : null}

      {/* 打开链接（URL）：ReplyKeyboard 按钮不支持原生 URL —— 运行时回复携带 InlineKeyboard URL 按钮 */}
      {action?.type === "url" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">链接地址（https）</label>
          <input
            value={action.url ?? ""}
            onChange={(event) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "url" };
                draft.action.url = event.target.value;
              })
            }
            placeholder="https://example.com"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            点击键盘按钮后机器人发送一条携带 URL 内联按钮的消息（ReplyKeyboard 按钮不支持原生 URL，这是真实 Telegram 的标准承载方式）。
          </p>
        </div>
      ) : null}

      {/* 打开 WebApp：运行时回复携带 InlineKeyboard web_app 按钮 */}
      {action?.type === "web_app" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">WebApp 地址（https）</label>
          <input
            value={action.url ?? ""}
            onChange={(event) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "web_app" };
                draft.action.url = event.target.value;
              })
            }
            placeholder="https://example.com/app"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            点击键盘按钮后机器人发送携带 WebApp 内联按钮的消息（私聊中点击直接打开 WebApp）。
            也可把「按钮类型」选为「打开 WebApp」获得原生键盘按钮（等价能力）。
          </p>
        </div>
      ) : null}

      {/* 外部验证 API：绑定验证方法 + 自定义文案（与内嵌按钮同一组件、同一数据源） */}
      {action?.type === "verify" ? (
        <div className="space-y-3">
          <TgApiUnlockMethodBinding
            initialMethods={(state.verificationMethods ?? []).map((method) => ({
              id: Number(method.id),
              name: method.name,
              enabled: method.enabled,
              type: method.type,
            }))}
            initialMethodId={action.verify?.method_id ? Number(action.verify.method_id) : null}
            typeFilter="code_api"
            onChange={(methodId) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "verify" };
                if (!draft.action.verify) draft.action.verify = { method_id: "" };
                draft.action.verify.method_id = methodId === null ? "" : String(methodId);
              })
            }
          />
          <div className="space-y-1">
            <label className="block text-sm font-medium">输入提示文案（点击按钮后先发送的提示）</label>
            <textarea
              value={action.verify?.input_hint_text ?? ""}
              onChange={(event) =>
                update((draft) => {
                  if (draft.action?.verify) draft.action.verify.input_hint_text = event.target.value;
                })
              }
              rows={2}
              placeholder="✍🏻 请在下方的输入框进行输入:（留空用默认）"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
      ) : null}

      {/* 切换内联查询 / 预填内容：运行时回复携带对应 InlineKeyboard 按钮 */}
      {action?.type === "switch_inline" || action?.type === "switch_inline_current" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">预填查询内容</label>
          <input
            value={action.switch_query ?? ""}
            onChange={(event) =>
              update((draft) => {
                if (!draft.action) draft.action = { type: "switch_inline" };
                draft.action.switch_query = event.target.value;
              })
            }
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            点击键盘按钮后机器人发送携带内联按钮的消息：switch_inline 切换到其他聊天并预填；
            switch_inline_current 在当前聊天输入框预填。
          </p>
        </div>
      ) : null}

      {/* 进入子菜单：嵌套子菜单键盘编辑器（递归；达深度上限不可再建） */}
      {action?.type === "submenu" ? (
        button.submenu ? (
          <SubmenuKeyboardEditor
            rows={button.submenu.rows}
            depth={(state.depth ?? 1) + 1}
            isTgApi={isTgApi}
            builtinCommands={state.builtinCommands}
            customCommands={state.customCommands}
            verificationMethods={state.verificationMethods ?? []}
            onChangeRows={(rows) =>
              update((draft) => {
                if (draft.submenu) draft.submenu.rows = rows;
              })
            }
            onDelete={() =>
              update((draft) => {
                delete draft.submenu;
              })
            }
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
            <span className="text-sm text-muted-foreground">该按钮还没有子菜单键盘。</span>
            <button
              type="button"
              disabled={(state.depth ?? 1) >= CUSTOM_KEYBOARD_MAX_DEPTH}
              onClick={() =>
                update((draft) => {
                  draft.submenu = { rows: [] };
                })
              }
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> 创建子菜单键盘
            </button>
            {(state.depth ?? 1) >= CUSTOM_KEYBOARD_MAX_DEPTH ? (
              <span className="text-sm text-red-600">已达到最大层级（{CUSTOM_KEYBOARD_MAX_DEPTH} 层）</span>
            ) : null}
          </div>
        )
      ) : null}

      {/* 返回上一级：运行时发送上一级键盘 */}
      {action?.type === "back" ? (
        <p className="text-sm text-muted-foreground">
          返回按钮将让机器人发送上一级键盘（子菜单返回父键盘；根键盘层级默认重发主键盘）。
        </p>
      ) : null}

      {/* TGAPI 指令消息配置（发送/成功/失败槽位，双语 {{变量}}） */}
      {isTgApi && funcDef && funcDef.slots.length > 0 ? (
        <div className="space-y-3 rounded-md border bg-background p-3">
          <div>
            <p className="text-sm font-medium">指令消息配置（{funcDef.label}）</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              各消息与指令固定实现剥离，全部可配置；中英文双语按用户语言发送，
              支持 {"{{user_id}} {{username}} {{first_name}} {{chat_id}}"} 等通用变量。
            </p>
          </div>
          {funcDef.slots.map((slot) => {
            const value = slotValue(slot.key);
            return (
              <div key={slot.key} className="space-y-1.5 rounded-md border bg-muted/20 p-3">
                <p className="text-sm font-medium">{slot.label}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {slot.desc}
                  {slot.vars ? `。可用变量：${slot.vars}` : ""}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  <textarea
                    value={value?.zh ?? ""}
                    onChange={(event) => setSlot(slot.key, "zh", event.target.value)}
                    rows={2}
                    placeholder={slot.defaultZh ? `默认：${slot.defaultZh}` : "（留空 = 不发送）"}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                  <textarea
                    value={value?.en ?? ""}
                    onChange={(event) => setSlot(slot.key, "en", event.target.value)}
                    rows={2}
                    placeholder={slot.defaultEn ? `Default: ${slot.defaultEn}` : "（留空 = 不发送）"}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 键盘选项编辑（resize/persistent/oneTime/input_field_placeholder） */
export function KeyboardOptionsEditor({
  options,
  onChange,
}: {
  options: CustomKeyboardConfig["options"];
  onChange: (next: CustomKeyboardConfig["options"]) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={options.resize}
          onChange={(event) => onChange({ ...options, resize: event.target.checked })}
          className="h-4 w-4"
        />
        resize_keyboard（按按钮自适应高度）
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={options.persistent}
          onChange={(event) => onChange({ ...options, persistent: event.target.checked })}
          className="h-4 w-4"
        />
        is_persistent（常驻显示）
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={options.oneTime}
          onChange={(event) => onChange({ ...options, oneTime: event.target.checked })}
          className="h-4 w-4"
        />
        one_time_keyboard（点击后收起）
      </label>
      <div className="space-y-1">
        <input
          value={options.inputPlaceholder}
          onChange={(event) => onChange({ ...options, inputPlaceholder: event.target.value.slice(0, 64) })}
          placeholder="输入框占位文案（可留空）"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        />
      </div>
    </div>
  );
}

/** 键盘按钮交互类型变更的通用实现（宿主弹窗 actions.changeActionType 内部调用） */
export function buildKeyboardActionForType(
  value: string,
  previous: MenuButtonAction | undefined,
): { action: MenuButtonAction | undefined; tgapiFunc?: string } {
  const [type, func] = value.split(":");
  if (type === "tgapi_func") {
    const isSameType = previous?.type === "tgapi_func";
    const next: MenuButtonAction = {
      type: "tgapi_func",
      tgapi_func: func ?? "start",
      tgapi_unlock: isSameType ? previous?.tgapi_unlock : true,
    };
    if (isSameType) {
      if (previous?.tgapi_response) next.tgapi_response = previous.tgapi_response;
      if (previous?.tgapi_success) next.tgapi_success = previous.tgapi_success;
      if (previous?.tgapi_fail) next.tgapi_fail = previous.tgapi_fail;
      if (previous?.tgapi_value) next.tgapi_value = previous.tgapi_value;
    }
    return { action: next, tgapiFunc: next.tgapi_func };
  }
  if (type === "reply") {
    return {
      action: { type: "reply", text: "你好！", content: { type: "text", text: "你好！", mediaUrl: "", items: [] } },
    };
  }
  if (type === "command") {
    return { action: { type: "command", target: "" } };
  }
  if (type === "language") {
    return { action: { type: "language" } };
  }
  if (type === "url") {
    return { action: { type: "url", text: "打开链接", url: "https://" } };
  }
  if (type === "web_app") {
    return { action: { type: "web_app", text: "打开 WebApp", url: "https://" } };
  }
  if (type === "verify") {
    return { action: { type: "verify", text: "验证", verify: { method_id: "" } } };
  }
  if (type === "switch_inline") {
    return { action: { type: "switch_inline", text: "分享", switch_query: "" } };
  }
  if (type === "switch_inline_current") {
    return { action: { type: "switch_inline_current", text: "预填内容", switch_query: "" } };
  }
  if (type === "submenu") {
    return { action: { type: "submenu", text: "子菜单" } };
  }
  if (type === "back") {
    return { action: { type: "back", text: "🔙 返回上一级" } };
  }
  return { action: undefined };
}

/**
 * 子菜单键盘编辑器（v2.3 递归组件）：复用 KeyboardRowList 编辑按钮的子菜单键盘，
 * 子菜单内还可以再建子菜单（深度上限 CUSTOM_KEYBOARD_MAX_DEPTH）。
 * ReplyKeyboard 语义：进入子菜单 = 机器人发送该子菜单键盘（整键盘替换）。
 */
function SubmenuKeyboardEditor({
  rows,
  depth,
  isTgApi,
  builtinCommands,
  customCommands,
  verificationMethods,
  onChangeRows,
  onDelete,
}: {
  rows: CustomKeyboardRow[];
  depth: number;
  isTgApi: boolean;
  builtinCommands: MenuCommandOption[];
  customCommands: MenuCommandOption[];
  verificationMethods: VerificationMethodOption[];
  onChangeRows: (rows: CustomKeyboardRow[]) => void;
  onDelete: () => void;
}) {
  const counter = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);

  const config = useMemo<CustomKeyboardConfig>(
    () => ({ options: emptyKeyboardOptions(), root: { rows } }),
    [rows],
  );
  const mutate = (mutator: (draft: CustomKeyboardConfig) => void): void => {
    const draft: CustomKeyboardConfig = JSON.parse(JSON.stringify(config));
    mutator(draft);
    onChangeRows(draft.root.rows);
  };

  const state: KeyboardDesignerState = {
    config,
    selected,
    isTgApi,
    builtinCommands,
    customCommands,
    verificationMethods,
    depth,
    actions: {
      addRow: () =>
        mutate((draft) => {
          if (draft.root.rows.length >= CUSTOM_KEYBOARD_MAX_ROWS) return;
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
          const button = findKeyboardButton(draft, buttonId);
          if (button) mutator(button);
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

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-primary/40 p-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1 text-sm font-medium">
          <ChevronRight className="h-4 w-4 text-primary" />
          子菜单键盘（第 {depth} 层，部署后点击该按钮由机器人发送本键盘替换当前键盘）
        </p>
        <ConfirmDialog
          trigger="删除子菜单"
          triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm text-red-600 hover:bg-red-50"
          title="删除该子菜单键盘？"
          description="子菜单内的全部按钮（含下级子菜单）将一并删除，删除后不可恢复。"
          confirmLabel="确认删除"
          onConfirm={onDelete}
        />
      </div>
      <KeyboardRowList state={state} />
    </div>
  );
}
