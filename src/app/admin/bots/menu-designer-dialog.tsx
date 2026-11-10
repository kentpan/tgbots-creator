"use client";

import { useMemo, useRef, useState } from "react";
import { ListTree } from "lucide-react";
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
  ContentEditor,
  NodeEditor,
  findNode,
  uid,
  type DesignerState,
  type MenuCommandOption,
  type VerificationMethodOption,
} from "@/components/admin/menu-designer-editor";
import { Switch } from "@/components/ui/switch";
import {
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_BUTTONS_TOTAL,
  MENU_MAX_DEPTH,
  countMenuStats,
  emptyMenuConfig,
  parseBotMenuConfig,
  type BotMenuConfig,
  type MenuActionType,
  type MenuButton,
  type MenuButtonAction,
  type MenuNode,
} from "@/services/menu-config";
import { saveBotMenuAction } from "./actions";

/**
 * 机器人管理页「消息内嵌按钮」弹窗（v2.1.16）：
 * 编辑器（ContentEditor/NodeEditor/SelectedButtonPanel）已抽取为
 * components/admin/menu-designer-editor.tsx 共享实现 —— 本文件只保留
 * 弹窗外壳、状态与操作实现；TGAPI申请 弹窗复用同一编辑器（文案/交互完全同源）。
 */

interface DesignerBot {
  id: string;
  name: string;
  menuConfig: string;
  menuText: string;
  username: string | null;
  privacyMode: boolean;
  /** TGAPI申请 机器人（v2.1.10）：v2.1.14 起仅影响「语言切换」按钮类型可见性 */
  isTgApi?: boolean;
}

export type { MenuCommandOption, VerificationMethodOption };

export function MenuDesignerDialog({
  bot,
  groups,
  storageKind,
  builtinCommands,
  customCommands,
  verificationMethods,
  trigger,
  triggerClassName,
}: {
  bot: DesignerBot;
  groups: { chatId: string; chatTitle: string | null }[];
  storageKind: "cloudflare-r2" | "local";
  /** 内置指令库（指令管理 → 内置指令，仅启用项；唯一来源指令库） */
  builtinCommands: MenuCommandOption[];
  /** 自定义指令库（指令管理 → 自定义指令，仅启用项）：供按钮「执行指令」选择 */
  customCommands: MenuCommandOption[];
  /** 验证方式库（v2.1.12）：「外部验证 API」按钮绑定验证方法下拉选项 */
  verificationMethods: VerificationMethodOption[];
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
      changeActionType: (path, buttonId, value) => {
        mutateConfig((draft) => {
          for (const row of findNode(draft.root, path).rows) {
            const button = row.buttons.find((item) => item.id === buttonId);
            if (!button) continue;
            const type = value as MenuActionType;
            const nextAction: MenuButtonAction = { type };
            if (type === "reply") {
              nextAction.text = "你好！";
              nextAction.content = { type: "text", text: "你好！", mediaUrl: "", items: [] };
            }
            if (type === "verify") {
              nextAction.verify = {
                method_id: "",
                input_hint_text: "",
                prompt_text: "",
                success_text: "",
                fail_text: "",
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
    isTgApi: bot.isTgApi === true,
    tgapiActionSource: "legacy",
    builtinCommands,
    customCommands,
    verificationMethods,
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
