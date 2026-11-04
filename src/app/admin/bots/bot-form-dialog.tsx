"use client";

import { useCallback, useEffect, useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
import { AiModelSelect } from "@/components/admin/ai-model-select";
import { useRealGroups } from "@/components/admin/use-real-groups";
import { Switch } from "@/components/ui/switch";
import { saveBotAction } from "./actions";

export interface BotFormData {
  id: string;
  name: string;
  token: string;
  username: string | null;
  enabled: boolean;
  config: string;
}

interface PluginsState {
  autoRetry: boolean;
  throttler: boolean;
  sessionStorage: string;
}

interface AiSupportState {
  enabled: boolean;
  modelSelection: string;
  scope: string;
  systemPrompt: string;
}

interface MenuButtonState {
  type: "default" | "commands" | "web_app";
  text: string;
  url: string;
}

interface MeInfo {
  id: number;
  username: string;
  first_name: string;
  supports_inline_queries: boolean;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  can_connect_to_business: boolean;
  has_main_web_app: boolean;
}

function readProfile(config: string): {
  my_name?: string;
  description?: string;
  short_description?: string;
  commands?: { command: string; description: string }[];
  menuButton?: { type?: string; text?: string; url?: string };
  defaultAdminRights?: { group?: Record<string, boolean>; channel?: Record<string, boolean> };
  plugins?: { autoRetry?: boolean; throttler?: boolean; sessionStorage?: string };
  aiSupport?: { enabled?: boolean; modelSelection?: string; scope?: string; systemPrompt?: string };
} {
  try {
    return JSON.parse(config) as Record<string, never>;
  } catch {
    return {};
  }
}

const SESSION_STORAGE_OPTIONS = [
  { value: "inherit", label: "跟随全局配置（系统设置 → BOT 数据存储）" },
  { value: "memory", label: "内存（重启丢失）" },
  { value: "sqlite", label: "SQLite（本地 bot_sessions 表）" },
  { value: "d1", label: "Cloudflare D1" },
  { value: "r2", label: "Cloudflare R2" },
  { value: "s3", label: "S3 兼容对象存储（AWS / MinIO / R2 通用）" },
];

const AI_SCOPE_OPTIONS = [
  { value: "private_mention", label: "私聊 + 群内 @机器人（推荐）" },
  { value: "private", label: "仅私聊" },
  { value: "all", label: "全部消息（注意 API 消耗）" },
];

const MENU_BUTTON_OPTIONS = [
  { value: "default", label: "默认（打开命令列表菜单）" },
  { value: "commands", label: "命令列表（显式指令菜单）" },
  { value: "web_app", label: "Mini App 按钮（打开网页应用）" },
] as const;

/** 群组默认管理员权限字段（setMyDefaultAdministratorRights for_channels=false） */
const GROUP_RIGHT_FIELDS: { key: string; label: string }[] = [
  { key: "can_manage_chat", label: "管理聊天（管理菜单入口）" },
  { key: "can_delete_messages", label: "删除消息" },
  { key: "can_restrict_members", label: "封禁/限制用户" },
  { key: "can_invite_users", label: "邀请用户" },
  { key: "can_pin_messages", label: "置顶消息" },
  { key: "can_change_info", label: "修改群组信息" },
  { key: "can_manage_video_chats", label: "管理视频会议" },
  { key: "can_promote_members", label: "添加新管理员" },
  { key: "can_post_messages", label: "发布消息" },
  { key: "can_edit_messages", label: "编辑消息" },
  { key: "can_manage_topics", label: "管理话题" },
  { key: "is_anonymous", label: "匿名身份（以群组身份发言）" },
];

/** 频道默认管理员权限字段（setMyDefaultAdministratorRights for_channels=true） */
const CHANNEL_RIGHT_FIELDS: { key: string; label: string }[] = [
  { key: "can_post_messages", label: "发布消息" },
  { key: "can_edit_messages", label: "编辑消息" },
  { key: "can_delete_messages", label: "删除消息" },
  { key: "can_invite_users", label: "邀请用户" },
  { key: "can_restrict_members", label: "限制成员" },
  { key: "can_promote_members", label: "添加新管理员" },
  { key: "can_change_info", label: "修改频道信息" },
  { key: "can_post_stories", label: "发布故事" },
  { key: "can_edit_stories", label: "编辑故事" },
  { key: "can_delete_stories", label: "删除故事" },
  { key: "is_anonymous", label: "匿名身份" },
];

/** 群管机器人推荐预设（TGuard 验证所需的最小权限集合） */
const GROUP_RIGHTS_PRESET: Record<string, boolean> = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_restrict_members: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_change_info: false,
  can_manage_video_chats: false,
  can_promote_members: false,
  can_post_messages: false,
  can_edit_messages: false,
  can_manage_topics: false,
  is_anonymous: false,
};

type RightsMap = Record<string, boolean>;

const toggleButtonClass =
  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary";
const toggleThumbClass =
  "pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5";

function RightsCard({
  title,
  description,
  fields,
  value,
  onChange,
  preset,
}: {
  title: string;
  description: string;
  fields: { key: string; label: string }[];
  value: RightsMap | null;
  onChange: (next: RightsMap | null) => void;
  preset?: RightsMap;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch checked={value !== null} onCheckedChange={(checked) => onChange(checked ? { ...(preset ?? {}) } : null)} />
      </div>
      {value !== null ? (
        <div className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={value[field.key] === true}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.checked })}
                className="h-3.5 w-3.5 rounded border-input accent-[oklch(0.205_0_0)]"
              />
              <span>{field.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BotFormDialog({
  bot,
  trigger,
  triggerClassName,
}: {
  bot?: BotFormData;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const profile = bot ? readProfile(bot.config) : {};
  const commandsText = (profile.commands ?? [])
    .map((command) => `/${command.command} ${command.description}`)
    .join("\n");

  const [nameValue, setNameValue] = useState(bot?.name ?? "");
  const [enabled, setEnabled] = useState(bot ? bot.enabled : true);
  const [plugins, setPlugins] = useState<PluginsState>({
    autoRetry: profile.plugins?.autoRetry !== false,
    throttler: profile.plugins?.throttler !== false,
    sessionStorage: profile.plugins?.sessionStorage ?? "inherit",
  });
  const [aiSupport, setAiSupport] = useState<AiSupportState>({
    enabled: profile.aiSupport?.enabled ?? false,
    modelSelection: profile.aiSupport?.modelSelection ?? "auto",
    scope: profile.aiSupport?.scope ?? "private_mention",
    systemPrompt: profile.aiSupport?.systemPrompt ?? "",
  });
  const [menuButton, setMenuButton] = useState<MenuButtonState>({
    type: (profile.menuButton?.type === "web_app" || profile.menuButton?.type === "commands"
      ? profile.menuButton?.type
      : "default") as MenuButtonState["type"],
    text: profile.menuButton?.text ?? "",
    url: profile.menuButton?.url ?? "",
  });
  const [groupRights, setGroupRights] = useState<RightsMap | null>(
    profile.defaultAdminRights?.group ?? null,
  );
  const [channelRights, setChannelRights] = useState<RightsMap | null>(
    profile.defaultAdminRights?.channel ?? null,
  );

  // getMe 自动获取机器人身份与 BotFather 只读能力开关
  const [meInfo, setMeInfo] = useState<MeInfo | null>(null);
  const [meFetching, setMeFetching] = useState(false);
  const [meError, setMeError] = useState<string | null>(null);

  // 已加入的真实群组（v1.1.1）：与「机器人测试」页共用统一获取 Hook + API
  // 打开弹窗只读取数据库已登记群组（零 Telegram 请求）；点「同步真实群组」才实时校验
  const realGroups = useRealGroups({ botId: bot?.id ?? null });

  const fetchMe = useCallback(
    async (tokenOverride?: string): Promise<void> => {
      setMeFetching(true);
      setMeError(null);
      try {
        const response = await fetch("/api/admin/bots/fetch-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenOverride, botId: bot?.id }),
        });
        // 容错解析：空响应体 / 非 JSON（如 500 错误页）不再抛 "Unexpected end of JSON input"
        const rawText = await response.text();
        type FetchInfoPayload = { ok: boolean; data?: MeInfo; error?: string };
        let payload: FetchInfoPayload | null = null;
        try {
          payload = rawText.trim() ? (JSON.parse(rawText) as FetchInfoPayload) : null;
        } catch {
          payload = null;
        }
        if (!payload) {
          setMeError(`服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
          return;
        }
        if (payload.ok && payload.data) {
          setMeInfo(payload.data);
          setNameValue((prev) => (prev.trim() ? prev : payload.data!.first_name || `@${payload.data!.username}`));
        } else {
          setMeError(payload.error ?? "获取失败");
        }
      } catch (error) {
        setMeError(error instanceof Error ? error.message : "网络异常");
      } finally {
        setMeFetching(false);
      }
    },
    [bot?.id],
  );

  // 编辑模式：弹窗挂载即自动获取（复用已保存 Token）
  useEffect(() => {
    if (bot?.token) {
      void fetchMe();
    }
  }, [bot?.token, fetchMe]);

  const pluginsJson = JSON.stringify(plugins);
  const aiSupportJson = JSON.stringify(aiSupport);
  const menuButtonJson = JSON.stringify(menuButton);
  const defaultAdminRightsJson = JSON.stringify({ group: groupRights, channel: channelRights });
  const idSuffix = bot?.id ?? "new";

  const botFatherRows: {
    name: string;
    desc: string;
    path: string;
    status: boolean | null;
    statusLabel?: [string, string];
  }[] = [
    {
      name: "Inline Mode（内联模式）",
      desc: "允许用户在任意聊天输入框中 @机器人 搜索",
      path: "Bot Settings → Inline Mode",
      status: meInfo ? meInfo.supports_inline_queries : null,
      statusLabel: ["已开启", "未开启"],
    },
    {
      name: "Inline Location Data",
      desc: "内联查询是否附带位置数据请求",
      path: "Bot Settings → Inline Location Data",
      status: null,
    },
    {
      name: "Inline Feedback",
      desc: "内联结果被选中时按比例回执（0-100%）",
      path: "Bot Settings → Inline Feedback",
      status: null,
    },
    {
      name: "Secretary Mode（商务/秘书模式）",
      desc: "连接 Telegram Business 账号代收发消息",
      path: "Bot Settings → Secretary Mode",
      status: meInfo ? meInfo.can_connect_to_business : null,
      statusLabel: ["已连接", "未连接"],
    },
    {
      name: "Allow Groups?（允许加入群组）",
      desc: "是否允许被拉入群组/频道",
      path: "Bot Settings → Allow Groups?",
      status: meInfo ? meInfo.can_join_groups : null,
      statusLabel: ["允许", "禁止"],
    },
    {
      name: "Group Privacy（群组隐私模式）",
      desc: "开启时群内仅收到指令与回复消息",
      path: "Bot Settings → Group Privacy",
      status: meInfo ? !meInfo.can_read_all_group_messages : null,
      statusLabel: ["已开启（仅指令）", "已关闭（读全部消息）"],
    },
    {
      name: "Payments（支付）",
      desc: "连接支付提供商（真实付款需在此配置）",
      path: "Payments",
      status: null,
    },
    {
      name: "Domain（登录组件域名）",
      desc: "Telegram 登录组件可用的域名",
      path: "Domain",
      status: null,
    },
    {
      name: "Paid Broadcast（付费广播）",
      desc: "向频道发送付费广播的星数设置",
      path: "Paid Broadcast",
      status: null,
    },
  ];

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={bot ? `编辑机器人${meInfo?.username ? `（@${meInfo.username}）` : bot.username ? `（@${bot.username}）` : ""}` : "新增机器人"}
      description="Token 来自 @BotFather；官方配置项保存后自动调用 Bot API 真实应用到机器人。"
      action={saveBotAction}
      submitLabel="保存机器人"
      contentClassName="sm:max-w-2xl"
    >
      <input type="hidden" name="id" value={bot?.id ?? ""} />
      <input type="hidden" name="enabled" value={enabled ? "1" : "0"} />
      <input type="hidden" name="plugins_json" value={pluginsJson} />
      <input type="hidden" name="aiSupport_json" value={aiSupportJson} />
      <input type="hidden" name="menuButton_json" value={menuButtonJson} />
      <input type="hidden" name="defaultAdminRights_json" value={defaultAdminRightsJson} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`bot-name-${idSuffix}`}>
            备注名称 *
          </label>
          <input
            id={`bot-name-${idSuffix}`}
            name="name"
            required
            value={nameValue}
            onChange={(event) => setNameValue(event.target.value)}
            placeholder="填入 Token 后点「自动获取」"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`bot-enabled-${idSuffix}`}>
            状态
          </label>
          <label className="flex h-10 cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3 shadow-sm">
            <span>
              <span className="text-sm font-medium">{enabled ? "启用" : "停用"}</span>
              <span className="ml-2 text-xs text-muted-foreground">{enabled ? "开启独立轮询" : "不参与轮询"}</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="机器人状态" id={`bot-enabled-${idSuffix}`} />
          </label>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className={labelClass} htmlFor={`bot-token-${idSuffix}`}>
            BotFather Token {bot ? "（留空保持不变）" : "*"}
          </label>
          <button
            type="button"
            onClick={() => void fetchMe((document.getElementById(`bot-token-${idSuffix}`) as HTMLInputElement | null)?.value)}
            disabled={meFetching}
            className="inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {meFetching ? "获取中…" : "⟳ 自动获取信息"}
          </button>
        </div>
        <input
          id={`bot-token-${idSuffix}`}
          name="token"
          defaultValue={bot?.token ?? ""}
          placeholder="123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          className={`font-mono ${inputClass}`}
        />
        {meInfo ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 font-medium text-green-700">
              @{meInfo.username}
            </span>
            <span className="text-muted-foreground">ID：{meInfo.id}</span>
            <span className="text-muted-foreground">名称：{meInfo.first_name}</span>
          </div>
        ) : null}
        {meError ? <p className="text-xs text-red-600">{meError}</p> : null}
      </div>

      {/* 已加入的真实群组：统一获取通道（与机器人测试页同一 Hook / API） */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">已加入的真实群组</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              打开弹窗展示已登记的群组（本地数据库，不请求 Telegram）；点「同步真实群组」才实时发现并校验。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void realGroups.sync()}
            disabled={realGroups.syncing}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          >
            {realGroups.syncing ? "同步中…" : "⟳ 同步真实群组"}
          </button>
        </div>
        {realGroups.groups.length > 0 ? (
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
            {realGroups.groups.map((group) => (
              <div
                key={group.chatId}
                className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate font-medium">{group.chatTitle || `群组 ${group.chatId}`}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <span className="font-mono">{group.chatId}</span>
                  <span className="rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px]">
                    {group.source === "updates"
                      ? "getUpdates 新发现"
                      : group.source === "getchat"
                        ? "getChat 验证"
                        : "已登记"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
            {realGroups.loading
              ? "正在读取已登记的群组…"
              : realGroups.syncing
                ? "正在通过 Bot Token 同步真实群组…"
                : "尚未登记群组：把机器人拉进群组并设为管理员，在群里发一条消息后点「同步真实群组」手动发现。"}
          </p>
        )}
        {realGroups.note ? (
          <p className={`mt-1.5 text-xs ${realGroups.note.ok ? "text-green-700" : "text-red-600"}`}>
            {realGroups.note.ok ? "✓ " : "⚠ "}
            {realGroups.note.text}
          </p>
        ) : null}
      </div>

      {/* 官方 API 配置项：保存时真实调用 Bot API */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">官方 API 配置项（可选，保存时自动应用）</p>
        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-myname-${idSuffix}`}>
              机器人名称 setMyName
            </label>
            <input
              id={`bot-myname-${idSuffix}`}
              name="my_name"
              defaultValue={profile.my_name ?? ""}
              placeholder={meInfo?.first_name ?? ""}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-desc-${idSuffix}`}>
              描述 setMyDescription（空对话页展示）
            </label>
            <textarea
              id={`bot-desc-${idSuffix}`}
              name="description"
              defaultValue={profile.description ?? ""}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-shortdesc-${idSuffix}`}>
              简介 setMyShortDescription（个人资料页展示）
            </label>
            <input
              id={`bot-shortdesc-${idSuffix}`}
              name="short_description"
              defaultValue={profile.short_description ?? ""}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-cmds-${idSuffix}`}>
              命令列表 setMyCommands（每行一条：/命令 描述）
            </label>
            <textarea
              id={`bot-cmds-${idSuffix}`}
              name="commands"
              defaultValue={commandsText}
              rows={3}
              placeholder={"/start 启动机器人\n/price 查询今日价格"}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              提示：也可以在「指令管理」维护指令库，再通过机器人列表「指令菜单」批量同步。
            </p>
          </div>
        </div>
      </div>

      {/* 菜单按钮 setChatMenuButton */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">菜单按钮 setChatMenuButton（对应 BotFather「Menu Button / Configure Mini App」）</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-menubtn-type-${idSuffix}`}>
              按钮类型
            </label>
            <select
              id={`bot-menubtn-type-${idSuffix}`}
              value={menuButton.type}
              onChange={(event) => setMenuButton((prev) => ({ ...prev, type: event.target.value as MenuButtonState["type"] }))}
              className={selectClass}
            >
              {MENU_BUTTON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {menuButton.type === "web_app" ? (
            <>
              <div className="space-y-1">
                <label className={labelClass} htmlFor={`bot-menubtn-text-${idSuffix}`}>
                  按钮文字
                </label>
                <input
                  id={`bot-menubtn-text-${idSuffix}`}
                  value={menuButton.text}
                  onChange={(event) => setMenuButton((prev) => ({ ...prev, text: event.target.value }))}
                  placeholder="打开应用"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className={labelClass} htmlFor={`bot-menubtn-url-${idSuffix}`}>
                  Mini App 地址（必须 HTTPS）
                </label>
                <input
                  id={`bot-menubtn-url-${idSuffix}`}
                  value={menuButton.url}
                  onChange={(event) => setMenuButton((prev) => ({ ...prev, url: event.target.value }))}
                  placeholder="https://your-app.example.com"
                  className={inputClass}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* 默认管理员权限 setMyDefaultAdministratorRights */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">默认管理员权限 setMyDefaultAdministratorRights（对应 BotFather「Group/Channel Admin Rights」）</p>
        <p className="mt-1 text-xs text-muted-foreground">
          把机器人拉进群组/频道并提升为管理员时默认授予的权限；右侧开关关闭表示「不修改」当前设置。
        </p>
        <div className="mt-3 space-y-3">
          <RightsCard
            title="群组默认权限"
            description="机器人被提升为群组管理员时的默认权限"
            fields={GROUP_RIGHT_FIELDS}
            value={groupRights}
            onChange={setGroupRights}
            preset={GROUP_RIGHTS_PRESET}
          />
          <RightsCard
            title="频道默认权限"
            description="机器人被提升为频道管理员时的默认权限"
            fields={CHANNEL_RIGHT_FIELDS}
            value={channelRights}
            onChange={setChannelRights}
          />
        </div>
      </div>

      {/* BotFather 专属设置：Bot API 只读展示 */}
      <div className="rounded-lg border border-dashed bg-muted/30 p-3">
        <p className="text-sm font-medium">BotFather 专属设置（Bot API 只读，需在 @BotFather 修改）</p>
        <p className="mt-1 text-xs text-muted-foreground">
          点击 Token 旁的「自动获取信息」即可读取当前状态；以下项 Telegram 未开放修改 API，请在 @BotFather → /mybots → Bot Settings 中操作。
        </p>
        <div className="mt-3 space-y-1.5">
          {botFatherRows.map((row) => (
            <div key={row.name} className="flex items-start justify-between gap-3 rounded-md border bg-background px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.desc} · {row.path}
                </p>
              </div>
              {row.status === null ? (
                <span className="shrink-0 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">BotFather 配置</span>
              ) : (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    row.status ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {row.status ? row.statusLabel?.[0] ?? "已开启" : row.statusLabel?.[1] ?? "未开启"}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* grammY 插件开关与会话存储单项覆盖 */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">grammY 插件与会话存储</p>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center justify-between rounded-lg border bg-background px-3 py-2">
              <span className="text-sm font-medium">auto-retry 自动重试</span>
              <span className={toggleButtonClass}>
                <input
                  type="checkbox"
                  checked={plugins.autoRetry}
                  onChange={(event) => setPlugins((prev) => ({ ...prev, autoRetry: event.target.checked }))}
                  className="peer sr-only"
                />
                <span className={toggleThumbClass} />
              </span>
            </label>
            <label className="flex items-center justify-between rounded-lg border bg-background px-3 py-2">
              <span className="text-sm font-medium">throttler 发送限速</span>
              <span className={toggleButtonClass}>
                <input
                  type="checkbox"
                  checked={plugins.throttler}
                  onChange={(event) => setPlugins((prev) => ({ ...prev, throttler: event.target.checked }))}
                  className="peer sr-only"
                />
                <span className={toggleThumbClass} />
              </span>
            </label>
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor={`bot-session-${idSuffix}`}>
              会话存储（session 外部存储单项覆盖）
            </label>
            <select
              id={`bot-session-${idSuffix}`}
              value={plugins.sessionStorage}
              onChange={(event) => setPlugins((prev) => ({ ...prev, sessionStorage: event.target.value }))}
              className={selectClass}
            >
              {SESSION_STORAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* AI 客服 */}
      <div className="rounded-lg border bg-muted/30 p-3">
        <label className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">AI 客服</p>
            <p className="text-xs text-muted-foreground">开启后机器人自动回复用户提问（模型来自「AI 配置」）</p>
          </div>
          <span className={toggleButtonClass}>
            <input
              type="checkbox"
              checked={aiSupport.enabled}
              onChange={(event) => setAiSupport((prev) => ({ ...prev, enabled: event.target.checked }))}
              className="peer sr-only"
            />
            <span className={toggleThumbClass} />
          </span>
        </label>
        {aiSupport.enabled ? (
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <span className={labelClass}>AI 模型</span>
                <AiModelSelect
                  value={aiSupport.modelSelection}
                  onChange={(value) => setAiSupport((prev) => ({ ...prev, modelSelection: value }))}
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor={`bot-ai-scope-${idSuffix}`}>
                  触发范围
                </label>
                <select
                  id={`bot-ai-scope-${idSuffix}`}
                  value={aiSupport.scope}
                  onChange={(event) => setAiSupport((prev) => ({ ...prev, scope: event.target.value }))}
                  className={selectClass}
                >
                  {AI_SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className={labelClass} htmlFor={`bot-ai-prompt-${idSuffix}`}>
                系统提示词（留空使用内置客服提示词）
              </label>
              <textarea
                id={`bot-ai-prompt-${idSuffix}`}
                value={aiSupport.systemPrompt}
                onChange={(event) => setAiSupport((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                rows={3}
                placeholder="你是 XX 群组的智能客服，请用用户使用的语言简洁回答…"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}
