"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CornerDownRight,
  Plus,
  Trash2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { MediaUploadButton } from "@/components/admin/media-upload-button";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";
import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";
import {
  countMenuStats,
  isHttpUrl,
  isValidTgApiPlatformValue,
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_DEPTH,
  MENU_MAX_MEDIA_ITEMS,
  MENU_MAX_ROWS,
  TGAPI_MENU_FUNCS,
  TGAPI_PLATFORM_LABELS,
  type MenuActionType,
  type MenuButton,
  type MenuMediaItem,
  type MenuMessageContent,
  type MenuNode,
  type MenuTgApiResponse,
} from "@/services/menu-config";

/**
 * 消息内嵌按钮设计器共享编辑器（v2.1.16）：
 *
 * 机器人管理页「消息内嵌按钮」弹窗（menu-designer-dialog.tsx）与
 * TGAPI申请 弹窗（tgapi/bot-designer-dialog.tsx）的唯一实现 ——
 * ContentEditor / NodeEditor / SelectedButtonPanel / CommandPicker 完全同源，
 * 按钮文案、行/按钮 CRUD、子菜单树、交互下拉一字不差（图标与确认交互也一致）。
 *
 * TGAPI 差异全部通过 DesignerState.isTgApi 注入，机器人管理页渲染零变化：
 * - 交互下拉前置 TGAPI 固定指令列表（TGAPI_MENU_FUNCS，复合 value tgapi_func:<func>）；
 * - 选中 TGAPI 指令按钮时显示「首次对话解锁门禁」开关与「指令消息配置」
 *   （发送消息/成功消息/失败消息槽位，中英双语，支持 {{变量}} 占位符）。
 */

/** 指令选择器可选项：内置指令 = 指令管理启用内置项（唯一来源指令库） */
export interface MenuCommandOption {
  name: string;
  label: string;
}

/** 验证方式库条目（绑定验证方法下拉选项；code_api 类型才能用于菜单验证） */
export interface VerificationMethodOption {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

/**
 * 通用交互选项（机器人管理页）：与既有弹窗逐字一致，任何改动都会同时
 * 影响两个弹窗 —— 文案以机器人管理页为基准。
 */
export const ACTION_OPTIONS: { value: MenuActionType; label: string }[] = [
  { value: "reply", label: "发送一条消息（文本/图文/视频/相册）" },
  { value: "submenu", label: "进入子菜单（在同一消息内切换按钮）" },
  { value: "back", label: "返回上一级菜单" },
  { value: "url", label: "打开链接（URL 按钮）" },
  { value: "web_app", label: "打开 WebApp" },
  { value: "command", label: "执行指令（点击等同用户发送 /指令）" },
  { value: "verify", label: "外部验证 API（点击后要求回复验证码核验）" },
  { value: "switch_inline", label: "切换到其他聊天的内联查询" },
  { value: "switch_inline_current", label: "在当前聊天输入框预填内容" },
];

/** TGAPI 机器人专属交互：通用项 + 语言切换（原 menu-designer-dialog 的 TGAPI_ACTION_OPTIONS） */
const TGAPI_EXTRA_ACTION_OPTIONS: { value: MenuActionType; label: string }[] = [
  ...ACTION_OPTIONS,
  { value: "language", label: "语言切换（中文/English，点击即切换）" },
];

/**
 * TGAPI 弹窗交互选项（isTgApi 且由 TGAPI 弹窗挂载时使用）：
 * TGAPI 固定指令列表（TGAPI_MENU_FUNCS）前置，通用项文案与机器人管理页逐字一致。
 * 通用交互只保留 TGAPI 真实端真实支持的能力（子菜单/返回/URL/回复/语言切换）。
 */
export const TGAPI_INTERACTION_OPTIONS: { value: string; label: string }[] = [
  ...TGAPI_MENU_FUNCS.map((item) => ({
    value: `tgapi_func:${item.func}`,
    label: item.label,
  })),
  { value: "submenu", label: "进入子菜单（在同一消息内切换按钮）" },
  { value: "back", label: "返回上一级菜单" },
  { value: "url", label: "打开链接（URL 按钮）" },
  { value: "reply", label: "发送一条消息（文本/图文/视频/相册）" },
  { value: "language", label: "语言切换（中文/English，点击即切换）" },
];

/** TGAPI 指令消息槽位 key → MenuButtonAction 字段名 */
const TGAPI_SLOT_FIELDS = {
  response: "tgapi_response",
  success: "tgapi_success",
  fail: "tgapi_fail",
} as const;

export function uid(prefix: string, counter: { current: number }): string {
  counter.current += 1;
  return `${prefix}${Date.now().toString(36)}${counter.current}`;
}

export function findNode(root: MenuNode, path: string[]): MenuNode {
  let node = root;
  for (const buttonId of path) {
    let next: MenuNode | undefined;
    for (const row of node.rows) {
      for (const button of row.buttons) {
        if (button.id === buttonId && button.submenu) {
          next = button.submenu;
          break;
        }
      }
      if (next) break;
    }
    if (!next) return root;
    node = next;
  }
  return node;
}

export function findButton(root: MenuNode, path: string[], buttonId: string): MenuButton | null {
  const node = findNode(root, path);
  for (const row of node.rows) {
    const button = row.buttons.find((item) => item.id === buttonId);
    if (button) return button;
  }
  return null;
}

/**
 * 指令选择器：tab 切换「内置指令 / 自定义指令」。
 * 与「指令管理」页的双 tab 语义一致：内置 = 系统真实实现；自定义 = 指令管理中启用项。
 * 当前值属于哪个 tab 时自动定位初始 tab；两组都为空时给出明确引导。
 */
function CommandPicker({
  builtinCommands,
  customCommands,
  value,
  onChange,
}: {
  builtinCommands: MenuCommandOption[];
  customCommands: MenuCommandOption[];
  value: string;
  onChange: (name: string) => void;
}) {
  const valueIsBuiltin = builtinCommands.some((option) => option.name === value);
  const valueIsCustom = customCommands.some((option) => option.name === value);
  const [tab, setTab] = useState<string>(
    valueIsCustom && !valueIsBuiltin ? "custom" : "builtin",
  );
  if (builtinCommands.length === 0 && customCommands.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        暂无可用指令：请先在「指令管理」中启用内置指令或新增自定义指令。
      </p>
    );
  }
  const tabs: { key: string; label: string; options: MenuCommandOption[] }[] = [];
  if (builtinCommands.length > 0) {
    tabs.push({
      key: "builtin",
      label: `内置指令（${builtinCommands.length}）`,
      options: builtinCommands,
    });
  }
  if (customCommands.length > 0) {
    tabs.push({
      key: "custom",
      label: `自定义指令（${customCommands.length}）`,
      options: customCommands,
    });
  }
  const active = tabs.find((item) => item.key === tab) ?? tabs[0];
  return (
    <SelfContainedTabs
      ariaLabel="指令类型"
      items={tabs.map((item) => ({
        key: item.key,
        label: item.label,
        content: (
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="" disabled>
              请选择指令…
            </option>
            {item.options.map((option) => (
              <option key={option.name} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
        ),
      }))}
      activeKey={active.key}
      onActiveKeyChange={setTab}
    />
  );
}

export function ContentEditor({
  value,
  onChange,
  mediaLabel,
  storageKind,
}: {
  value: MenuMessageContent;
  onChange: (next: MenuMessageContent) => void;
  mediaLabel: string;
  storageKind: "cloudflare-r2" | "local";
}) {
  const patch = (partial: Partial<MenuMessageContent>): void => onChange({ ...value, ...partial });
  const patchItem = (index: number, partial: Partial<MenuMediaItem>): void => {
    const items = value.items.map((item, i) => (i === index ? { ...item, ...partial } : item));
    patch({ items });
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          <label className="block text-sm font-medium">内容类型</label>
          <select
            value={value.type}
            onChange={(event) => {
              const type = event.target.value as MenuMessageContent["type"];
              if (type === "media_group" && value.items.length === 0) {
                patch({
                  type,
                  items: [{ type: "photo", url: "", caption: "" }],
                });
              } else {
                patch({ type });
              }
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="text">文本消息</option>
            <option value="photo">单张图文（图片+文字）</option>
            <option value="video">单个视频（视频+文字）</option>
            <option value="media_group">相册（多张图片/视频）</option>
          </select>
          <p className="text-sm text-muted-foreground">
            {value.type === "text"
              ? "发送纯文本消息，支持 {{user_id}} 等变量。"
              : value.type === "photo"
                ? "sendPhoto 发送图片，文字作为图注。"
                : value.type === "video"
                  ? "sendVideo 发送视频，文字作为图注。"
                  : "sendMediaGroup 发送相册（最多 10 项，图片/视频可混排）。"}
          </p>
        </div>
        {value.type === "text" || value.type === "photo" || value.type === "video" ? (
          <div className="space-y-1">
            <label className="block text-sm font-medium">
              {value.type === "text" ? "消息文本" : "图注文字（可留空）"}
            </label>
            <textarea
              value={value.text}
              onChange={(event) => patch({ text: event.target.value })}
              rows={value.type === "text" ? 4 : 2}
              placeholder={value.type === "text" ? "📋 请使用下方菜单：" : "图注支持 {{username}} 等变量"}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        ) : null}
      </div>

      {value.type === "photo" || value.type === "video" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">{mediaLabel}地址（http/https，可点击右侧「上传」直接传文件）</label>
          <div className="flex items-start gap-2">
            <input
              value={value.mediaUrl}
              onChange={(event) => patch({ mediaUrl: event.target.value })}
              placeholder={value.type === "photo" ? "https://example.com/photo.jpg" : "https://example.com/video.mp4"}
              className={`h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm ${
                value.mediaUrl && !isHttpUrl(value.mediaUrl) ? "border-red-400" : "border-input"
              }`}
            />
            <MediaUploadButton
              kind={value.type === "photo" ? "photo" : "video"}
              storageKind={storageKind}
              onUploaded={(url) => patch({ mediaUrl: url })}
            />
          </div>
          {value.type === "photo" && value.mediaUrl && isHttpUrl(value.mediaUrl) ? (
              <img src={value.mediaUrl} alt="图片预览" className="mt-1 max-h-40 rounded-md border object-cover" />
          ) : null}
        </div>
      ) : null}

      {value.type === "media_group" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium">相册内容（{value.items.length}/{MENU_MAX_MEDIA_ITEMS}）</label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={value.items.length >= MENU_MAX_MEDIA_ITEMS}
                onClick={() => patch({ items: [...value.items, { type: "photo", url: "", caption: "" }] })}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> 图片
              </button>
              <button
                type="button"
                disabled={value.items.length >= MENU_MAX_MEDIA_ITEMS}
                onClick={() => patch({ items: [...value.items, { type: "video", url: "", caption: "" }] })}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> 视频
              </button>
            </div>
          </div>
          {value.items.map((item, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <select
                value={item.type}
                onChange={(event) => patchItem(index, { type: event.target.value as MenuMediaItem["type"] })}
                className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="photo">图片</option>
                <option value="video">视频</option>
              </select>
              <div className="flex min-w-48 flex-1 items-center gap-2">
                <input
                  value={item.url}
                  onChange={(event) => patchItem(index, { url: event.target.value })}
                  placeholder={item.type === "photo" ? "图片地址 https://" : "视频地址 https://"}
                  className={`h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm ${
                    item.url && !isHttpUrl(item.url) ? "border-red-400" : "border-input"
                  }`}
                />
                <MediaUploadButton
                  kind={item.type === "photo" ? "photo" : "video"}
                  storageKind={storageKind}
                  onUploaded={(url) => patchItem(index, { url })}
                />
              </div>
              <input
                value={item.caption}
                onChange={(event) => patchItem(index, { caption: event.target.value })}
                placeholder="图注（可留空）"
                className="h-9 min-w-32 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              />
              <button
                type="button"
                onClick={() => patch({ items: value.items.filter((_, i) => i !== index) })}
                className="inline-flex h-9 items-center rounded-md border border-red-200 px-2 text-sm text-red-600 hover:bg-red-50"
                title="删除该项"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            相册消息无法直接携带按钮键盘，同步到群组时会在相册后自动补发一条带按钮的消息。
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 编辑器消费的菜单配置结构（与 services/menu-config BotMenuConfig 同构） */
export interface DesignerMenuConfig {
  content: MenuMessageContent;
  root: MenuNode;
}

export interface DesignerState {
  config: DesignerMenuConfig;
  selected: { path: string[]; buttonId: string } | null;
  storageKind: "cloudflare-r2" | "local";
  /** TGAPI申请 机器人：true 时交互下拉前置 TGAPI 固定指令列表并提供指令消息槽位配置 */
  isTgApi: boolean;
  /**
   * 交互下拉选项来源（isTgApi=true 时生效）：
   * "designer" = TGAPI 弹窗（固定指令列表 + 真实端支持的通用项）；
   * "legacy" = 机器人管理页对 TGAPI 机器人的既有选项（通用项 + 语言切换）。
   */
  tgapiActionSource?: "designer" | "legacy";
  /** 内置指令可选项（唯一来源指令库启用内置项；/start 勾选后按 TGAPI 语义注册） */
  builtinCommands: MenuCommandOption[];
  /** 自定义指令可选项：指令管理中启用的自定义指令 */
  customCommands: MenuCommandOption[];
  /** 验证方式库：「外部验证 API」按钮绑定验证方法的下拉选项 */
  verificationMethods: VerificationMethodOption[];
  actions: {
    addRow: (path: string[]) => void;
    moveRow: (path: string[], rowIndex: number, direction: -1 | 1) => void;
    deleteRow: (path: string[], rowId: string) => void;
    addButton: (path: string[], rowId: string) => void;
    selectButton: (path: string[], buttonId: string) => void;
    updateButton: (path: string[], buttonId: string, mutator: (draft: MenuButton) => void) => void;
    deleteButton: (path: string[], buttonId: string) => void;
    /** 交互类型变更：TGAPI 指令为复合值（tgapi_func:<func>），由宿主弹窗解析 */
    changeActionType: (path: string[], buttonId: string, value: string) => void;
    createSubmenu: (path: string[], buttonId: string) => void;
    deleteSubmenu: (path: string[], buttonId: string) => void;
    enterSubmenu: (buttonId: string) => void;
  };
}

export function NodeEditor({
  node,
  levelName,
  path,
  depth,
  state,
  isRoot,
}: {
  node: MenuNode;
  levelName: React.ReactNode;
  path: string[];
  depth: number;
  state: DesignerState;
  isRoot: boolean;
}) {
  const { selected, actions } = state;
  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold">{levelName}</p>
          <div className="flex items-center gap-2">
            {!isRoot ? (
              <button
                type="button"
                onClick={() => actions.enterSubmenu(path[path.length - 1])}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent"
                title="在仿真屏中预览这一级按钮"
              >
                <ChevronRight className="h-4 w-4" /> 在仿真屏预览
              </button>
            ) : null}
            {!isRoot ? (
              <ConfirmDialog
                trigger={
                  <>
                    <Trash2 className="h-4 w-4" /> 删除该子菜单
                  </>
                }
                triggerClassName="inline-flex h-8 items-center gap-1 rounded-md border border-red-200 px-3 text-sm text-red-600 hover:bg-red-50"
                title="删除该子菜单？"
                description="该子菜单及其全部下级按钮将一并删除，删除后不可恢复。"
                confirmLabel="确认删除"
                onConfirm={() => actions.deleteSubmenu(path.slice(0, -1), path[path.length - 1])}
              />
            ) : null}
            <button
              type="button"
              onClick={() => actions.addRow(path)}
              disabled={node.rows.length >= MENU_MAX_ROWS}
              className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-50"
            >
              + 添加一行
            </button>
          </div>
        </div>

        {node.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            还没有按钮行，点击「添加一行」开始搭建{isRoot ? "主菜单" : "子菜单"}
          </p>
        ) : null}

        {node.rows.map((row, rowIndex) => (
          <div key={row.id}>
            <div className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {row.buttons.map((button) => {
                  const isSelected = selected && selected.path.join("/") === path.join("/") && selected.buttonId === button.id;
                  return (
                    <button
                      key={button.id}
                      type="button"
                      onClick={() => actions.selectButton(path, button.id)}
                      className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm ${
                        isSelected ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"
                      }`}
                      title={button.action.type === "submenu" && button.submenu ? `子菜单：${button.text}` : button.text}
                    >
                      {button.action.type === "submenu" && button.submenu ? (
                        <CornerDownRight className="h-3.5 w-3.5 text-primary" />
                      ) : null}
                      {button.text}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => actions.addButton(path, row.id)}
                  disabled={row.buttons.length >= MENU_MAX_BUTTONS_PER_ROW}
                  className="rounded-md border border-dashed px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  + 按钮
                </button>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => actions.moveRow(path, rowIndex, -1)}
                    disabled={rowIndex === 0}
                    className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                    title="上移"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.moveRow(path, rowIndex, 1)}
                    disabled={rowIndex === node.rows.length - 1}
                    className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                    title="下移"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.deleteRow(path, row.id)}
                    className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                  >
                    删行
                  </button>
                </div>
              </div>
            </div>

            {row.buttons
              .filter((button) => button.submenu)
              .map((button) => (
                <div key={`sub-${button.id}`} className="ml-6 mt-3 border-l-2 border-primary/30 pl-4">
                  <NodeEditor
                    node={button.submenu as MenuNode}
                    levelName={
                      <>
                        子菜单 · 来自按钮「{button.text}」
                        <span className="text-sm font-normal text-muted-foreground">（第 {depth + 1} 层）</span>
                      </>
                    }
                    path={[...path, button.id]}
                    depth={depth + 1}
                    state={state}
                    isRoot={false}
                  />
                </div>
              ))}
          </div>
        ))}
      </div>

      {/* key=按钮 id：切换选中按钮时强制重挂载 —— 内部「绑定验证方法」是非受控 state，
          不重挂载会把上一按钮的绑定带到新按钮上 */}
      {selected && selected.path.join("/") === path.join("/") ? (
        <SelectedButtonPanel key={selected.buttonId} state={state} />
      ) : null}
    </div>
  );
}

function SelectedButtonPanel({ state }: { state: DesignerState }) {
  const { config, selected, actions } = state;
  if (!selected) return null;
  const button = findButton(config.root, selected.path, selected.buttonId);
  if (!button) return null;
  const update = (mutator: (buttonDraft: MenuButton) => void): void =>
    actions.updateButton(selected.path, selected.buttonId, mutator);
  const action = button.action;
  const isTgApiDesigner = state.isTgApi && state.tgapiActionSource === "designer";
  const funcDef = isTgApiDesigner && action.type === "tgapi_func"
    ? TGAPI_MENU_FUNCS.find((item) => item.func === action.tgapi_func)
    : undefined;

  /** 读取 TGAPI 指令消息槽位当前值 */
  const slotValue = (key: "response" | "success" | "fail"): MenuTgApiResponse | undefined => {
    if (key === "response") return action.tgapi_response;
    if (key === "success") return action.tgapi_success;
    return action.tgapi_fail;
  };
  /** 写入 TGAPI 指令消息槽位（双语全空 = 删除字段，不落库空配置） */
  const setSlot = (key: "response" | "success" | "fail", lang: "zh" | "en", value: string): void => {
    update((draft) => {
      const field = TGAPI_SLOT_FIELDS[key];
      const current = draft.action[field] ?? { zh: "", en: "" };
      const next = { ...current, [lang]: value };
      if (!next.zh.trim() && !next.en.trim()) delete draft.action[field];
      else draft.action[field] = next;
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">
          按钮配置
          {selected.path.length > 0 ? (
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              （位于第 {selected.path.length + 1} 层子菜单）
            </span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => actions.deleteButton(selected.path, selected.buttonId)}
          className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
        >
          删除该按钮
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium">按钮名称</label>
          <input
            value={button.text}
            onChange={(event) => update((draft) => void (draft.text = event.target.value))}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium">点击后的交互</label>
          <select
            value={action.type === "tgapi_func" ? `tgapi_func:${action.tgapi_func ?? "start"}` : action.type}
            onChange={(event) => actions.changeActionType(selected.path, selected.buttonId, event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {(isTgApiDesigner
              ? TGAPI_INTERACTION_OPTIONS
              : state.isTgApi
                ? TGAPI_EXTRA_ACTION_OPTIONS
                : ACTION_OPTIONS
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {action.type === "reply" ? (
        <ContentEditor
          value={
            action.content ?? { type: "text", text: action.text ?? "", mediaUrl: "", items: [] }
          }
          onChange={(content) =>
            update((draft) => {
              draft.action.content = content;
              draft.action.text = content.text;
            })
          }
          mediaLabel="图片"
          storageKind={state.storageKind}
        />
      ) : null}

      {action.type === "submenu" ? (
        button.submenu ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3">
            <span className="text-sm">
              已创建子菜单（当前共 {countMenuStats(button.submenu).buttons} 个按钮，含嵌套）
            </span>
            <button
              type="button"
              onClick={() => actions.enterSubmenu(button.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent"
            >
              <ChevronRight className="h-4 w-4" /> 编辑子菜单并在仿真屏预览
            </button>
            <ConfirmDialog
              trigger="删除子菜单"
              triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm text-red-600 hover:bg-red-50"
              title={`删除按钮「${button.text}」的子菜单？`}
              description="该子菜单及其全部下级按钮将一并删除，删除后不可恢复。"
              confirmLabel="确认删除"
              onConfirm={() => actions.deleteSubmenu(selected.path, button.id)}
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
            <span className="text-sm text-muted-foreground">该按钮还没有子菜单。</span>
            <button
              type="button"
              disabled={selected.path.length + 1 >= MENU_MAX_DEPTH}
              onClick={() => actions.createSubmenu(selected.path, button.id)}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> 创建子菜单（并实时预览）
            </button>
            {selected.path.length + 1 >= MENU_MAX_DEPTH ? (
              <span className="text-sm text-red-600">已达到最大层级（{MENU_MAX_DEPTH} 层）</span>
            ) : null}
          </div>
        )
      ) : null}

      {action.type === "back" ? (
        <p className="text-sm text-muted-foreground">
          返回按钮将回到进入当前菜单前的上一级菜单（主菜单层级默认回到主菜单）。
        </p>
      ) : null}

      {action.type === "language" ? (
        <p className="text-sm text-muted-foreground">
          语言切换按钮（TGAPI 申请机器人）：点击后在 中文/English 之间切换并回复切换结果；
          语言偏好按会话记忆，新会话按用户 Telegram 语言自动识别。
        </p>
      ) : null}

      {action.type === "command" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">要执行的指令</label>
          <CommandPicker
            builtinCommands={state.builtinCommands}
            customCommands={state.customCommands}
            value={action.target ?? ""}
            onChange={(name) => update((draft) => void (draft.action.target = name))}
          />
          <p className="text-xs text-muted-foreground">
            点击按钮等同于用户发送 /指令：运行实例按指令名真实执行（内置指令 + 指令管理中启用的自定义指令）。
          </p>
        </div>
      ) : null}

      {funcDef ? (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">{funcDef.hint}</p>

          {/* 平台指令：选择按钮绑定的平台值（子菜单平台按钮；提交 APP 创建时优先使用） */}
          {funcDef.func === "platform" ? (
            <div className="space-y-1 rounded-md border bg-background px-3 py-2">
              <label className="block text-sm font-medium">绑定的平台（tgapi_value）</label>
              <select
                value={
                  action.tgapi_value && isValidTgApiPlatformValue(action.tgapi_value)
                    ? action.tgapi_value
                    : ""
                }
                onChange={(event) =>
                  update((draft) => {
                    if (event.target.value) draft.action.tgapi_value = event.target.value;
                    else delete draft.action.tgapi_value;
                  })
                }
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">（未绑定 —— 作为入口按钮使用）</option>
                {Object.entries(TGAPI_PLATFORM_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="text-xs leading-relaxed text-muted-foreground">
                绑定平台值的按钮点击后直接记住该平台（用于创建 APP 提交）；
                未绑定的按钮作为「设置平台」入口（展开子菜单或平台键盘）。
              </p>
            </div>
          ) : null}

          {/* 首次对话解锁门禁（TGAPI 每按钮可选） */}
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
              checked={action.tgapi_unlock === true}
              onCheckedChange={(checked) =>
                update((draft) => {
                  if (checked) draft.action.tgapi_unlock = true;
                  else delete draft.action.tgapi_unlock;
                })
              }
              aria-label="首次对话解锁门禁"
            />
          </div>

          {/* 指令消息配置（v2.1.16）：把该指令的发送/成功/失败消息剥离为可配置模板（双语 {{变量}}） */}
          {funcDef.slots.length > 0 ? (
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
        </>
      ) : null}

      {action.type === "verify" ? (
        <div className="space-y-3">
          {/* 复用图2红框同款「绑定验证方法 + 配置外部验证 API」组件（验证方式库同一数据源）；
              绑定结果经 onChange 同步回菜单按钮 action.verify.method_id 随菜单配置一并保存 */}
          <TgApiUnlockMethodBinding
            initialMethods={state.verificationMethods.map((method) => ({
              id: Number(method.id),
              name: method.name,
              enabled: method.enabled,
              type: method.type,
            }))}
            initialMethodId={action.verify?.method_id ? Number(action.verify.method_id) : null}
            typeFilter="code_api"
            autoCreateName="菜单验证核验（外部API）"
            source="menu"
            onChange={(methodId) =>
              update((draft) => {
                if (draft.action.verify) {
                  draft.action.verify.method_id = methodId === null ? "" : String(methodId);
                }
              })
            }
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            与群组外部 API 验证同一机制：验证 API 地址 / Bearer apikey / 传参 / 响应解析 /
            超时在上方「配置外部验证 API」中编辑并保存到「验证方式」库（同一数据源）；
            点击按钮后在输入框回复验证码真实核验。
          </p>
          <div className="space-y-1">
            <label className="block text-sm font-medium">输入提示文案（点击按钮后先发送的提示）</label>
            <textarea
              value={action.verify?.input_hint_text ?? ""}
              onChange={(event) =>
                update((draft) => {
                  if (draft.action.verify) draft.action.verify.input_hint_text = event.target.value;
                })
              }
              rows={2}
              placeholder="✍🏻 请在下方的输入框进行输入:（留空用默认）"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium">提示文案（force-reply 输入框提示）</label>
            <textarea
              value={action.verify?.prompt_text ?? ""}
              onChange={(event) =>
                update((draft) => {
                  if (draft.action.verify) draft.action.verify.prompt_text = event.target.value;
                })
              }
              rows={2}
              placeholder="🔐 请回复本消息并输入验证码完成验证（留空用默认）"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-sm font-medium">成功文案</label>
              <textarea
                value={action.verify?.success_text ?? ""}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.verify) draft.action.verify.success_text = event.target.value;
                  })
                }
                rows={2}
                placeholder="✅ 验证成功！（留空用默认）"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium">失败文案</label>
              <textarea
                value={action.verify?.fail_text ?? ""}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.verify) draft.action.verify.fail_text = event.target.value;
                  })
                }
                rows={2}
                placeholder="❌ 验证失败（留空用默认，自动附带核验未通过原因与剩余次数）"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
      ) : null}

      {action.type === "switch_inline" || action.type === "switch_inline_current" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">预填查询内容</label>
          <input
            value={action.switch_query ?? ""}
            onChange={(event) => update((draft) => void (draft.action.switch_query = event.target.value))}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
      ) : null}
    </div>
  );
}
