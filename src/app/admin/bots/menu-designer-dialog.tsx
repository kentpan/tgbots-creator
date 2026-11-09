"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CornerDownRight,
  ListTree,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TgSimulator } from "@/components/admin/tg-simulator";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { MediaUploadButton } from "@/components/admin/media-upload-button";
import {
  isHttpUrl,
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_BUTTONS_TOTAL,
  MENU_MAX_DEPTH,
  MENU_MAX_MEDIA_ITEMS,
  MENU_MAX_ROWS,
  countMenuStats,
  emptyMenuConfig,
  parseBotMenuConfig,
  type BotMenuConfig,
  type MenuActionType,
  type MenuApiConfig,
  type MenuButton,
  type MenuButtonAction,
  type MenuMediaItem,
  type MenuMessageContent,
  type MenuNode,
} from "@/services/menu-config";
import { saveBotMenuAction } from "./actions";
import { Switch } from "@/components/ui/switch";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";

interface DesignerBot {
  id: string;
  name: string;
  menuConfig: string;
  menuText: string;
  username: string | null;
  privacyMode: boolean;
  /** TGAPI申请 机器人（v2.1.10）：指令选择器额外提供内置 start/language */
  isTgApi?: boolean;
}

/** 指令选择器可选项（v2.1.10）：内置指令 = 指令管理启用内置项 / TGAPI 机器人自有指令 */
export interface MenuCommandOption {
  name: string;
  label: string;
}

/**
 * 指令选择器（v2.1.10）：tab 切换「内置指令 / 自定义指令」。
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

const ACTION_OPTIONS: { value: MenuActionType; label: string }[] = [
  { value: "reply", label: "发送一条消息（文本/图文/视频/相册）" },
  { value: "submenu", label: "进入子菜单（在同一消息内切换按钮）" },
  { value: "back", label: "返回上一级菜单" },
  { value: "url", label: "打开链接（URL 按钮）" },
  { value: "web_app", label: "打开 WebApp" },
  { value: "command", label: "执行指令（点击等同用户发送 /指令）" },
  { value: "api", label: "调用外部接口并播报结果" },
  { value: "switch_inline", label: "切换到其他聊天的内联查询" },
  { value: "switch_inline_current", label: "在当前聊天输入框预填内容" },
];

function uid(prefix: string, counter: { current: number }): string {
  counter.current += 1;
  return `${prefix}${Date.now().toString(36)}${counter.current}`;
}

function findNode(root: MenuNode, path: string[]): MenuNode {
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

function findButton(root: MenuNode, path: string[], buttonId: string): MenuButton | null {
  const node = findNode(root, path);
  for (const row of node.rows) {
    const button = row.buttons.find((item) => item.id === buttonId);
    if (button) return button;
  }
  return null;
}

function ContentEditor({
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

function NodeEditor({
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
  const { config, selected, actions, builtinCommands, customCommands } = state;
  // 「从指令添加按钮」选择器（v2.1.10）：选中内置/自定义指令一键变成执行指令按钮
  const [pickedCommand, setPickedCommand] = useState("");
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

        {builtinCommands.length > 0 || customCommands.length > 0 ? (
          <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
            <span className="text-sm font-medium">从指令添加按钮：</span>
            <CommandPicker
              builtinCommands={builtinCommands}
              customCommands={customCommands}
              value={pickedCommand}
              onChange={setPickedCommand}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!pickedCommand}
                onClick={() => {
                  actions.addCommandButton(path, pickedCommand);
                  setPickedCommand("");
                }}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                + 添加为按钮
              </button>
              <span className="text-xs text-muted-foreground">
                按钮点击后机器人真实执行对应 /指令；指令在「指令管理」中维护
              </span>
            </div>
          </div>
        ) : null}

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

      {selected && selected.path.join("/") === path.join("/") ? <SelectedButtonPanel state={state} /> : null}
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
            value={action.type}
            onChange={(event) => actions.changeActionType(selected.path, selected.buttonId, event.target.value as MenuActionType)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {ACTION_OPTIONS.map((option) => (
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

      {action.type === "url" || action.type === "web_app" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium">链接地址（http/https）</label>
          <input
            value={action.url ?? ""}
            onChange={(event) => update((draft) => void (draft.action.url = event.target.value))}
            placeholder="https://"
            className={`flex h-10 w-full rounded-md border bg-background px-3 text-sm ${
              action.url && !isHttpUrl(action.url) ? "border-red-400" : "border-input"
            }`}
          />
        </div>
      ) : null}

      {action.type === "api" && action.api ? (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[110px_1fr_110px_110px]">
            <div className="space-y-1">
              <label className="block text-sm font-medium">方法</label>
              <select
                value={action.api.method}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.api) {
                      draft.action.api.method = event.target.value as MenuApiConfig["method"];
                    }
                  })
                }
                className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {["GET", "POST", "PUT", "DELETE"].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium">接口地址</label>
              <input
                value={action.api.url}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.api) draft.action.api.url = event.target.value;
                  })
                }
                placeholder="https://api.example.com/data"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium">期望状态码</label>
              <input
                type="number"
                value={action.api.success_status}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.api) {
                      draft.action.api.success_status = Number(event.target.value) || 200;
                    }
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium">超时（秒）</label>
              <input
                type="number"
                value={action.api.timeout_seconds}
                onChange={(event) =>
                  update((draft) => {
                    if (draft.action.api) {
                      draft.action.api.timeout_seconds = Number(event.target.value) || 10;
                    }
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium">请求头</label>
              <button
                type="button"
                onClick={() =>
                  update((draft) => {
                    if (draft.action.api) draft.action.api.headers.push({ key: "", value: "" });
                  })
                }
                className="rounded border px-2 py-1 text-sm hover:bg-accent"
              >
                + 请求头
              </button>
            </div>
            {action.api.headers.map((header, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  value={header.key}
                  onChange={(event) =>
                    update((draft) => {
                      if (draft.action.api) draft.action.api.headers[index].key = event.target.value;
                    })
                  }
                  placeholder="Header"
                  className="flex h-9 w-44 rounded-md border border-input bg-background px-3 text-sm"
                />
                <input
                  value={header.value}
                  onChange={(event) =>
                    update((draft) => {
                      if (draft.action.api) draft.action.api.headers[index].value = event.target.value;
                    })
                  }
                  placeholder="值（支持变量）"
                  className="flex h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() =>
                    update((draft) => {
                      if (draft.action.api) draft.action.api.headers.splice(index, 1);
                    })
                  }
                  className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                >
                  删
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium">请求体模板（GET 时作为查询串追加）</label>
            <textarea
              value={action.api.body_template}
              onChange={(event) =>
                update((draft) => {
                  if (draft.action.api) draft.action.api.body_template = event.target.value;
                })
              }
              rows={2}
              placeholder='{"chat_id":"{{chat_id}}"}'
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium">
              响应播报模板（把接口返回数据渲染成新消息发到群组）
            </label>
            <textarea
              value={action.api.response_template}
              onChange={(event) =>
                update((draft) => {
                  if (draft.action.api) draft.action.api.response_template = event.target.value;
                })
              }
              rows={3}
              placeholder="今日价格：{{res.data.price}}\n明细：{{res.data.list}}"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-sm text-muted-foreground">
              用 {"{{res.路径.字段}}"} 提取接口 JSON 返回；{"{{res}}"} 输出完整响应。
            </p>
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

interface DesignerState {
  config: BotMenuConfig;
  selected: { path: string[]; buttonId: string } | null;
  storageKind: "cloudflare-r2" | "local";
  /** 内置指令可选项（v2.1.10）：普通机器人=指令管理启用内置项；TGAPI=start/language */
  builtinCommands: MenuCommandOption[];
  /** 自定义指令可选项（v2.1.10）：指令管理中启用的自定义指令 */
  customCommands: MenuCommandOption[];
  actions: {
    addRow: (path: string[]) => void;
    moveRow: (path: string[], rowIndex: number, direction: -1 | 1) => void;
    deleteRow: (path: string[], rowId: string) => void;
    addButton: (path: string[], rowId: string) => void;
    addCommandButton: (path: string[], commandName: string) => void;
    selectButton: (path: string[], buttonId: string) => void;
    updateButton: (path: string[], buttonId: string, mutator: (draft: MenuButton) => void) => void;
    deleteButton: (path: string[], buttonId: string) => void;
    changeActionType: (path: string[], buttonId: string, type: MenuActionType) => void;
    createSubmenu: (path: string[], buttonId: string) => void;
    deleteSubmenu: (path: string[], buttonId: string) => void;
    enterSubmenu: (buttonId: string) => void;
  };
}

export function MenuDesignerDialog({
  bot,
  groups,
  storageKind,
  builtinCommands,
  customCommands,
  trigger,
  triggerClassName,
}: {
  bot: DesignerBot;
  groups: { chatId: string; chatTitle: string | null }[];
  storageKind: "cloudflare-r2" | "local";
  /** 内置指令库（指令管理 → 内置指令，仅启用项；TGAPI 机器人 = start/language 自有指令） */
  builtinCommands: MenuCommandOption[];
  /** 自定义指令库（指令管理 → 自定义指令，仅启用项）：供「从指令添加按钮」选择 */
  customCommands: MenuCommandOption[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const initial = useMemo<BotMenuConfig>(() => {
    const parsed = parseBotMenuConfig(bot.menuConfig);
    return parsed.root.rows.length > 0 ? parsed : emptyMenuConfig();
  }, [bot.menuConfig]);
  const [config, setConfig] = useState<BotMenuConfig>(initial);
  const [privacyMode, setPrivacyMode] = useState(bot.privacyMode);
  const [nodeId, setNodeId] = useState("root");
  const [selected, setSelected] = useState<{ path: string[]; buttonId: string } | null>(null);
  const [syncChatId, setSyncChatId] = useState("");
  const counter = useRef(0);

  const mutateConfig = (mutator: (draft: BotMenuConfig) => void): void => {
    setConfig((prev) => {
      const draft: BotMenuConfig = JSON.parse(JSON.stringify(prev));
      mutator(draft);
      return draft;
    });
  };

  const actions = useMemo<DesignerState["actions"]>(
    () => ({
      addRow: (path) => {
        const id = uid("r", counter);
        mutateConfig((draft) => {
          findNode(draft.root, path).rows.push({ id, buttons: [] });
        });
      },
      moveRow: (path, rowIndex, direction) => {
        mutateConfig((draft) => {
          const rows = findNode(draft.root, path).rows;
          const target = rowIndex + direction;
          if (target < 0 || target >= rows.length) return;
          const [row] = rows.splice(rowIndex, 1);
          rows.splice(target, 0, row);
        });
      },
      deleteRow: (path, rowId) => {
        mutateConfig((draft) => {
          const node = findNode(draft.root, path);
          node.rows = node.rows.filter((row) => row.id !== rowId);
        });
        setSelected(null);
      },
      addButton: (path, rowId) => {
        const id = uid("b", counter);
        mutateConfig((draft) => {
          const node = findNode(draft.root, path);
          for (const row of node.rows) {
            if (row.id !== rowId) continue;
            row.buttons.push({
              id,
              text: `按钮 ${row.buttons.length + 1}`,
              action: { type: "reply", text: "你好！" },
            });
            break;
          }
        });
        setSelected({ path, buttonId: id });
      },
      // v2.1.10「从指令添加按钮」：选中的指令一键变成「执行指令」按钮
      //（追加到末行有空位则追加，否则新建一行；按钮文本默认指令名，可后续改名）
      addCommandButton: (path, commandName) => {
        if (!commandName) return;
        const id = uid("b", counter);
        mutateConfig((draft) => {
          const node = findNode(draft.root, path);
          let targetRow = node.rows[node.rows.length - 1];
          if (targetRow && targetRow.buttons.length < MENU_MAX_BUTTONS_PER_ROW) {
            targetRow.buttons.push({
              id,
              text: commandName,
              action: { type: "command", target: commandName },
            });
            return;
          }
          targetRow = { id: uid("r", counter), buttons: [] };
          node.rows.push(targetRow);
          targetRow.buttons.push({
            id,
            text: commandName,
            action: { type: "command", target: commandName },
          });
        });
        setSelected({ path, buttonId: id });
      },
      selectButton: (path, buttonId) => setSelected({ path, buttonId }),
      updateButton: (path, buttonId, mutator) => {
        mutateConfig((draft) => {
          for (const row of findNode(draft.root, path).rows) {
            const button = row.buttons.find((item) => item.id === buttonId);
            if (button) {
              mutator(button);
              return;
            }
          }
        });
      },
      deleteButton: (path, buttonId) => {
        mutateConfig((draft) => {
          const node = findNode(draft.root, path);
          for (const row of node.rows) {
            row.buttons = row.buttons.filter((item) => item.id !== buttonId);
          }
        });
        setSelected(null);
        if (nodeId === buttonId) setNodeId(path.length > 0 ? path[path.length - 1] : "root");
      },
      changeActionType: (path, buttonId, type) => {
        mutateConfig((draft) => {
          for (const row of findNode(draft.root, path).rows) {
            const button = row.buttons.find((item) => item.id === buttonId);
            if (!button) continue;
            const nextAction: MenuButtonAction = { type };
            if (type === "reply") {
              nextAction.text = "你好！";
              nextAction.content = { type: "text", text: "你好！", mediaUrl: "", items: [] };
            }
            if (type === "api") {
              nextAction.api = {
                method: "GET",
                url: "",
                headers: [{ key: "Authorization", value: "Bearer " }],
                body_template: "",
                success_status: 200,
                timeout_seconds: 10,
                response_template: "接口返回：{{res}}",
              };
            }
            if (type === "url" || type === "web_app") nextAction.url = "https://";
            if (type === "switch_inline" || type === "switch_inline_current") nextAction.switch_query = "";
            if (type === "command") nextAction.target = "";
            button.action = nextAction;
            button.submenu = undefined;
            break;
          }
        });
      },
      createSubmenu: (path, buttonId) => {
        mutateConfig((draft) => {
          for (const row of findNode(draft.root, path).rows) {
            const button = row.buttons.find((item) => item.id === buttonId);
            if (!button) continue;
            button.submenu = { rows: [] };
            break;
          }
        });
        setNodeId(buttonId);
        setSelected({ path, buttonId });
      },
      deleteSubmenu: (path, buttonId) => {
        mutateConfig((draft) => {
          for (const row of findNode(draft.root, path).rows) {
            const button = row.buttons.find((item) => item.id === buttonId);
            if (!button) continue;
            button.submenu = undefined;
            button.action = { type: "reply", text: "该子菜单已被删除" };
            break;
          }
        });
        if (nodeId === buttonId) setNodeId("root");
      },
      enterSubmenu: (buttonId) => setNodeId(buttonId),
    }),
    [nodeId],
  );

  const state: DesignerState = {
    config,
    selected,
    storageKind,
    builtinCommands,
    customCommands,
    actions,
  };
  const stats = countMenuStats(config.root);
  const previewDepth = useMemo(() => {
    if (nodeId === "root") return 1;
    let found = 0;
    const walk = (node: MenuNode, depth: number): void => {
      for (const row of node.rows) {
        for (const button of row.buttons) {
          if (button.id === nodeId) {
            found = depth + 1;
            return;
          }
          if (button.submenu) walk(button.submenu, depth + 1);
        }
      }
    };
    walk(config.root, 1);
    return found || 1;
  }, [config, nodeId]);

  const previewApi = async (api: MenuApiConfig) => {
    if (!api || !api.url) return { ok: false, text: "接口未配置" };
    const response = await fetch("/api/admin/bots/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api }),
    });
    if (!response.ok) {
      return { ok: false, text: `预览请求失败（${response.status}）` };
    }
    return (await response.json()) as { ok: boolean; text: string };
  };

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
            消息内嵌按钮 · {bot.name}
          </DialogTitle>
          <DialogDescription>
            主菜单与子菜单树状配置：每个按钮可直接创建下一级子菜单；右侧 Telegram 仿真屏实时预览当前层级并可真实点击交互。
          </DialogDescription>
        </DialogHeader>
        <form action={saveBotMenuAction} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="id" value={bot.id} />
          <input type="hidden" name="menu_config" value={JSON.stringify(config)} />
          <input type="hidden" name="menu_text" value={config.content.text} />
          <input type="hidden" name="sync_chat_id" value={syncChatId} />
          <input type="hidden" name="privacyMode" value={privacyMode ? "1" : "0"} />
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
            <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]">
              <div className="min-w-0 space-y-4">
                <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-semibold">隐私模式（Privacy Mode）</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      开启：菜单交互仅通过按钮点击（callback，天然兼容 Telegram 隐私模式），机器人无需关闭隐私模式即可在群内使用全部按钮。
                      关闭：机器人将额外响应群内文本消息（宽松模式），需要已在 BotFather 关闭隐私模式。
                    </p>
                  </div>
                  <Switch checked={privacyMode} onCheckedChange={setPrivacyMode} aria-label="隐私模式" />
                </div>
                <div className="space-y-3 rounded-xl border bg-card p-4">
                  <p className="text-sm font-semibold">菜单消息内容（同步到群组时随按钮一起发送）</p>
                  <ContentEditor
                    value={config.content}
                    onChange={(content) => setConfig((prev) => ({ ...prev, content }))}
                    mediaLabel="图片"
                    storageKind={storageKind}
                  />
                </div>

                <NodeEditor
                  node={config.root}
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
                  state={state}
                  isRoot
                />

                {!selected ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                    点击任意按钮可配置名称与交互行为；选择「进入子菜单」后可直接创建下一级菜单
                  </p>
                ) : null}
              </div>

              <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                <TgSimulator
                  config={config}
                  botName={bot.username ? `@${bot.username}` : bot.name}
                  nodeId={nodeId}
                  onNodeNavigate={setNodeId}
                  onApiCall={previewApi}
                />
                <p className="mt-2 text-sm text-muted-foreground">
                  当前预览：{nodeId === "root" ? "主菜单" : "子菜单"}（第 {previewDepth} 级）·
                  点击仿真屏中按钮可像真实 Telegram 一样在同一消息内切换到子菜单
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
            <span className="mr-auto text-sm text-muted-foreground">
              共 {stats.buttons}/{MENU_MAX_BUTTONS_TOTAL} 个按钮 · {stats.submenus} 个子菜单 · {stats.depth} 层
            </span>
            <input
              list={`designer-groups-${bot.id}`}
              value={syncChatId}
              onChange={(event) => setSyncChatId(event.target.value)}
              placeholder="同步群组 Chat ID（可留空仅保存）"
              className="h-10 w-64 rounded-md border border-input bg-background px-3 text-sm"
            />
            <datalist id={`designer-groups-${bot.id}`}>
              {groups.map((group) => (
                <option key={group.chatId} value={group.chatId}>
                  {group.chatTitle ?? "群组"}
                </option>
              ))}
            </datalist>
            <button
              type="submit"
              onClick={() => setSyncChatId("")}
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              保存配置
            </button>
            <button
              type="submit"
              onClick={() => {
                if (!syncChatId.trim()) setSyncChatId(groups[0]?.chatId ?? "");
              }}
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              保存并同步到群组
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
