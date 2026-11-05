"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Battery,
  ChevronRight,
  CircleUserRound,
  Hand,
  Heart,
  Link2,
  ListTree,
  Loader2,
  MessageCircle,
  MessageSquareText,
  Paintbrush,
  Phone,
  PlayCircle,
  Rocket,
  Search,
  Settings2,
  ShieldCheck,
  SignalHigh,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Switch } from "@/components/ui/switch";
import {
  renderMenuTemplate,
  type BotMenuConfig,
  type MenuTemplateVars,
} from "@/services/menu-config";
import { TgSimulator } from "@/components/admin/tg-simulator";

/**
 * iOS Telegram APP 仿真外壳（机器人测试页仿真屏）。
 *
 * 视图层栈（iOS push/pop 导航，左滑进入）：
 *   list     群组列表（顶部搜索框 + 群组行 + 底部 Tab，图1）
 *   chat     群内聊天界面（复用 TgSimulator：菜单消息 + 加群验证全流程）
 *   settings 群组设置（图2：iOS 群组信息页 + 与「群组管理」同源的验证配置）
 *   admins   机器人权限配置（图3：iOS 管理员权限页 + promoteChatMember 真实保存）
 *   join     加群确认面板（搜索框输入加群链接 → resolve-invite 解析 → 申请加入）
 *
 * 数据边界：组件只做视图编排与 API 读写，群组数据/验证会话状态由父组件
 * （testing-client）持有，保证仿真屏与页面其他区域（会话徽章、闲鱼面板）状态一致。
 */

const NAME_COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];
const IOS_BLUE = "#3390ec";
const IOS_GREEN = "#34c759";
const IOS_GRAY_BG = "#efeff4";
const IOS_TEXT_SECONDARY = "#8e8e93";

function nameColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return NAME_COLORS[hash % NAME_COLORS.length];
}

function nowTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// —— 水合安全时钟（与 tg-simulator 同款 useSyncExternalStore 模式）——
let appClockCache: { minute: number; value: string } = { minute: -1, value: "" };

function subscribeClock(onStoreChange: () => void): () => void {
  const timer = window.setInterval(onStoreChange, 15000);
  return () => window.clearInterval(timer);
}

function getClockSnapshot(): string {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (appClockCache.minute !== minute) {
    appClockCache = { minute, value: nowTime() };
  }
  return appClockCache.value;
}

function getServerClockSnapshot(): string {
  return "";
}

export interface AppSimGroup {
  chatId: string;
  chatTitle: string;
  enabled: boolean;
  method: string;
  methodId: string | null;
  methodName: string | null;
  timeoutSeconds: number;
  maxAttempts: number;
  /** 已通过一键部署生成申请制入群链接（group_bot_admins.deploy_mode === "join_request"） */
  deployed: boolean;
  /** 待处理加群申请数（join_requests.status=pending 真实统计） */
  unread: number;
  /** 群组配置更新时间（ISO）；列表时间列显示：当天 HH:mm，更早 M/D */
  updatedTime: string;
}

export interface JoinResolveResult {
  resolve_type: "deep_link" | "invite_link";
  chat_id: string;
  chat_title: string;
  join_request_enabled: boolean;
  invite_link?: string | null;
  method: string | null;
  method_name: string | null;
  enabled: boolean;
  bot_username?: string | null;
  member_count?: number | null;
}

interface BotAdminEntry {
  id: string;
  bot_id: string;
  bot_name: string | null;
  bot_username: string | null;
  rights: Record<string, boolean>;
}

/** 与 bots/actions.ts BOT_ADMIN_RIGHT_KEYS 一致（Telegram promoteChatMember 支持的 8 项） */
const ADMIN_RIGHTS: { key: string; label: string; hint: string }[] = [
  { key: "can_change_info", label: "修改群组信息", hint: "更改群名称、头像与描述" },
  { key: "can_delete_messages", label: "删除消息", hint: "删除群内任意成员的消息" },
  { key: "can_restrict_members", label: "封禁用户", hint: "封禁/解封群成员" },
  { key: "can_invite_users", label: "添加成员", hint: "邀请用户与生成邀请链接（部署必需）" },
  { key: "can_pin_messages", label: "置顶消息", hint: "置顶或取消置顶群消息" },
  { key: "can_manage_video_chats", label: "管理视频聊天", hint: "发起与管理群视频会议" },
  { key: "can_promote_members", label: "添加新管理员", hint: "提升其他成员为管理员" },
  { key: "can_manage_chat", label: "管理聊天", hint: "默认管理员基础权限" },
];

type Screen = "list" | "chat" | "settings" | "admins";

const NAV_VARIANTS = {
  enter: (dir: "fwd" | "back") => ({ x: dir === "fwd" ? "100%" : "-28%" }),
  center: { x: "0%" },
  exit: (dir: "fwd" | "back") => ({ x: dir === "fwd" ? "-28%" : "100%" }),
};

/** 列表时间列：当天显示 HH:mm，更早显示 M/D（与真实 Telegram 会话列表一致） */
function formatListTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 水合安全的列表时间列。
 *
 * formatListTime 依赖本地时区（getHours/getMinutes）：SSR 用服务器时区（UTC）
 * 渲染出的 HH:mm 与客户端（如 UTC+8）不一致，触发 "server rendered text didn't
 * match the client" hydration 错误。因此 mount 前与 SSR 保持一致渲染空字符串，
 * mount 后再写入本地时区时间，并每 30 秒刷新（保证跨天 M/D 判定持续正确）。
 */
function ListTime({ iso }: { iso: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const update = (): void => setValue(formatListTime(iso));
    update();
    const timer = window.setInterval(update, 30000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return <span className="shrink-0 text-[13px] text-[#8e8e93]">{value}</span>;
}

function methodLabel(method: string | null): string {
  if (method === "code_self") return "自动验证码";
  if (method === "code_api") return "自定义验证码";
  if (method === "captcha") return "人机验证码";
  return "未配置验证";
}

/** 安全解析响应 JSON：空响应体 / 非 JSON（如 500 错误页）不再抛 "Unexpected end of JSON input" */
async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function GroupAvatar({ title, size }: { title: string; size: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: nameColor(title), fontSize: size * 0.42 }}
      aria-hidden
    >
      {title.slice(0, 1) || "?"}
    </div>
  );
}

function IosRowIcon({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <span
      className="flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] text-white"
      style={{ backgroundColor: bg }}
      aria-hidden
    >
      {children}
    </span>
  );
}

export function TgAppSimulator({
  config,
  botName,
  botUsername,
  selectedBotId,
  groups,
  activeChatId,
  memberCount,
  systemNote,
  templateVars,
  promptMessage,
  onUserSend,
  joinPhase,
  onRequestJoin,
  view,
  onSelectGroup,
  onSyncGroups,
  syncing,
  onDeployGroup,
  deployingChatId,
  onSimulateJoinForGroup,
  chatOpenRequest,
  onSettingsSaved,
}: {
  config: BotMenuConfig;
  botName: string;
  botUsername: string | null;
  selectedBotId: string;
  groups: AppSimGroup[];
  activeChatId: string | null;
  memberCount: string;
  systemNote?: string;
  templateVars?: Partial<MenuTemplateVars>;
  promptMessage?: { id: number; text: string; hint?: string } | null;
  onUserSend?: (text: string) => Promise<{ ok: boolean; text: string; joined?: boolean }>;
  joinPhase?: "idle" | "awaiting_code" | "joined";
  onRequestJoin?: () => Promise<{ ok: boolean; message: string }>;
  view: "group" | "private";
  onSelectGroup: (chatId: string) => void;
  onSyncGroups: () => void;
  syncing: boolean;
  /** 一键部署：父组件调用 deploy API，返回校验结果（stage/guide 由部署面板展示） */
  onDeployGroup: (chatId: string) => Promise<{ ok: boolean; message: string; stage?: string; guide?: string[]; invite_link?: string | null } | null>;
  deployingChatId: string | null;
  /** 从列表/加群确认面板发起模拟加群申请（父组件创建验证会话并切换视图） */
  onSimulateJoinForGroup: (chatId: string) => Promise<{ ok: boolean; message: string }>;
  /** 父组件创建会话成功后递增；本组件监听后 push 到群聊界面 */
  chatOpenRequest: number;
  /** 群组设置保存成功后由父组件刷新列表数据（router.refresh + realGroups 重载） */
  onSettingsSaved: () => void;
}) {
  const clock = useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot);

  // —— iOS 导航栈 ——
  const [stack, setStack] = useState<Screen[]>(["list"]);
  // 导航方向参与渲染（push 从右滑入 / pop 向右滑出），必须用 state 而非 ref
  const [navDir, setNavDir] = useState<"fwd" | "back">("fwd");
  const current = stack[stack.length - 1];
  const push = useCallback((screen: Screen): void => {
    setNavDir("fwd");
    setStack((prev) => (prev[prev.length - 1] === screen ? prev : [...prev, screen]));
  }, []);
  const pop = useCallback((): void => {
    setNavDir("back");
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  // —— 顶部 flash 提示（iOS 深色胶囊）——
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const flashTimer = useRef<number | null>(null);
  const showFlash = useCallback((ok: boolean, text: string): void => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash({ ok, text });
    flashTimer.current = window.setTimeout(() => setFlash(null), 4200);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  // —— 群组列表搜索（普通文本过滤；加群链接 → 打开确认面板）——
  const [search, setSearch] = useState("");
  const isJoinLink = /t\.me\/(\+|joinchat\/)/i.test(search) || /start=join_-?\d+/i.test(search);
  const filteredGroups = useMemo(() => {
    if (!search.trim() || isJoinLink) return groups;
    const keyword = search.trim().toLowerCase();
    return groups.filter(
      (group) =>
        group.chatTitle.toLowerCase().includes(keyword) || group.chatId.includes(keyword),
    );
  }, [groups, search, isJoinLink]);
  const totalUnread = useMemo(
    () => groups.reduce((sum, group) => sum + group.unread, 0),
    [groups],
  );

  const [resolving, setResolving] = useState(false);
  const [joinPanel, setJoinPanel] = useState<JoinResolveResult | null>(null);
  const [applyingJoin, setApplyingJoin] = useState(false);

  const openJoinLink = useCallback(async (): Promise<void> => {
    const link = search.trim();
    if (!link || resolving) return;
    setResolving(true);
    try {
      const response = await fetch(
        `/api/admin/bots/testing/resolve-invite?link=${encodeURIComponent(link)}&bot_id=${encodeURIComponent(selectedBotId)}`,
        { cache: "no-store" },
      );
      const payload = await readJson<{ ok: boolean; error?: string; data?: JoinResolveResult }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok || !payload.data) {
        showFlash(false, payload.error ?? "链接解析失败");
        return;
      }
      setJoinPanel(payload.data);
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "链接解析失败");
    } finally {
      setResolving(false);
    }
  }, [search, resolving, selectedBotId, showFlash]);

  // 加群确认面板「申请加入」：复用父组件会话创建管道（与列表「模拟加群申请」按钮同一函数）
  const handleApplyJoin = useCallback(async (): Promise<void> => {
    if (!joinPanel || applyingJoin) return;
    setApplyingJoin(true);
    try {
      const result = await onSimulateJoinForGroup(joinPanel.chat_id);
      if (result.ok) {
        setJoinPanel(null);
        setSearch("");
      } else {
        showFlash(false, result.message);
      }
    } finally {
      setApplyingJoin(false);
    }
  }, [joinPanel, applyingJoin, onSimulateJoinForGroup, showFlash]);

  // 父组件创建验证会话成功 → 自动 push 到群聊界面（验证码在私聊视图输入）
  useEffect(() => {
    if (chatOpenRequest > 0) push("chat");
  }, [chatOpenRequest, push]);

  // —— 一键部署 ——
  const [deployResult, setDeployResult] = useState<{
    stage?: string;
    message: string;
    guide?: string[];
    invite_link?: string | null;
    chat_title?: string;
    bot_username?: string | null;
  } | null>(null);
  const [deployLinkCopied, setDeployLinkCopied] = useState(false);

  const handleDeploy = useCallback(async (chatId: string): Promise<void> => {
    const result = await onDeployGroup(chatId);
    if (!result) return;
    if (result.ok && result.stage === "deployed") {
      showFlash(true, "部署完成：申请制入群链接已生成并保存");
    } else {
      showFlash(false, result.message || "部署校验未通过，请按指引操作");
    }
    // 详情（含喂饭级 guide / 链接）以 iOS 弹层展示
    setDeployLinkCopied(false);
    setDeployResult({
      stage: result.stage,
      message: result.message,
      guide: result.guide,
      invite_link: result.invite_link,
      chat_title: groups.find((group) => group.chatId === chatId)?.chatTitle,
      bot_username: botUsername,
    });
  }, [onDeployGroup, showFlash, groups, botUsername]);

  // —— 群组设置页（图2）状态 ——
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMethods, setSettingsMethods] = useState<{ id: string; name: string; enabled: boolean }[]>([]);
  const [form, setForm] = useState({
    chat_title: "",
    method: "code_self",
    method_id: "",
    timeout_seconds: 300,
    max_attempts: 3,
    prompt_text: "",
    success_text: "",
    failure_text: "",
    enabled: true,
    privacy_mode: true,
  });

  const loadGroupSettings = useCallback(async (chatId: string): Promise<void> => {
    setSettingsLoading(true);
    try {
      const response = await fetch(
        `/api/admin/bots/testing/group-settings?chat_id=${encodeURIComponent(chatId)}`,
        { cache: "no-store" },
      );
      const payload = await readJson<{
        ok: boolean;
        error?: string;
        data?: {
          settings: {
            chat_title: string | null;
            method: string;
            method_id: string | null;
            timeout_seconds: number;
            max_attempts: number;
            prompt_text: string;
            success_text: string;
            failure_text: string;
            enabled: boolean;
            privacy_mode: boolean;
          } | null;
          methods: { id: string; name: string; enabled: boolean }[];
        };
      }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok || !payload.data) {
        showFlash(false, payload.error ?? "读取群组配置失败");
        return;
      }
      setSettingsMethods(payload.data.methods);
      const settings = payload.data.settings;
      setForm({
        chat_title: settings?.chat_title ?? "",
        method: settings?.method ?? "code_self",
        method_id: settings?.method_id ?? "",
        timeout_seconds: settings?.timeout_seconds ?? 300,
        max_attempts: settings?.max_attempts ?? 3,
        prompt_text: settings?.prompt_text ?? "",
        success_text: settings?.success_text ?? "",
        failure_text: settings?.failure_text ?? "",
        enabled: settings?.enabled ?? true,
        privacy_mode: settings?.privacy_mode ?? true,
      });
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取群组配置失败");
    } finally {
      setSettingsLoading(false);
    }
  }, [showFlash]);

  const saveGroupSettings = useCallback(async (): Promise<void> => {
    if (!activeChatId || settingsSaving) return;
    setSettingsSaving(true);
    try {
      const response = await fetch("/api/admin/bots/testing/group-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: activeChatId,
          chat_title: form.chat_title,
          method: form.method,
          // v2.0.1：透传所选绑定方法（服务端与群组管理 saveGroupAction 同语义落库保留）——
          // 不再非 code_api 时强制 null，否则用户在「群组管理」绑定的方法会被仿真屏保存静默清掉
          method_id: form.method_id || null,
          timeout_seconds: Number(form.timeout_seconds) || 300,
          max_attempts: Number(form.max_attempts) || 3,
          prompt_text: form.prompt_text,
          success_text: form.success_text,
          failure_text: form.failure_text,
          enabled: form.enabled,
          privacy_mode: form.privacy_mode,
        }),
      });
      const payload = await readJson<{ ok: boolean; error?: string }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok) {
        showFlash(false, payload.error ?? "保存失败");
        return;
      }
      showFlash(true, "群组配置已保存（与群组管理同源生效）");
      onSettingsSaved();
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }, [activeChatId, settingsSaving, form, showFlash, onSettingsSaved]);

  // 进入设置页时加载该群当前配置
  useEffect(() => {
    if (current === "settings" && activeChatId) void loadGroupSettings(activeChatId);
  }, [current, activeChatId, loadGroupSettings]);

  // —— 机器人权限页（图3）状态 ——
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [adminsSaving, setAdminsSaving] = useState(false);
  const [adminRights, setAdminRights] = useState<Record<string, boolean>>({});
  const [adminRecord, setAdminRecord] = useState<{ bot_name: string | null; bot_username: string | null } | null>(null);

  const loadBotAdmins = useCallback(async (chatId: string): Promise<void> => {
    setAdminsLoading(true);
    try {
      const response = await fetch(
        `/api/admin/bots/testing/bot-admins?chat_id=${encodeURIComponent(chatId)}`,
        { cache: "no-store" },
      );
      const payload = await readJson<{ ok: boolean; error?: string; data?: { admins: BotAdminEntry[] } }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok || !payload.data) {
        showFlash(false, payload.error ?? "读取机器人权限失败");
        return;
      }
      const mine = payload.data.admins.find((entry) => entry.bot_id === selectedBotId) ?? null;
      setAdminRecord(mine ? { bot_name: mine.bot_name, bot_username: mine.bot_username } : null);
      const rights: Record<string, boolean> = {};
      for (const right of ADMIN_RIGHTS) {
        rights[right.key] = mine?.rights?.[right.key] === true;
      }
      setAdminRights(rights);
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取机器人权限失败");
    } finally {
      setAdminsLoading(false);
    }
  }, [selectedBotId, showFlash]);

  const saveBotAdmins = useCallback(async (): Promise<void> => {
    if (!activeChatId || adminsSaving) return;
    setAdminsSaving(true);
    try {
      const response = await fetch("/api/admin/bots/testing/bot-admins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: activeChatId, bot_id: selectedBotId, rights: adminRights }),
      });
      const payload = await readJson<{
        ok: boolean;
        error?: string;
        data?: { rights?: Record<string, boolean>; notice?: string };
      }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok) {
        showFlash(false, payload.error ?? "保存权限失败");
        return;
      }
      // 与机器人管理员弹窗同源：以 Telegram 实际权限为准回显（弹窗返回真实同步后的权限与详情）
      if (payload.data?.rights) {
        setAdminRights((prev) => {
          const actual = { ...prev };
          for (const right of ADMIN_RIGHTS) {
            actual[right.key] = payload.data?.rights?.[right.key] === true;
          }
          return actual;
        });
      }
      showFlash(true, payload.data?.notice || "权限已保存，并已通过 Telegram API 同步到群组");
      onSettingsSaved();
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "保存权限失败");
    } finally {
      setAdminsSaving(false);
    }
  }, [activeChatId, adminsSaving, selectedBotId, adminRights, showFlash, onSettingsSaved]);

  // 进入权限页时加载当前机器人对该群的权限
  useEffect(() => {
    if (current === "admins" && activeChatId) void loadBotAdmins(activeChatId);
  }, [current, activeChatId, loadBotAdmins]);

  const activeGroup = useMemo(
    () => groups.find((group) => group.chatId === activeChatId) ?? null,
    [groups, activeChatId],
  );

  // —— 各屏幕渲染 ——
  const vars = useMemo<MenuTemplateVars>(
    () => ({
      chat_id: "-1001998877661",
      user_id: "777000",
      username: "preview_user",
      first_name: "预览",
      last_name: "用户",
      chat_title: activeGroup?.chatTitle ?? "测试群组",
      message_id: "1024",
      ...(templateVars ?? {}),
    }),
    [activeGroup?.chatTitle, templateVars],
  );

  const menuPreview = useMemo(
    () => renderMenuTemplate(config.content.type === "text" ? config.content.text : "", vars),
    [config, vars],
  );

  const listView = (
    <div className="flex h-full flex-col bg-white">
      {/* iOS 状态栏 */}
      <div className="flex items-center justify-between px-6 pt-2.5 pb-1 text-[13px] font-semibold text-black">
        <span className="min-w-[54px]">{clock || "\u00A0"}</span>
        <span className="flex items-center gap-1.5 text-black/85">
          <SignalHigh className="h-3.5 w-3.5" />
          <Wifi className="h-3.5 w-3.5" />
          <Battery className="h-4 w-4" />
        </span>
      </div>

      {/* 搜索框（图1）：普通文本过滤群组；输入加群链接回车 → 真实解析并弹出加群确认面板 */}
      <div className="px-3 pt-1 pb-2">
        <div className="flex items-center gap-2 rounded-[10px] bg-black/[0.07] px-2.5 py-[7px]">
          <Search className="h-4 w-4 shrink-0 text-[#8e8e93]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isJoinLink) void openJoinLink();
            }}
            placeholder="搜索 或 粘贴加群链接（t.me/+...）"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-black outline-none placeholder:text-[#8e8e93]"
            aria-label="搜索群组或输入加群链接"
          />
          {isJoinLink ? (
            <button
              type="button"
              onClick={() => void openJoinLink()}
              disabled={resolving}
              className="flex shrink-0 items-center gap-1 rounded-full bg-[#3390ec] px-3 py-1 text-[13px] font-medium text-white disabled:opacity-60"
            >
              {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              打开链接
            </button>
          ) : null}
        </div>
      </div>

      {/* 同步真实群组（由父组件触发，与页面顶部按钮同一管道） */}
      <div className="flex items-center justify-between px-4 pb-1.5">
        <span className="text-[12px] text-[#8e8e93]">
          当前机器人 Token 下的群组（{filteredGroups.length}）
        </span>
        <button
          type="button"
          onClick={onSyncGroups}
          disabled={syncing}
          className="flex items-center gap-1 text-[12px] font-medium text-[#3390ec] disabled:opacity-60"
        >
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {syncing ? "同步中…" : "同步真实群组"}
        </button>
      </div>

      {/* 群组列表（图1样式） */}
      <div className="flex-1 overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <div className="px-6 py-10 text-center text-[14px] leading-relaxed text-[#8e8e93]">
            {groups.length === 0
              ? "该机器人尚未登记群组：把机器人拉进群设为管理员后在群里发一条消息，再点「同步真实群组」"
              : "没有匹配的群组"}
          </div>
        ) : (
          filteredGroups.map((group, index) => (
            <div key={group.chatId} className={index > 0 ? "border-t border-black/[0.07]" : ""}>
              <button
                type="button"
                onClick={() => {
                  onSelectGroup(group.chatId);
                  push("chat");
                }}
                className="flex w-full items-center gap-3 px-3 pt-2 pb-1.5 text-left transition-colors active:bg-black/[0.04]"
              >
                <GroupAvatar title={group.chatTitle} size={54} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-[16px] font-semibold text-black">
                      {group.chatTitle || `群组 ${group.chatId}`}
                      {group.enabled ? null : (
                        <span className="ml-1.5 rounded bg-black/10 px-1 py-0.5 align-middle text-[10px] font-medium text-[#8e8e93]">
                          已停用
                        </span>
                      )}
                    </p>
                    <ListTime iso={group.updatedTime} />
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[14.5px] text-[#8e8e93]">
                      {group.methodName ?? methodLabel(group.method)}
                      {group.deployed ? " · 已部署" : ""}
                    </p>
                    {group.unread > 0 ? (
                      <span className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-[#3390ec] px-1.5 text-[13px] font-semibold text-white">
                        {group.unread}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
              {/* 每个群组底部的操作行：一键部署 / 模拟加群申请 */}
              <div className="flex gap-2 px-3 pb-2.5">
                <button
                  type="button"
                  onClick={() => void handleDeploy(group.chatId)}
                  disabled={deployingChatId === group.chatId}
                  className={`flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                    group.deployed
                      ? "border border-[#34c759]/40 bg-[#34c759]/10 text-[#1e8e3e]"
                      : "bg-[#3390ec]/10 text-[#3390ec]"
                  } disabled:opacity-60`}
                  title={group.deployed ? "已部署：重新校验并刷新入群申请链接" : "校验机器人身份并生成申请制入群链接"}
                >
                  {deployingChatId === group.chatId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Rocket className="h-3.5 w-3.5" />
                  )}
                  {group.deployed ? "重新部署" : "一键部署"}
                </button>
                <button
                  type="button"
                  onClick={() => void onSimulateJoinForGroup(group.chatId)}
                  className="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-black/[0.05] text-[13px] font-medium text-[#3b4a54] transition-colors hover:bg-black/[0.09]"
                  title="以模拟用户身份发起加群申请，由加群验证机器人接管验证"
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  模拟加群申请
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 底部 Tab（图1） */}
      <div className="flex items-start justify-around border-t border-black/[0.08] bg-white/95 px-2 pt-1.5 pb-4 backdrop-blur">
        {[
          { key: "contacts", label: "联系人", icon: CircleUserRound },
          { key: "calls", label: "通话", icon: Phone },
          { key: "chats", label: "聊天", icon: MessageCircle, active: true, badge: totalUnread },
          { key: "settings", label: "设置", icon: Settings2 },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              if (!tab.active) showFlash(true, "仿真模式聚焦「聊天」：联系人 / 通话 / 设置为 APP 结构还原");
            }}
            className={`relative flex w-16 flex-col items-center gap-0.5 ${
              tab.active ? "text-[#3390ec]" : "text-[#8e8e93]"
            }`}
          >
            <tab.icon className="h-[26px] w-[26px]" />
            <span className="text-[11px] font-medium">{tab.label}</span>
            {tab.badge && tab.badge > 0 ? (
              <span className="absolute -top-1 left-1/2 ml-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#eb5545] px-1 text-[11px] font-semibold text-white">
                {tab.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );

  const chatView = (
    <TgSimulator
      config={config}
      botName={botName}
      groupTitle={activeGroup?.chatTitle ?? "测试群组"}
      memberCount={memberCount}
      nodeId="root"
      onNodeNavigate={() => undefined}
      systemNote={systemNote}
      templateVars={templateVars}
      promptMessage={promptMessage}
      onUserSend={onUserSend}
      joinPhase={joinPhase}
      onRequestJoin={onRequestJoin}
      view={view}
      onBack={pop}
      onOpenSettings={() => push("settings")}
    />
  );

  const settingsView = (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      {/* 顶部导航：X 关闭 + ✓ 保存（图2） */}
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={pop}
          aria-label="关闭群组设置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">群组信息</span>
        <button
          type="button"
          onClick={() => void saveGroupSettings()}
          disabled={settingsSaving || settingsLoading}
          aria-label="保存群组配置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-white transition-transform active:scale-95 disabled:opacity-60"
          style={{ backgroundColor: IOS_GREEN }}
        >
          {settingsSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <span className="text-lg font-bold leading-none">✓</span>}
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {settingsLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
          </div>
        ) : (
          <>
            {/* 头像区（图2） */}
            <div className="flex flex-col items-center pb-1">
              <GroupAvatar title={form.chat_title || activeGroup?.chatTitle || "群"} size={96} />
              <span className="mt-2 text-[15px]" style={{ color: IOS_BLUE }}>
                更改头像
              </span>
            </div>

            {/* 群名称（与群组管理同源可保存） */}
            <div className="rounded-xl bg-white px-4 py-2.5">
              <input
                value={form.chat_title}
                onChange={(event) => setForm((prev) => ({ ...prev, chat_title: event.target.value }))}
                className="w-full bg-transparent text-[17px] text-black outline-none"
                placeholder="群名称"
                aria-label="群名称"
              />
            </div>

            {/* 加群验证配置（功能与群组管理完全一致） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="px-4 pt-3 pb-1 text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                加群验证配置（与「群组管理」同一数据源）
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[17px] text-black">启用验证</span>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))}
                  className="data-[state=checked]:bg-[#34c759]"
                  aria-label="启用验证"
                />
              </div>
              <div className="border-t border-black/[0.06] px-4 py-2.5">
                <p className="mb-2 text-[17px] text-black">验证方式</p>
                <div className="flex rounded-lg bg-black/[0.05] p-0.5">
                  {[
                    { value: "code_self", label: "自动验证码" },
                    { value: "captcha", label: "人机验证" },
                    { value: "code_api", label: "外部API" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, method: option.value }))}
                      className={`flex-1 rounded-[7px] py-1.5 text-[13px] font-medium transition-all ${
                        form.method === option.value
                          ? "bg-white text-black shadow-sm"
                          : "text-[#8e8e93]"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              {form.method === "code_api" ? (
                <div className="border-t border-black/[0.06] px-4 py-2.5">
                  <p className="mb-1.5 text-[17px] text-black">绑定验证方法</p>
                  <select
                    value={form.method_id}
                    onChange={(event) => setForm((prev) => ({ ...prev, method_id: event.target.value }))}
                    className="h-10 w-full rounded-lg border border-black/10 bg-white px-2 text-[15px] text-black outline-none"
                  >
                    <option value="">请选择验证方法</option>
                    {settingsMethods.map((method) => (
                      <option key={method.id} value={method.id}>
                        #{method.id} {method.name}（{method.enabled ? "启用" : "停用"}）
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5">
                <span className="text-[17px] text-black">验证超时（秒）</span>
                <input
                  type="number"
                  min={30}
                  value={form.timeout_seconds}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, timeout_seconds: Number(event.target.value) }))
                  }
                  className="w-24 rounded-lg bg-black/[0.04] px-2 py-1.5 text-right text-[16px] text-black outline-none"
                  aria-label="验证超时秒数"
                />
              </div>
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5">
                <span className="text-[17px] text-black">最大尝试次数</span>
                <input
                  type="number"
                  min={1}
                  value={form.max_attempts}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, max_attempts: Number(event.target.value) }))
                  }
                  className="w-24 rounded-lg bg-black/[0.04] px-2 py-1.5 text-right text-[16px] text-black outline-none"
                  aria-label="最大尝试次数"
                />
              </div>
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5">
                <span className="text-[17px] leading-snug text-black">
                  隐私模式
                  <span className="block text-[12px] text-[#8e8e93]">验证码须回复机器人的验证问题</span>
                </span>
                <Switch
                  checked={form.privacy_mode}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, privacy_mode: checked }))}
                  className="data-[state=checked]:bg-[#34c759]"
                  aria-label="隐私模式"
                />
              </div>
            </div>

            {/* 验证文案（与群组管理同源） */}
            <div className="space-y-2 rounded-xl bg-white px-4 py-3">
              <p className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                验证文案（机器人私聊发送给申请者）
              </p>
              {(
                [
                  { key: "prompt_text", label: "提示文案" },
                  { key: "success_text", label: "成功文案" },
                  { key: "failure_text", label: "失败文案" },
                ] as const
              ).map((field) => (
                <label key={field.key} className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">{field.label}</span>
                  <textarea
                    value={form[field.key]}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, [field.key]: event.target.value }))
                    }
                    rows={2}
                    className="w-full resize-none rounded-lg bg-black/[0.04] px-3 py-2 text-[15px] leading-relaxed text-black outline-none"
                  />
                </label>
              ))}
            </div>

            {/* 群组信息行（图2 结构，展示系统真实状态） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#3390ec">
                  <Users className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">群组类型</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {activeGroup?.chatId.startsWith("-100") ? "超级群组 · 私密" : "群组"}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#34c759">
                  <MessageSquareText className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">聊天记录</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {form.enabled ? "新成员不可见" : "已停用验证"}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <button
                type="button"
                onClick={() =>
                  showFlash(
                    activeGroup?.deployed === true,
                    activeGroup?.deployed
                      ? "该群已生成申请制入群链接（一键部署产物）"
                      : "尚未部署：点击群组列表的「一键部署」生成申请制入群链接",
                  )
                }
                className="flex w-full cursor-pointer items-center gap-3 border-b border-black/[0.06] px-4 py-2.5 text-left"
              >
                <IosRowIcon bg="#f5a623">
                  <Link2 className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">邀请链接</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {activeGroup?.deployed ? "1" : "0"}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </button>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#eb5545">
                  <Heart className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">表情回应</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  已停用
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#a695e7">
                  <Hand className="h-4 w-4" />
                </IosRowIcon>
                <span className="min-w-0 flex-1 truncate text-[17px] text-black">问候语</span>
                <span className="max-w-[45%] truncate text-[15px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {menuPreview ? `👉 ${menuPreview.slice(0, 14)}…` : "由机器人菜单消息承担"}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#f7b500">
                  <Paintbrush className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">外观</span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <IosRowIcon bg="#6ec9cb">
                  <ListTree className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">话题</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  已禁用
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
            </div>
            <p className="px-1 text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              群聊将被划分为由管理员或用户创建的话题。
            </p>

            {/* 机器人权限配置入口（图3） */}
            <button
              type="button"
              onClick={() => push("admins")}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-white px-4 py-3 text-left transition-transform active:scale-[0.99]"
            >
              <IosRowIcon bg="#1e8e3e">
                <ShieldCheck className="h-4 w-4" />
              </IosRowIcon>
              <span className="flex-1 text-[17px] text-black">机器人管理员权限配置</span>
              <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
            </button>
          </>
        )}
      </div>
    </div>
  );

  const adminsView = (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      {/* 顶部导航（图3）：X 返回设置页 */}
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={pop}
          aria-label="返回群组设置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">管理员</span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {adminsLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
          </div>
        ) : (
          <>
            {/* 机器人信息卡片（图3 顶部） */}
            <div className="flex items-center gap-3 rounded-xl bg-white p-4">
              <GroupAvatar title={adminRecord?.bot_name ?? botName} size={56} />
              <div className="min-w-0">
                <p className="truncate text-[17px] font-semibold text-black">
                  {adminRecord?.bot_name ?? botName}
                </p>
                <p className="truncate text-[15px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  @{adminRecord?.bot_username ?? botUsername ?? "bot"}
                </p>
              </div>
            </div>

            <p className="px-1 text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
              这位管理员可以做什么？（保存将通过 Telegram API 真实同步）
            </p>

            {/* 权限开关列表（图3，iOS 绿色开关） */}
            <div className="overflow-hidden rounded-xl bg-white">
              {ADMIN_RIGHTS.map((right, index) => (
                <div
                  key={right.key}
                  className={index > 0 ? "border-t border-black/[0.06]" : ""}
                >
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-[17px] text-black">
                      {right.label}
                      <span className="block text-[12px] text-[#8e8e93]">{right.hint}</span>
                    </span>
                    <Switch
                      checked={adminRights[right.key] === true}
                      onCheckedChange={(checked) =>
                        setAdminRights((prev) => ({ ...prev, [right.key]: checked }))
                      }
                      className="data-[state=checked]:bg-[#34c759]"
                      aria-label={right.label}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* 保存更改（图3 底部大按钮） */}
            <button
              type="button"
              onClick={() => void saveBotAdmins()}
              disabled={adminsSaving}
              className="w-full cursor-pointer rounded-full py-3.5 text-[17px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
              style={{ backgroundColor: IOS_GREEN }}
            >
              {adminsSaving ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  正在同步到 Telegram…
                </span>
              ) : (
                "保存更改"
              )}
            </button>
            <p className="px-1 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              「添加成员（邀请用户）」是一键部署生成申请制入群链接的必需权限。
            </p>
          </>
        )}
      </div>
    </div>
  );

  const joinPanelView = joinPanel ? (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setJoinPanel(null)}
          aria-label="关闭加群确认"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">添加群组</span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-6">
        <div className="flex flex-col items-center">
          <GroupAvatar title={joinPanel.chat_title} size={96} />
          <p className="mt-3 text-center text-[20px] font-semibold text-black">{joinPanel.chat_title}</p>
          <p className="mt-0.5 text-[15px]" style={{ color: IOS_TEXT_SECONDARY }}>
            {typeof joinPanel.member_count === "number"
              ? `${joinPanel.member_count} 位成员`
              : `群组 ID ${joinPanel.chat_id}`}
          </p>
        </div>

        <div className="overflow-hidden rounded-xl bg-white">
          <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5">
            <span className="text-[16px] text-black">验证方式</span>
            <span className="text-[16px]" style={{ color: IOS_TEXT_SECONDARY }}>
              {joinPanel.method_name ?? methodLabel(joinPanel.method)}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[16px] text-black">新成员审核</span>
            <span
              className="text-[16px] font-medium"
              style={{ color: joinPanel.join_request_enabled ? IOS_GREEN : "#eb5545" }}
            >
              {joinPanel.join_request_enabled ? "已开启" : "未开启"}
            </span>
          </div>
        </div>

        <div className="rounded-xl bg-white px-4 py-3 text-[14px] leading-relaxed text-[#3b4a54]">
          {joinPanel.join_request_enabled
            ? "提交申请后，加群验证机器人将通过私聊发送验证提示（群里看不到），按提示完成验证后自动进群。"
            : "该邀请链接未开启「新成员审核」，无法被加群验证机器人接管。请在该群组的列表项点击「一键部署」重新生成申请制链接。"}
        </div>

        {joinPanel.join_request_enabled ? (
          joinPanel.enabled ? (
            <button
              type="button"
              onClick={() => void handleApplyJoin()}
              disabled={applyingJoin}
              className="w-full cursor-pointer rounded-xl py-3.5 text-[17px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
              style={{ backgroundColor: IOS_BLUE }}
            >
              {applyingJoin ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  正在提交申请…
                </span>
              ) : (
                "申请加入"
              )}
            </button>
          ) : (
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-[14px] leading-relaxed text-amber-700">
              该群组已停用加群验证，暂不接受入群申请。可在群组设置中重新启用。
            </div>
          )
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-[560px] flex-col overflow-hidden rounded-[2rem] border-8 border-[#0c0d10] bg-white shadow-2xl">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 底层列表（iOS push 时向下层视差） */}
        <AnimatePresence initial={false} custom={navDir} mode="popLayout">
          {current === "list" ? (
            <motion.div
              key="list"
              custom={navDir}
              variants={NAV_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-10"
            >
              {listView}
            </motion.div>
          ) : null}
          {current === "chat" ? (
            <motion.div
              key="chat"
              custom={navDir}
              variants={NAV_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-10"
            >
              {chatView}
            </motion.div>
          ) : null}
          {current === "settings" ? (
            <motion.div
              key="settings"
              custom={navDir}
              variants={NAV_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-10"
            >
              {settingsView}
            </motion.div>
          ) : null}
          {current === "admins" ? (
            <motion.div
              key="admins"
              custom={navDir}
              variants={NAV_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-10"
            >
              {adminsView}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 加群确认面板（最高层级 push） */}
        <AnimatePresence>
          {joinPanelView ? (
            <motion.div
              key="join-panel"
              initial={{ x: "100%" }}
              animate={{ x: "0%" }}
              exit={{ x: "100%" }}
              transition={{ type: "tween", duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-30"
            >
              {joinPanelView}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* 一键部署结果详情（喂饭级指引 + 链接复制） */}
        <AnimatePresence>
          {deployResult ? (
            <motion.div
              key="deploy-sheet"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-40 flex items-end justify-center bg-black/40"
              onClick={() => setDeployResult(null)}
            >
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                className="max-h-[80%] w-full overflow-y-auto rounded-t-2xl bg-white px-5 pb-6 pt-4"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-label="一键部署结果"
              >
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-black/15" aria-hidden />
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="rounded-full px-2.5 py-1 text-[12px] font-semibold text-white"
                    style={{
                      backgroundColor:
                        deployResult.stage === "deployed" ? IOS_GREEN : "#f5a623",
                    }}
                  >
                    {deployResult.stage === "deployed"
                      ? "✓ 部署成功"
                      : deployResult.stage === "add_bot"
                        ? "缺步骤：机器人不在群里"
                        : deployResult.stage === "promote_admin"
                          ? "缺步骤：还不是管理员"
                          : deployResult.stage === "grant_permission"
                            ? "缺权限：未开启「邀请用户」"
                            : "部署结果"}
                  </span>
                  <span className="truncate text-[13px] text-[#8e8e93]">
                    {deployResult.chat_title ?? ""}
                    {deployResult.bot_username ? ` · @${deployResult.bot_username}` : ""}
                  </span>
                </div>
                <p className="mb-3 text-[14px] leading-relaxed text-[#3b4a54]">{deployResult.message}</p>
                {deployResult.stage === "deployed" && deployResult.invite_link ? (
                  <div className="mb-3 rounded-xl p-3" style={{ backgroundColor: "rgba(52,199,89,0.1)" }}>
                    <p className="mb-1.5 text-[12px] font-medium text-[#1e8e3e]">
                      入群申请链接（发给买家 / 配置到闲鱼自动发货）
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px] text-black">
                        {deployResult.invite_link}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(deployResult.invite_link ?? "");
                          setDeployLinkCopied(true);
                          window.setTimeout(() => setDeployLinkCopied(false), 2000);
                        }}
                        className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-white"
                        style={{ backgroundColor: IOS_BLUE }}
                      >
                        {deployLinkCopied ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {deployResult.guide && deployResult.guide.length > 0 ? (
                  <div className="rounded-xl bg-black/[0.04] p-3">
                    <p className="mb-1.5 text-[12px] font-medium text-black">下一步操作</p>
                    <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-[#3b4a54]">
                      {deployResult.guide.map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setDeployResult(null)}
                  className="mt-4 w-full cursor-pointer rounded-full bg-black/[0.06] py-3 text-[16px] font-semibold text-black"
                >
                  知道了
                </button>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* iOS 深色 flash 提示 */}
        <AnimatePresence>
          {flash ? (
            <motion.div
              key="flash"
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              className="pointer-events-none absolute left-1/2 top-3 z-40 w-[86%] -translate-x-1/2"
              role="status"
            >
              <div
                className="rounded-2xl px-4 py-2.5 text-center text-[13px] font-medium leading-relaxed text-white shadow-lg"
                style={{ backgroundColor: flash.ok ? "rgba(30,142,62,0.92)" : "rgba(190,44,44,0.92)" }}
              >
                {flash.text}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
