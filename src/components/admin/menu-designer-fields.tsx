"use client";

import { useMemo, useRef, useState } from "react";
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
import {
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_DEPTH,
  countMenuStats,
  type BotMenuConfig,
  type MenuActionType,
  type MenuButtonAction,
  type MenuNode,
} from "@/services/menu-config";

/**
 * 菜单设计器编辑区（可嵌入组件，v2.3 从 MenuDesignerDialog 抽取）：
 *
 * ContentEditor + NodeEditor + SelectedButtonPanel + 右侧 TgSimulator 实时预览 ——
 * 与机器人管理页「消息内嵌按钮」弹窗完全同一实现（交互/门禁解锁开关/指令库下拉逐字同源）。
 * config 由宿主受控（onChange 回传整份草稿），本组件只管理导航态（nodeId/selected）。
 *
 * 宿主：MenuDesignerDialog（独立弹窗）/ 机器人管理「功能配置」弹窗（嵌入平铺）。
 */
export function MenuDesignerFields({
  config,
  onChange,
  isTgApi = false,
  tgapiActionSource = "legacy",
  builtinCommands,
  customCommands,
  verificationMethods,
  storageKind,
  botName,
  botUsername,
  hideSimulator = false,
}: {
  config: BotMenuConfig;
  /** 任意编辑后回传整份新配置（宿主据此更新 hidden 表单字段） */
  onChange: (config: BotMenuConfig) => void;
  isTgApi?: boolean;
  tgapiActionSource?: "designer" | "legacy";
  builtinCommands: MenuCommandOption[];
  customCommands: MenuCommandOption[];
  verificationMethods: VerificationMethodOption[];
  storageKind: "cloudflare-r2" | "local";
  botName: string;
  botUsername: string | null;
  /** v2.3 嵌入宿主已自带右栏仿真屏时隐藏本组件内置预览（避免双仿真屏） */
  hideSimulator?: boolean;
}) {
  const [nodeId, setNodeId] = useState("root");
  const [selected, setSelected] = useState<{ path: string[]; buttonId: string } | null>(null);
  const counter = useRef(0);

  const mutateConfig = (mutator: (draft: BotMenuConfig) => void): void => {
    const draft: BotMenuConfig = JSON.parse(JSON.stringify(config));
    mutator(draft);
    onChange(draft);
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
          for (const row of findNode(draft.root, path).rows) {
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
    // config 变化时重建 actions（闭包读取最新 config 草稿）
    [nodeId, config],
  );

  const state: DesignerState = {
    config,
    selected,
    storageKind,
    isTgApi,
    tgapiActionSource,
    builtinCommands,
    customCommands,
    verificationMethods,
    actions,
  };

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
    <div
      className={
        hideSimulator ? "min-w-0 space-y-4" : "grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[1fr_430px]"
      }
    >
      <div className="min-w-0 space-y-4">
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <p className="text-sm font-semibold">菜单消息内容（同步到群组时随按钮一起发送）</p>
          <ContentEditor
            value={config.content}
            onChange={(content) => onChange({ ...config, content })}
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
            点击任意按钮可配置名称、交互行为与门禁解锁；选择「进入子菜单」后可直接创建下一级菜单
          </p>
        ) : null}
      </div>

      {!hideSimulator ? (
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <TgSimulator
            config={config}
            botName={botUsername ? `@${botUsername}` : botName}
            nodeId={nodeId}
            onNodeNavigate={setNodeId}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            当前预览：{nodeId === "root" ? "主菜单" : "子菜单"}（第 {previewDepth} 级）·
            点击仿真屏中按钮可像真实 Telegram 一样在同一消息内切换到子菜单
          </p>
        </div>
      ) : null}
    </div>
  );
}
