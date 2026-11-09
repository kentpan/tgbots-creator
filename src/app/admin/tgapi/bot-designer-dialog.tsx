"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ListTree, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { TgApiBotGroupsPanel } from "@/components/admin/tgapi-bot-groups-panel";
import { TgApiMenuSimulator } from "@/components/admin/tgapi-menu-simulator";
import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";
import {
  defaultTgApiMenuRoot,
  isTgApiDesignerConfig,
  parseBotMenuConfig,
  TGAPI_MENU_FUNCS,
  type BotMenuConfig,
  type MenuButton,
  type MenuNode,
  type MenuRow,
} from "@/services/menu-config";
import {
  TGAPI_APP_PLATFORMS,
  TGAPI_DEFAULT_APP,
  TGAPI_TEXT_FIELD_KEYS,
  TGAPI_TEXTS_EN,
  TGAPI_TEXTS_ZH,
  type TgApiBotConfig,
} from "@/services/tgapi-config";
import { saveTgApiBotAction } from "./actions";

/**
 * TGAPI 申请机器人 新建/编辑弹窗（v2.1.16 设计器化改造）：
 *
 * 左侧配置区（自上而下）：
 * 1. 基本信息（名称 / Token / 启用开关）
 * 2. 🧭 机器人所在真实群组 + 右侧「申请加群」按钮（点击后右侧仿真屏恢复申请加群初始状态）
 * 3. 📱 my.telegram.org APP 创建参数（需求1：固定第 3 位，原有表单逐项保留）
 * 4. 💬 消息配置（中英文双语；START_TEXT 是初始消息欢迎语，仿真屏实时预览）
 * 5. 🔘 内嵌按钮配置（按钮行编辑 + 按钮面板：名称 / 交互（TGAPI 功能列表）/
 *    响应配置（中英双语 {{变量}}）/ 首次对话解锁门禁（每按钮可选））
 *
 * 右侧仿真屏：申请加群初始态 → 自动跳转私聊 → 初始消息+内嵌按钮 → 全流程交互仿真，
 * 与真实机器人（src/bot/handlers/tgapi.ts）流程一一对应。
 *
 * 存量机器人（需求7）：首次打开时按钮默认按图1生成（不迁移旧 menu_config 按钮文案，
 * menu_config 无 tgapiDesigner 标记即视为未迁移）；消息正文沿用其已自定义的欢迎语
 *（texts.zh.start / texts.en.start 的现值）。
 */

const PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  wp: "Windows Phone",
  bb: "BlackBerry",
  desktop: "桌面端",
  web: "Web",
  ubp: "Ubiquitous",
  other: "其他",
};

// 交互下拉框：TGAPI 功能项 value 用复合值（tgapi_func:<func>）区分三个功能，
// 否则 select 无法表达三个不同功能（且 React key 冲突）
const TGAPI_INTERACTION_OPTIONS: { value: string; label: string }[] = [
  ...TGAPI_MENU_FUNCS.map((item) => ({
    value: `tgapi_func:${item.func}`,
    label: item.label,
  })),
  { value: "language", label: "语言切换 : 中文/English（点击即切换）" },
  { value: "reply", label: "发送一条消息（文本）" },
  { value: "url", label: "打开链接（URL 按钮）" },
];

const TEMPLATE_VAR_HINT =
  "支持变量占位符：{{user_id}} {{username}} {{first_name}} {{last_name}} {{chat_id}} {{chat_title}} {{message_id}}";

function inputClassOf(): string {
  return "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
}

function uid(prefix: string, counter: { current: number }): string {
  counter.current += 1;
  return `${prefix}${Date.now().toString(36)}${counter.current}`;
}

function newRow(counter: { current: number }, buttons: MenuButton[]): MenuRow {
  return { id: uid("row", counter), buttons };
}

function newButton(counter: { current: number }, text: string): MenuButton {
  return {
    id: uid("btn", counter),
    text,
    action: { type: "tgapi_func", tgapi_func: "start", tgapi_unlock: false },
  };
}

export function TgApiBotDesignerDialog({
  bot,
  methods,
  defaultOpen = false,
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
  /** URL ?edit=1 时自动打开（机器人管理页「消息内嵌按钮」跳转入口） */
  defaultOpen?: boolean;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  // URL 跳转自动打开：defaultOpen 在挂载后置 open（受控 Dialog 在水合后应用，避免
  // SSR portal 与浏览器焦点管理的初始化时序问题）
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const cfg: TgApiBotConfig = useMemo(
    () =>
      bot
        ? (() => {
            try {
              const parsed = JSON.parse(bot.config) as { tgapi?: unknown };
              // 浏览器端无 normalizeTgApiSection 的服务端依赖，按表单所需字段读取
              const tgapi = (parsed.tgapi ?? {}) as Record<string, unknown>;
              return {
                enabled: tgapi.enabled === true,
                unlockMode: tgapi.unlockMode === "stars" ? ("stars" as const) : ("captcha" as const),
                verificationMethodId:
                  typeof tgapi.verificationMethodId === "number" ? tgapi.verificationMethodId : undefined,
                starsAmount: typeof tgapi.starsAmount === "number" ? tgapi.starsAmount : undefined,
                starsTitle: typeof tgapi.starsTitle === "string" ? tgapi.starsTitle : undefined,
                askAppDetails: tgapi.askAppDetails !== false,
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
              } satisfies TgApiBotConfig;
            } catch {
              return { enabled: false, unlockMode: "captcha" as const, askAppDetails: true, ...TGAPI_DEFAULT_APP };
            }
          })()
        : { enabled: false, unlockMode: "captcha" as const, askAppDetails: true, ...TGAPI_DEFAULT_APP },
    [bot],
  );
  const suffix = bot ? String(bot.id) : "new";
  const selectedPlatforms = useMemo(() => new Set(cfg.appPlatforms), [cfg.appPlatforms]);

  // 消息配置（需求6 中英双语；START_TEXT 实时同步仿真屏）
  const [zhStart, setZhStart] = useState(
    cfg.texts?.zh?.start?.trim() || TGAPI_TEXTS_ZH.start,
  );
  const [enStart, setEnStart] = useState(
    cfg.texts?.en?.start?.trim() || TGAPI_TEXTS_EN.start,
  );

  // 内嵌按钮（需求7：存量未迁移按图1默认生成）
  const counter = useRef(0);
  const [menuRoot, setMenuRoot] = useState<MenuNode>(() => {
    if (bot && isTgApiDesignerConfig(bot.menuConfig)) {
      const parsed = parseBotMenuConfig(bot.menuConfig);
      if (parsed.root.rows.length > 0) return parsed.root;
    }
    return defaultTgApiMenuRoot();
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const mutateRoot = (mutator: (draft: MenuNode) => void): void => {
    setMenuRoot((prev) => {
      const draft: MenuNode = JSON.parse(JSON.stringify(prev));
      mutator(draft);
      return draft;
    });
  };

  const selectedButton = useMemo<MenuButton | null>(() => {
    if (!selectedId) return null;
    for (const row of menuRoot.rows) {
      for (const button of row.buttons) {
        if (button.id === selectedId) return button;
      }
    }
    return null;
  }, [menuRoot, selectedId]);

  const updateSelected = (mutator: (draft: MenuButton) => void): void => {
    if (!selectedId) return;
    mutateRoot((draft) => {
      for (const row of draft.rows) {
        for (const button of row.buttons) {
          if (button.id === selectedId) {
            mutator(button);
            return;
          }
        }
      }
    });
  };

  const addRow = (): void => {
    mutateRoot((draft) => {
      draft.rows.push(newRow(counter, []));
    });
  };

  const addButton = (rowId: string): void => {
    const id = uid("btn", counter);
    mutateRoot((draft) => {
      for (const row of draft.rows) {
        if (row.id !== rowId) continue;
        row.buttons.push({
          id,
          text: `按钮 ${row.buttons.length + 1}`,
          action: { type: "tgapi_func", tgapi_func: "start", tgapi_unlock: false },
        });
        break;
      }
    });
    setSelectedId(id);
  };

  const deleteButton = (buttonId: string): void => {
    mutateRoot((draft) => {
      for (const row of draft.rows) {
        row.buttons = row.buttons.filter((item) => item.id !== buttonId);
      }
      draft.rows = draft.rows.filter((row) => row.buttons.length > 0);
    });
    setSelectedId(null);
  };

  const moveRow = (rowIndex: number, direction: -1 | 1): void => {
    mutateRoot((draft) => {
      const target = rowIndex + direction;
      if (target < 0 || target >= draft.rows.length) return;
      const [row] = draft.rows.splice(rowIndex, 1);
      draft.rows.splice(target, 0, row);
    });
  };

  const deleteRow = (rowId: string): void => {
    mutateRoot((draft) => {
      draft.rows = draft.rows.filter((row) => row.id !== rowId);
    });
    setSelectedId(null);
  };

  const changeInteraction = (composite: string): void => {
    const [type, func] = composite.split(":");
    if (type === "tgapi_func") {
      updateSelected((draft) => {
        // TGAPI 功能项之间切换（start/create/my）：保留按钮已配置的门禁开关与响应文案，
        // 仅更新功能名（重建 action 会把管理员已配置的 unlock/response 清掉）
        const isSameType = draft.action.type === "tgapi_func";
        draft.action = {
          type: "tgapi_func",
          tgapi_func: func ?? "start",
          tgapi_unlock: isSameType ? draft.action.tgapi_unlock : true,
          tgapi_response: isSameType
            ? draft.action.tgapi_response
            : { zh: draft.action.tgapi_response?.zh ?? "", en: draft.action.tgapi_response?.en ?? "" },
        };
        draft.submenu = undefined;
      });
      return;
    }
    updateSelected((draft) => {
      if (type === "language") {
        draft.action = { type: "language" };
      } else if (type === "reply") {
        draft.action = { type: "reply", text: "" };
      } else if (type === "url") {
        draft.action = { type: "url", url: "https://" };
      }
      draft.submenu = undefined;
    });
  };

  const simulatorConfig: BotMenuConfig = useMemo(
    () => ({
      content: { type: "text", text: zhStart, mediaUrl: "", items: [] },
      root: menuRoot,
    }),
    [zhStart, menuRoot],
  );

  const botDisplayName = bot?.username ? `@${bot.username}` : bot?.name ?? "TGAPI申请机器人";

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
            {bot ? `编辑 TGAPI 申请机器人 · ${bot.name}` : "新增 TGAPI 申请机器人"}
          </DialogTitle>
          <DialogDescription>
            左侧配置消息与内嵌按钮，右侧仿真屏完整预览：申请加群 → 自动跳转私聊 → 初始消息+按钮 →
            创建API（解锁门禁 → 手机号 → 登录码）→ 我的API。保存仅落库配置；上线/更新运行实例请到「仿真APP」页面部署。
          </DialogDescription>
        </DialogHeader>
        <form action={saveTgApiBotAction} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="id" value={bot ? String(bot.id) : ""} />
          <input type="hidden" name="menu_config" value={menuConfigPayload} />
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

                {/* 2. 真实群组 + 申请加群按钮（需求2） */}
                <div className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">2️⃣ 🧭 机器人所在真实群组</p>
                    <button
                      type="button"
                      onClick={() => setResetKey((prev) => prev + 1)}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/20"
                      title="右侧仿真屏恢复到申请加群的初始状态（群组界面 + 底部「申请加入群组」按钮）"
                    >
                      📲 申请加群
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    点「申请加群」：右侧仿真屏恢复申请加群初始状态 —— 点击「申请加入群组」模拟真实加群申请，
                    机器人自动通过后自动跳转到与机器人的私聊界面，所有流程与真实 APP 群组加群完全一致。
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

                {/* 3. my.telegram.org APP 创建参数（需求1：第 3 位，原有表单保留） */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
                  <p className="text-sm font-semibold">3️⃣ 📱 my.telegram.org APP 创建参数</p>
                  <div className="flex items-center gap-2">
                    <input
                      id={`ask-app-details-${suffix}`}
                      name="ask_app_details"
                      type="checkbox"
                      value="1"
                      defaultChecked={cfg.askAppDetails}
                      className="h-4 w-4"
                    />
                    <label className="text-sm font-medium" htmlFor={`ask-app-details-${suffix}`}>
                      申请人自定义 APP 名称与描述（开启后对话中先收集，/skip 使用默认；关闭则直接使用下方默认参数）
                    </label>
                  </div>
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
                          {PLATFORM_LABELS[platform] ?? platform}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 解锁门禁全局配置（验证方式绑定/星星参数：按钮级门禁开关在第5区按按钮配置） */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
                  <p className="text-sm font-semibold">🔐 解锁门禁配置（解锁方式与验证方式绑定）</p>
                  <p className="text-xs text-muted-foreground">
                    「首次对话解锁门禁」开关已移入第 5 区内嵌按钮配置（每按钮可选：开启后未解锁用户点击该按钮时
                    进入验证码验证流程，通过后自动执行该按钮功能；任意按钮通过验证后所有按钮不再需要验证）。
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor={`unlock-mode-${suffix}`}>
                        解锁方式
                      </label>
                      <select
                        id={`unlock-mode-${suffix}`}
                        name="unlock_mode"
                        defaultValue={cfg.unlockMode}
                        className={inputClassOf()}
                      >
                        <option value="captcha">验证码解锁（外部 API 核验，同加群验证）</option>
                        <option value="stars">星星解锁（Telegram Stars 支付）</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor={`stars-${suffix}`}>
                        星星解锁金额（⭐，星星解锁模式使用）
                      </label>
                      <input
                        id={`stars-${suffix}`}
                        name="stars_amount"
                        type="number"
                        min="1"
                        step="1"
                        defaultValue={cfg.starsAmount ?? 100}
                        className={inputClassOf()}
                      />
                    </div>
                  </div>
                  <TgApiUnlockMethodBinding
                    initialMethods={methods}
                    initialMethodId={cfg.verificationMethodId ?? null}
                  />
                  <div className="space-y-1">
                    <label className="text-sm font-medium" htmlFor={`stars-title-${suffix}`}>
                      发票标题（星星解锁模式使用）
                    </label>
                    <input
                      id={`stars-title-${suffix}`}
                      name="stars_title"
                      defaultValue={cfg.starsTitle ?? ""}
                      placeholder="默认：TGAPI 解锁"
                      className={inputClassOf()}
                    />
                  </div>
                </div>

                {/* 4. 消息配置（需求6：中英双语） */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                  <p className="text-sm font-semibold">
                    4️⃣ 💬 消息配置（中英文双语：按用户语言自动识别，「🌐 切换语言」按钮可手动切换）
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

                {/* 5. 内嵌按钮配置 */}
                <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">
                      5️⃣ 🔘 内嵌按钮配置（初始消息底部的按钮，仿真屏实时预览）
                    </p>
                    <button
                      type="button"
                      onClick={addRow}
                      className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-accent"
                    >
                      <Plus className="h-4 w-4" /> 添加一行
                    </button>
                  </div>
                  {menuRoot.rows.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                      还没有按钮：点击「添加一行」开始搭建（未配置任何按钮时机器人回落「🔐 授权认证」单按钮）
                    </p>
                  ) : null}
                  {menuRoot.rows.map((row, rowIndex) => (
                    <div key={row.id} className="rounded-lg border bg-background p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {row.buttons.map((button) => {
                          const isSelected = selectedId === button.id;
                          return (
                            <button
                              key={button.id}
                              type="button"
                              onClick={() => setSelectedId(button.id)}
                              className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm ${
                                isSelected
                                  ? "border-primary bg-primary/10 font-medium"
                                  : "hover:bg-accent"
                              }`}
                              title={button.text}
                            >
                              {button.text}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => addButton(row.id)}
                          className="rounded-md border border-dashed px-2 py-1.5 text-sm hover:bg-accent"
                        >
                          + 按钮
                        </button>
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveRow(rowIndex, -1)}
                            disabled={rowIndex === 0}
                            className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                            title="上移"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveRow(rowIndex, 1)}
                            disabled={rowIndex === menuRoot.rows.length - 1}
                            className="rounded border px-2 py-1 text-sm hover:bg-accent disabled:opacity-40"
                            title="下移"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteRow(row.id)}
                            className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                          >
                            删行
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* 选中按钮面板 */}
                  {selectedButton ? (
                    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">按钮配置</p>
                        <button
                          type="button"
                          onClick={() => deleteButton(selectedButton.id)}
                          className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                        >
                          删除该按钮
                        </button>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-sm font-medium">按钮名称</label>
                          <input
                            value={selectedButton.text}
                            onChange={(event) =>
                              updateSelected((draft) => void (draft.text = event.target.value))
                            }
                            className={inputClassOf()}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium">点击后的交互（TGAPI 功能列表）</label>
                          <select
                            value={
                              selectedButton.action.type === "tgapi_func"
                                ? `tgapi_func:${selectedButton.action.tgapi_func ?? "start"}`
                                : selectedButton.action.type
                            }
                            onChange={(event) => changeInteraction(event.target.value)}
                            className={inputClassOf()}
                          >
                            {TGAPI_INTERACTION_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {selectedButton.action.type === "tgapi_func" ? (
                        <>
                          {TGAPI_MENU_FUNCS.find(
                            (item) => item.func === selectedButton.action.tgapi_func,
                          ) ? (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {TGAPI_MENU_FUNCS.find(
                                (item) => item.func === selectedButton.action.tgapi_func,
                              )?.hint}
                            </p>
                          ) : null}

                          {/* 首次对话解锁门禁（需求：移入按钮配置，每按钮可选） */}
                          <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                            <div className="min-w-0 pr-3">
                              <p className="text-sm font-medium">🔒 首次对话解锁门禁</p>
                              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                开启：未解锁用户点击该按钮时先进入验证码验证流程，通过后自动执行本按钮功能
                                （解锁一次永久有效，任意按钮通过验证后所有按钮不再需要验证）。
                                「🗝 创建API」类按钮建议开启。
                              </p>
                            </div>
                            <Switch
                              checked={selectedButton.action.tgapi_unlock === true}
                              onCheckedChange={(checked) =>
                                updateSelected((draft) => {
                                  if (checked) draft.action.tgapi_unlock = true;
                                  else delete draft.action.tgapi_unlock;
                                })
                              }
                              aria-label="首次对话解锁门禁"
                            />
                          </div>

                          {/* 响应配置（需求5上轮：{{变量}} 占位符 + 中英双语） */}
                          <div className="space-y-2 rounded-md border bg-background p-3">
                            <p className="text-sm font-medium">
                              响应配置（点击按钮后机器人先发送的提示消息）
                            </p>
                            <p className="text-xs text-muted-foreground">{TEMPLATE_VAR_HINT}</p>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-muted-foreground">
                                中文响应
                              </label>
                              <textarea
                                value={selectedButton.action.tgapi_response?.zh ?? ""}
                                onChange={(event) =>
                                  updateSelected((draft) => {
                                    draft.action.tgapi_response = {
                                      zh: event.target.value,
                                      en: draft.action.tgapi_response?.en ?? "",
                                    };
                                  })
                                }
                                rows={2}
                                placeholder="🗝 正在为你创建 API，请稍候…（留空 = 点击后直接执行）"
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-muted-foreground">
                                English 响应
                              </label>
                              <textarea
                                value={selectedButton.action.tgapi_response?.en ?? ""}
                                onChange={(event) =>
                                  updateSelected((draft) => {
                                    draft.action.tgapi_response = {
                                      zh: draft.action.tgapi_response?.zh ?? "",
                                      en: event.target.value,
                                    };
                                  })
                                }
                                rows={2}
                                placeholder="🗝 Creating your API, please wait…"
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              />
                            </div>
                          </div>
                        </>
                      ) : null}

                      {selectedButton.action.type === "language" ? (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          语言切换按钮：点击后在 中文/English 之间切换并回复切换结果；语言偏好按会话记忆，
                          新会话按用户 Telegram 语言自动识别。
                        </p>
                      ) : null}

                      {selectedButton.action.type === "reply" ? (
                        <div className="space-y-1">
                          <label className="text-sm font-medium">回复内容（支持 {`{{username}}`} 等变量）</label>
                          <textarea
                            value={selectedButton.action.text ?? ""}
                            onChange={(event) =>
                              updateSelected((draft) => void (draft.action.text = event.target.value))
                            }
                            rows={3}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      ) : null}

                      {selectedButton.action.type === "url" ? (
                        <div className="space-y-1">
                          <label className="text-sm font-medium">链接地址（http/https）</label>
                          <input
                            value={selectedButton.action.url ?? ""}
                            onChange={(event) =>
                              updateSelected((draft) => void (draft.action.url = event.target.value))
                            }
                            placeholder="https://"
                            className={inputClassOf()}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
                      点击上方任意按钮可配置名称、交互与解锁门禁
                    </p>
                  )}
                </div>
              </div>

              {/* 右侧仿真屏 */}
              <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                <TgApiMenuSimulator
                  config={simulatorConfig}
                  welcome={{ zh: zhStart, en: enStart }}
                  botName={botDisplayName}
                  resetKey={resetKey}
                  askAppDetails={cfg.askAppDetails}
                  appDefaults={{ title: cfg.appTitle, description: cfg.appDescription }}
                />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  仿真流程与真实机器人完全一致：申请加入群组 → 自动通过并跳转私聊 → 初始消息+内嵌按钮 →
                  创建API（解锁门禁 → 手机号 → 登录码 → api_id/api_hash）→ 我的API → 切换语言。
                </p>
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
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              保存机器人
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
