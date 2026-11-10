"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { opsFetch } from "@/lib/remote-ops";
import {
  Check,
  ChevronRight,
  CircleUserRound,
  Copy,
  Hand,
  Heart,
  Info,
  Link2,
  ListTree,
  Loader2,
  MessageCircle,
  MessageSquareText,
  Paintbrush,
  Phone,
  PlayCircle,
  RefreshCw,
  Rocket,
  Search,
  Settings2,
  ShieldBan,
  ShieldCheck,
  HeartPulse,
  SquarePen,
  Trash2,
  UserRoundPlus,
  Users,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Switch } from "@/components/ui/switch";
import {
  renderMenuTemplate,
  type BotMenuConfig,
  type MenuTemplateVars,
} from "@/services/menu-config";
import { TgDesktopChat } from "@/components/admin/tg-desktop-chat";
import { TgProxyPanel } from "@/components/admin/tg-proxy-panel";
import { TgNewGroupPanel, type NewGroupBot } from "@/components/admin/tg-new-group-panel";

/**
 * Telegram 桌面客户端仿真外壳（机器人测试页仿真屏，v2.0.14）。
 *
 * 桌面双栏布局（复刻 Telegram Desktop macOS 截图1/截图2）：
 *   · 左侧会话列表窗口卡（红绿灯标题栏 + 搜索框 + 群组行 + 底部 Tab，样式与旧版列表一致）
 *   · 右侧群组内对话区域：未选会话时为壁纸空态（「选择一个会话开始聊天」），
 *     点击左侧群组即在右侧打开聊天（TgDesktopChat），切换群组右侧同步切换
 *   · 群组设置 / 机器人权限 / 加群确认面板 / 部署结果以浮层展示
 *
 * 数据边界：组件只做视图编排与 API 读写，群组数据/验证会话状态由父组件
 * （testing-client）持有，保证仿真屏与页面上方（会话徽章）状态一致。
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

/** v2.0.16 待处理加群申请（/api/admin/bots/testing/join-requests GET 返回项） */
interface PendingJoinRequest {
  id: string;
  token: string;
  user_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  request_time: string;
  request_type: string;
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

/** 邀请链接台账条目（/api/admin/telegram/invite-links GET 返回项） */
interface SimInviteLinkEntry {
  id: string;
  bot_id: string | null;
  chat_id: string;
  link: string;
  name: string | null;
  creates_join_request: boolean;
  is_revoked: boolean;
  source: string;
  created_time: string;
  updated_time: string;
}

/** 浮层动画（设置/权限/加群确认面板：右侧滑入） */
const OVERLAY_VARIANTS = {
  enter: { x: "100%" },
  center: { x: "0%" },
  exit: { x: "100%" },
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
function ListTime({ iso, active }: { iso: string; active?: boolean }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const update = (): void => setValue(formatListTime(iso));
    update();
    const timer = window.setInterval(update, 30000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return (
    <span className={`shrink-0 text-[13px] ${active ? "text-white/85" : "text-[#8e8e93]"}`}>{value}</span>
  );
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

/**
 * Telegram 桌面端绿色涂鸦壁纸（截图1/截图2 背景）：
 * 绿色渐变底 + 白色描边涂鸦图案（SVG pattern 内联渲染，避免 data-URI 编码问题）。
 */
function DoodleWallpaper() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ backgroundColor: "#94bd8a" }} aria-hidden>
      <div
        className="absolute inset-0"
        style={{ backgroundImage: "linear-gradient(160deg, #a9cb9a 0%, #8fb886 48%, #9dc191 100%)" }}
      />
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="tg-desktop-doodles" width="300" height="300" patternUnits="userSpaceOnUse">
            <g
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.32"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* 爱心 */}
              <path d="M38 64c-9-8.5-15-14-15-21.5C23 36 28 31 34.5 31c3.6 0 6.5 2.4 3.5 5.8C41 33.4 44 31 47.5 31 54 31 59 36 59 42.5 59 50 53 55.5 44 64l-6 5.4z" transform="scale(0.62) translate(8 -18)" />
              {/* 五角星 */}
              <path d="M156 20l5.4 11 12.1 1.7-8.8 8.5 2.1 12-10.8-5.7-10.8 5.7 2.1-12-8.8-8.5 12.1-1.7z" />
              {/* 笑脸 */}
              <circle cx="262" cy="52" r="13" />
              <circle cx="257.5" cy="49" r="1.3" fill="#ffffff" stroke="none" />
              <circle cx="266.5" cy="49" r="1.3" fill="#ffffff" stroke="none" />
              <path d="M256.5 55c1.6 2.2 4 3.4 5.5 3.4s3.9-1.2 5.5-3.4" />
              {/* 纸飞机 */}
              <path d="M52 138l52-18-34 38-5.5-13.5z" />
              <path d="M64.5 144.5L104 120" />
              {/* 音符 */}
              <path d="M204 158v-26l16-5v26" />
              <circle cx="200" cy="158" r="4.6" />
              <circle cx="216" cy="153" r="4.6" />
              {/* 小房子 */}
              <path d="M30 216l15-13 15 13" />
              <path d="M35 212v18h20v-18" />
              <path d="M42 230v-9h6v9" />
              {/* 螺旋 */}
              <path d="M148 246c0-5 4-9 9-9s9 4 9 9-4 9-9 9-13-4-13-11 6-15 15-15 16 7 16 17" />
              {/* 气球 */}
              <ellipse cx="258" cy="222" rx="11" ry="13" />
              <path d="M258 235l-2.5 5h5z" />
              <path d="M258 240c0 8-6 10-6 17" />
              {/* 十字与圆点散布 */}
              <path d="M112 62v10M107 67h10" />
              <path d="M236 116v8M232 120h8" />
              <circle cx="86" cy="196" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="176" cy="96" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="30" cy="150" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="284" cy="160" r="2.2" fill="#ffffff" stroke="none" />
              {/* 云朵 */}
              <path d="M92 268c-5 0-8-3.4-8-7.6 0-4.2 3.4-7.4 7.6-7.4 1.2-4.6 5.4-7.6 10-7.2 4.4.4 8 3.6 8.8 7.8 3.8.4 6.6 3.4 6.6 7 0 4-3.2 7.4-7.6 7.4z" />
            </g>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#tg-desktop-doodles)" />
      </svg>
    </div>
  );
}

type Screen = "chat" | "settings" | "admins" | "proxy" | "newgroup" | "apiconfig" | "botcheck";

/** v2.1.2 真实群消息（chat_messages 台账，/api/admin/telegram/chat-messages 返回项） */
export interface RealChatMessage {
  id: string;
  message_id: number | null;
  user_id: string | null;
  username: string | null;
  first_name: string | null;
  from_bot: boolean;
  kind: string;
  text: string | null;
  message_time: string | null;
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
  onBackToList,
  onSyncGroups,
  syncing,
  onDeployGroup,
  deployingChatId,
  onSimulateJoinForGroup,
  onSettingsSaved,
  bots,
  realMessages,
  realMessagesState,
  onRefreshRealMessages,
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
  /** 移动端从聊天区返回列表（桌面端双栏常驻不需要） */
  onBackToList?: () => void;
  onSyncGroups: () => void;
  syncing: boolean;
  /** 一键部署：父组件调用 deploy API，返回校验结果（stage/guide 由部署面板展示） */
  onDeployGroup: (chatId: string) => Promise<{
    ok: boolean;
    message: string;
    stage?: string;
    guide?: string[];
    invite_link?: string | null;
    chat_title?: string | null;
    reused?: boolean;
    chat_id?: string | null;
    migrated_from_chat_id?: string | null;
  } | null>;
  deployingChatId: string | null;
  /** 从列表/加群确认面板发起模拟加群申请（父组件创建验证会话并切换视图） */
  onSimulateJoinForGroup: (chatId: string) => Promise<{ ok: boolean; message: string }>;
  /** 群组设置保存成功后由父组件刷新列表数据（router.refresh + realGroups 重载） */
  onSettingsSaved: () => void;
  /** v2.0.15 新建群组流程的机器人列表（已有机器人，替代 APP「选择用户」） */
  bots: NewGroupBot[];
  /** v2.1.2 真实群消息（父组件按 bot 权限视角拉取的 chat_messages 台账） */
  realMessages?: RealChatMessage[];
  /** 真实消息加载状态（v2.1.3 起父组件只在展现时获取，无轮询） */
  realMessagesState?: { loading: boolean; fetchedAt: string | null; error: string | null };
  /** v2.1.3 手动刷新真实群消息（聊天区同步胶囊刷新按钮，绕过展现去重强制拉取） */
  onRefreshRealMessages?: () => void | Promise<void>;
}) {
  // —— 浮层屏幕：chat=聊天区（默认初始界面），settings=群组设置，admins=机器人权限 ——
  const [screen, setScreen] = useState<Screen>("chat");

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

  // —— 会话列表搜索（普通文本过滤；加群链接 → 打开确认面板）——
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
      const response = await opsFetch(
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

  // —— v2.0.16 加群申请列表（聊天区顶部横幅点击 → 上滑面板，复刻真实 APP） ——
  const [joinSheetOpen, setJoinSheetOpen] = useState(false);
  const [joinRequests, setJoinRequests] = useState<PendingJoinRequest[]>([]);
  const [joinRequestsLoading, setJoinRequestsLoading] = useState(false);
  /** 正在审批中的申请 token（按钮 spinner；一个群同时只审批一条） */
  const [joinActionToken, setJoinActionToken] = useState<string | null>(null);

  const loadJoinRequests = useCallback(
    async (chatId: string): Promise<void> => {
      setJoinRequestsLoading(true);
      try {
        const response = await opsFetch(
          `/api/admin/bots/testing/join-requests?chat_id=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        const payload = await readJson<{ ok: boolean; error?: string; data?: { items?: PendingJoinRequest[] } }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}）`);
          return;
        }
        if (!payload.ok || !payload.data) {
          showFlash(false, payload.error ?? "读取加群申请失败");
          return;
        }
        setJoinRequests(payload.data.items ?? []);
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "读取加群申请失败");
      } finally {
        setJoinRequestsLoading(false);
      }
    },
    [showFlash],
  );

  /** 打开上滑申请列表：拉取当前群组待处理申请 */
  const openJoinRequests = useCallback((): void => {
    if (!activeChatId) return;
    setJoinSheetOpen(true);
    void loadJoinRequests(activeChatId);
  }, [activeChatId, loadJoinRequests]);

  /** 通过 / 拒绝申请：真实 Telegram 同步 + 落库（与「加群申请」管理页同源），成功后刷新列表与徽章 */
  const handleJoinAction = useCallback(
    async (request: PendingJoinRequest, action: "approve" | "deny"): Promise<void> => {
      if (!activeChatId || joinActionToken) return;
      setJoinActionToken(request.token);
      try {
        const response = await opsFetch("/api/admin/bots/testing/join-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: activeChatId,
            token: request.token,
            action,
            bot_id: selectedBotId,
          }),
        });
        const payload = await readJson<{ ok: boolean; error?: string; data?: { notice?: string } }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}）`);
          return;
        }
        if (!payload.ok) {
          showFlash(false, payload.error ?? (action === "approve" ? "批准失败" : "拒绝失败"));
          return;
        }
        showFlash(true, payload.data?.notice ?? (action === "approve" ? "已批准该加群申请" : "已拒绝该加群申请"));
        // 从列表移除已处理项 + 刷新页面数据（列表徽章/横幅计数同步减少）
        setJoinRequests((prev) => prev.filter((item) => item.token !== request.token));
        onSettingsSaved();
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "审批失败");
      } finally {
        setJoinActionToken(null);
      }
    },
    [activeChatId, joinActionToken, selectedBotId, showFlash, onSettingsSaved],
  );

  /** 申请时间（北京时间 Asia/Shanghai）：客户端渲染（面板仅在点击后出现），无水合风险 */
  const formatRequestTime = useCallback((iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }, []);

  /** 上滑面板唯一待处理申请（1 条时直接展示用户卡片 + 通过/拒绝两个按钮，与真实 APP 一致） */
  const singleJoinRequest = joinRequests.length === 1 ? joinRequests[0] : null;

  // —— 一键部署 ——
  const [deployResult, setDeployResult] = useState<{
    stage?: string;
    message: string;
    guide?: string[];
    invite_link?: string | null;
    chat_title?: string;
    bot_username?: string | null;
    reused?: boolean;
    migrated_from_chat_id?: string | null;
  } | null>(null);
  const [deployLinkCopied, setDeployLinkCopied] = useState(false);

  const handleDeploy = useCallback(async (chatId: string): Promise<void> => {
    const result = await onDeployGroup(chatId);
    if (!result) return;
    if (result.ok && result.stage === "deployed") {
      showFlash(
        true,
        result.reused
          ? "部署完成：复用已生成的有效邀请链接"
          : "部署完成：申请制入群链接已生成并保存",
      );
    } else {
      showFlash(false, result.message || "部署校验未通过，请按指引操作");
    }
    // 详情（含喂饭级 guide / 链接）以浮层展示；
    // chat_title 优先用服务端返回（迁移后新群的标题，本地列表可能还是旧数据）
    setDeployLinkCopied(false);
    setDeployResult({
      stage: result.stage,
      message: result.message,
      guide: result.guide,
      invite_link: result.invite_link,
      chat_title: result.chat_title ?? groups.find((group) => group.chatId === chatId)?.chatTitle,
      bot_username: botUsername,
      reused: result.reused,
      migrated_from_chat_id: result.migrated_from_chat_id ?? null,
    });
  }, [onDeployGroup, showFlash, groups, botUsername]);

  // —— 群组设置页状态 ——
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
    verification_channel: "auto" as "auto" | "group" | "dm",
    kick_direct_joins: false,
    reply_code_in_group: false,
  });

  const loadGroupSettings = useCallback(async (chatId: string): Promise<void> => {
    setSettingsLoading(true);
    try {
      const response = await opsFetch(
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
            verification_channel?: string;
            kick_direct_joins?: boolean;
            reply_code_in_group?: boolean;
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
        verification_channel:
          settings?.verification_channel === "dm"
            ? "dm"
            : settings?.verification_channel === "group"
              ? "group"
              : "auto",
        kick_direct_joins: settings?.kick_direct_joins ?? false,
        reply_code_in_group: settings?.reply_code_in_group ?? false,
      });
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取群组配置失败");
    } finally {
      setSettingsLoading(false);
    }
  }, [showFlash]);

  const saveGroupSettings = useCallback(async (): Promise<void> => {
    if (settingsSaving) return;
    if (!activeChatId) {
      // 绝不静默：无法保存时必须给出明确反馈（否则用户点击 ✓ 后无任何反应，
      // 误以为已保存 —— 2026-11-09 用户投诉「保存后重进验证渠道仍为自动」）
      showFlash(false, "未选中群组，无法保存：请先在会话列表选择一个群组再进设置");
      return;
    }
    setSettingsSaving(true);
    try {
      const response = await opsFetch("/api/admin/bots/testing/group-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: activeChatId,
          chat_title: form.chat_title,
          method: form.method,
          // 透传所选绑定方法（服务端与群组管理 saveGroupAction 同语义落库保留）
          method_id: form.method_id || null,
          timeout_seconds: Number(form.timeout_seconds) || 300,
          max_attempts: Number(form.max_attempts) || 3,
          prompt_text: form.prompt_text,
          success_text: form.success_text,
          failure_text: form.failure_text,
          enabled: form.enabled,
          privacy_mode: form.privacy_mode,
          verification_channel: form.verification_channel,
          kick_direct_joins: form.kick_direct_joins,
          reply_code_in_group: form.reply_code_in_group,
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
      // iOS 群组信息语义：右上角 ✓ = 保存并返回上一页（聊天区）
      setScreen("chat");
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "保存失败");
    } finally {
      setSettingsSaving(false);
    }
  }, [activeChatId, settingsSaving, form, showFlash, onSettingsSaved]);

  // 打开设置浮层时加载该群当前配置
  useEffect(() => {
    if (screen === "settings" && activeChatId) void loadGroupSettings(activeChatId);
  }, [screen, activeChatId, loadGroupSettings]);

  // —— v2.2.7 群组真实状态快照（展示时实时调用 getChat，绝不硬编码假数据） ——
  interface ChatStateSnapshot {
    id: string;
    type: string;
    title: string | null;
    username: string | null;
    active_usernames: string[];
    is_forum: boolean;
    has_visible_history: boolean;
    has_available_reactions: boolean;
    available_reactions_count: number | null;
    max_reaction_count: number | null;
    has_custom_appearance: boolean;
    has_protected_content: boolean;
  }
  const [chatState, setChatState] = useState<ChatStateSnapshot | null>(null);
  const [chatStateError, setChatStateError] = useState<string | null>(null);
  const [chatStateLoading, setChatStateLoading] = useState(false);

  const loadChatState = useCallback(
    async (chatId: string): Promise<void> => {
      setChatStateLoading(true);
      setChatStateError(null);
      try {
        const response = await opsFetch(
          `/api/admin/bots/testing/chat-state?bot_id=${encodeURIComponent(selectedBotId)}&chat_id=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        const payload = await readJson<{ ok: boolean; error?: string; chat?: ChatStateSnapshot }>(response);
        if (!payload) {
          setChatStateError(`服务返回异常（HTTP ${response.status}）`);
          return;
        }
        if (!payload.ok || !payload.chat) {
          setChatStateError(payload.error ?? "读取失败");
          return;
        }
        setChatState(payload.chat);
      } catch (error) {
        setChatStateError(error instanceof Error ? error.message : "网络失败");
      } finally {
        setChatStateLoading(false);
      }
    },
    [selectedBotId],
  );

  // 打开设置浮层时实时拉取该群真实状态（展示时获取，与 Telegram 侧同步）
  useEffect(() => {
    if (screen === "settings" && activeChatId) void loadChatState(activeChatId);
  }, [screen, activeChatId, loadChatState]);

  /** 群组信息行右侧真实值（chatState 展示时实时获取；加载/失败如实展示，绝无假数据） */
  const chatStateValue = (row: "type" | "history" | "reactions" | "appearance" | "topics"): string => {
    if (chatStateLoading) return "…";
    if (!chatState) return "—";
    switch (row) {
      case "type": {
        const visibility =
          chatState.active_usernames.length > 0 ? "公开" : "私密";
        if (chatState.type === "supergroup") return `超级群组 · ${visibility}`;
        if (chatState.type === "group") return `群组 · ${visibility}`;
        if (chatState.type === "channel") return "频道";
        return chatState.type;
      }
      case "history":
        return chatState.has_visible_history ? "新成员可见" : "新成员不可见";
      case "reactions": {
        if (!chatState.has_available_reactions) return "全部表情";
        const count = chatState.available_reactions_count ?? 0;
        return count === 0 ? "已停用" : `限 ${count} 种表情`;
      }
      case "appearance":
        return chatState.has_custom_appearance ? "自定义外观" : "默认外观";
      case "topics":
        return chatState.is_forum ? "已启用" : "已禁用";
    }
  };

  // —— v2.2.7 机器人关键节点真实检测（顺序逐节点真实执行，❌ 即停） ——
  interface BotCheckPlanNode {
    key: string;
    label: string;
    hint: string;
  }
  interface BotCheckResult {
    key: string;
    label: string;
    ok: boolean;
    ms: number;
    detail: string;
    error?: string;
    suggestion?: string;
  }
  const [checkPlan, setCheckPlan] = useState<BotCheckPlanNode[] | null>(null);
  const [checkResults, setCheckResults] = useState<BotCheckResult[]>([]);
  /** 当前正在真实检测的节点下标（-1 = 空闲） */
  const [checkRunningIndex, setCheckRunningIndex] = useState(-1);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** 检测已启动过（用于区分「未检测」与「空闲展示」） */
  const [checkStarted, setCheckStarted] = useState(false);
  const checkRunIdRef = useRef(0);

  /** 加载检测计划（打开浮层时；只读不发网络请求 Telegram） */
  const loadCheckPlan = useCallback(async (): Promise<void> => {
    setCheckPlan(null);
    setCheckResults([]);
    setCheckRunningIndex(-1);
    setCheckError(null);
    setCheckStarted(false);
    try {
      const response = await opsFetch("/api/admin/bots/testing/bot-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: selectedBotId }),
      });
      const payload = await readJson<{ ok: boolean; error?: string; plan?: BotCheckPlanNode[] }>(response);
      if (!payload) {
        setCheckError(`服务返回异常（HTTP ${response.status}）`);
        return;
      }
      if (!payload.ok || !payload.plan) {
        setCheckError(payload.error ?? "读取检测计划失败");
        return;
      }
      setCheckPlan(payload.plan);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "网络失败");
    }
  }, [selectedBotId]);

  /** 按顺序逐节点真实检测：通过打 ✅ 继续，❌ 停止（后续节点保持未检测） */
  const runBotCheck = useCallback(async (): Promise<void> => {
    if (!checkPlan || checkRunningIndex >= 0) return;
    const runId = ++checkRunIdRef.current;
    setCheckStarted(true);
    setCheckResults([]);
    setCheckError(null);
    for (let index = 0; index < checkPlan.length; index++) {
      if (checkRunIdRef.current !== runId) return; // 已被新的检测轮次取代
      setCheckRunningIndex(index);
      try {
        const response = await opsFetch("/api/admin/bots/testing/bot-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bot_id: selectedBotId, index }),
        });
        const payload = await readJson<{ ok: boolean; error?: string; result?: BotCheckResult }>(response);
        if (checkRunIdRef.current !== runId) return;
        if (!payload) {
          setCheckError(`服务返回异常（HTTP ${response.status}）`);
          setCheckRunningIndex(-1);
          return;
        }
        if (!payload.ok || !payload.result) {
          setCheckError(payload.error ?? `节点 ${checkPlan[index].label} 检测失败`);
          setCheckRunningIndex(-1);
          return;
        }
        setCheckResults((prev) => [...prev, payload.result!]);
        if (!payload.result.ok) {
          // ❌：停止后续节点（真实检测语义）
          setCheckRunningIndex(-1);
          return;
        }
      } catch (error) {
        if (checkRunIdRef.current !== runId) return;
        setCheckError(error instanceof Error ? error.message : "网络失败");
        setCheckRunningIndex(-1);
        return;
      }
    }
    if (checkRunIdRef.current !== runId) return;
    setCheckRunningIndex(-1);
  }, [checkPlan, checkRunningIndex, selectedBotId]);

  // 打开检测浮层时加载计划
  useEffect(() => {
    if (screen === "botcheck") void loadCheckPlan();
  }, [screen, loadCheckPlan]);

  // —— v2.1.2 外部验证 API 配置浮层（验证渠道 code_api 分支入口，iOS 风格页） ——
  const [apiConfigLoading, setApiConfigLoading] = useState(false);
  const [apiConfigSaving, setApiConfigSaving] = useState(false);
  const [apiConfigMethodId, setApiConfigMethodId] = useState<string | null>(null);
  const [apiConfigMethodName, setApiConfigMethodName] = useState<string | null>(null);
  const [apiForm, setApiForm] = useState({
    url: "",
    http_method: "POST" as "GET" | "POST",
    api_key: "",
    code_field: "code",
    body_template: "",
    success_status: "200",
    success_field: "success",
    success_value: "true",
    timeout_seconds: "30",
  });
  const [testCode, setTestCode] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const loadApiConfig = useCallback(
    async (chatId: string): Promise<void> => {
      setApiConfigLoading(true);
      setTestResult(null);
      try {
        const response = await opsFetch(
          `/api/admin/bots/testing/method-config?chat_id=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        const payload = await readJson<{
          ok: boolean;
          error?: string;
          data?: {
            method_id: string | null;
            method_name: string | null;
            config: {
              url: string;
              api_key: string;
              http_method: string;
              code_field?: string;
              body_template?: string;
              success_status: number;
              success_field?: string;
              success_value: string;
              timeout_seconds: number;
            } | null;
          };
        }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}）`);
          return;
        }
        if (!payload.ok || !payload.data) {
          showFlash(false, payload.error ?? "读取验证 API 配置失败");
          return;
        }
        setApiConfigMethodId(payload.data.method_id);
        setApiConfigMethodName(payload.data.method_name);
        const config = payload.data.config;
        setApiForm({
          url: config?.url ?? "",
          http_method: config?.http_method === "GET" ? "GET" : "POST",
          api_key: config?.api_key ?? "",
          code_field: config?.code_field ?? "code",
          body_template: config?.body_template ?? "",
          success_status: String(config?.success_status ?? 200),
          success_field: config?.success_field ?? "success",
          success_value: config?.success_value ?? "true",
          timeout_seconds: String(config?.timeout_seconds ?? 30),
        });
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "读取验证 API 配置失败");
      } finally {
        setApiConfigLoading(false);
      }
    },
    [showFlash],
  );

  // 打开 API 配置浮层时加载该群当前绑定的配置（未绑定过时展示默认模板）
  useEffect(() => {
    if (screen === "apiconfig" && activeChatId) void loadApiConfig(activeChatId);
  }, [screen, activeChatId, loadApiConfig]);

  const saveApiConfig = useCallback(async (): Promise<void> => {
    if (!activeChatId || apiConfigSaving) return;
    const url = apiForm.url.trim();
    const apiKey = apiForm.api_key.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      showFlash(false, "验证 API 地址不合法（需 http/https 开头）");
      return;
    }
    if (!apiKey) {
      showFlash(false, "请填写 Bearer API Key");
      return;
    }
    setApiConfigSaving(true);
    try {
      const response = await opsFetch("/api/admin/bots/testing/method-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: activeChatId,
          config: {
            url,
            api_key: apiKey,
            http_method: apiForm.http_method,
            code_field: apiForm.code_field.trim() || "code",
            ...(apiForm.http_method === "POST" && apiForm.body_template.trim()
              ? { body_template: apiForm.body_template.trim() }
              : {}),
            success_status: Number(apiForm.success_status) || 200,
            success_field: apiForm.success_field.trim() || "success",
            success_value: apiForm.success_value.trim() || "true",
            timeout_seconds: Math.min(Math.max(Number(apiForm.timeout_seconds) || 30, 5), 60),
          },
        }),
      });
      const payload = await readJson<{
        ok: boolean;
        error?: string;
        data?: { method_id: string; method_name: string };
      }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}）`);
        return;
      }
      if (!payload.ok || !payload.data) {
        showFlash(false, payload.error ?? "保存失败");
        return;
      }
      setApiConfigMethodId(payload.data.method_id);
      setApiConfigMethodName(payload.data.method_name);
      // 同步群设置表单的绑定下拉（验证方式=code_api、绑定该方法），保证设置页回显一致
      setForm((prev) => ({ ...prev, method: "code_api", method_id: payload.data?.method_id ?? prev.method_id }));
      showFlash(true, "验证 API 配置已保存（与「验证方式」页同一数据源，仿真与真实验证共用）");
      onSettingsSaved();
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "保存失败");
    } finally {
      setApiConfigSaving(false);
    }
  }, [activeChatId, apiConfigSaving, apiForm, showFlash, onSettingsSaved]);

  const runApiTest = useCallback(async (): Promise<void> => {
    if (!activeChatId || testRunning) return;
    const code = testCode.trim();
    if (!code) {
      setTestResult({ ok: false, text: "请输入测试验证码" });
      return;
    }
    setTestRunning(true);
    setTestResult(null);
    try {
      const response = await opsFetch("/api/admin/bots/testing/method-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: activeChatId, code }),
      });
      const payload = await readJson<{
        ok: boolean;
        error?: string;
        data?: { ok: boolean; message: string; network_error?: boolean };
      }>(response);
      if (!payload) {
        setTestResult({ ok: false, text: `服务返回异常（HTTP ${response.status}）` });
        return;
      }
      if (!payload.ok) {
        setTestResult({ ok: false, text: payload.error ?? "测试失败" });
        return;
      }
      const result = payload.data;
      setTestResult({
        ok: result?.ok === true,
        text: result?.ok ? `✓ 验证通过：${result.message}` : `✗ ${result?.message ?? "验证未通过"}`,
      });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setTestRunning(false);
    }
  }, [activeChatId, testCode, testRunning]);

  // —— 机器人权限浮层状态 ——
  const [adminsLoading, setAdminsLoading] = useState(false);
  const [adminsSaving, setAdminsSaving] = useState(false);
  const [adminRights, setAdminRights] = useState<Record<string, boolean>>({});
  const [adminRecord, setAdminRecord] = useState<{ bot_name: string | null; bot_username: string | null } | null>(null);
  // —— 邀请链接台账（管理员权限页底部；与群组管理邀请链接弹窗同一 API 同一台账） ——
  const [inviteLinks, setInviteLinks] = useState<SimInviteLinkEntry[]>([]);
  const [inviteLinksLoading, setInviteLinksLoading] = useState(false);
  const [inviteBusyId, setInviteBusyId] = useState<string | null>(null);

  const loadBotAdmins = useCallback(async (chatId: string): Promise<void> => {
    setAdminsLoading(true);
    try {
      const response = await opsFetch(
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
      const response = await opsFetch("/api/admin/bots/testing/bot-admins", {
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
      // 与机器人管理员弹窗同源：以 Telegram 实际权限为准回显
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

  // —— 邀请链接台账读写（GET 列表 / POST action=delete 仅删台账记录，与群组管理弹窗同 API） ——
  const loadInviteLinks = useCallback(async (chatId: string): Promise<void> => {
    setInviteLinksLoading(true);
    try {
      const params = new URLSearchParams({ chat_id: chatId });
      if (selectedBotId) params.set("bot_id", selectedBotId);
      const response = await opsFetch(
        `/api/admin/telegram/invite-links?${params.toString()}`,
        { cache: "no-store" },
      );
      const payload = await readJson<{ ok: boolean; error?: string; data?: { links: SimInviteLinkEntry[] } }>(response);
      if (!payload) {
        showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok) {
        showFlash(false, payload.error ?? "读取邀请链接失败");
        return;
      }
      setInviteLinks(payload.data?.links ?? []);
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取邀请链接失败");
    } finally {
      setInviteLinksLoading(false);
    }
  }, [selectedBotId, showFlash]);

  const deleteInviteLink = useCallback(
    async (linkId: string): Promise<void> => {
      if (!activeChatId || inviteBusyId) return;
      setInviteBusyId(linkId);
      try {
        const response = await opsFetch("/api/admin/telegram/invite-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: activeChatId,
            bot_id: selectedBotId,
            action: "delete",
            link_id: linkId,
          }),
        });
        const payload = await readJson<{ ok: boolean; error?: string; data?: { message?: string } }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
          return;
        }
        if (!payload.ok) {
          showFlash(false, payload.error ?? "删除邀请链接失败");
          return;
        }
        showFlash(true, payload.data?.message ?? "邀请链接记录已删除");
        await loadInviteLinks(activeChatId);
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "删除邀请链接失败");
      } finally {
        setInviteBusyId(null);
      }
    },
    [activeChatId, inviteBusyId, selectedBotId, showFlash, loadInviteLinks],
  );

  // 打开权限浮层时加载当前机器人对该群的权限 + 邀请链接台账
  useEffect(() => {
    if (screen === "admins" && activeChatId) {
      void loadBotAdmins(activeChatId);
      void loadInviteLinks(activeChatId);
    }
  }, [screen, activeChatId, loadBotAdmins, loadInviteLinks]);

  // —— 邀请链接聚合面板（群组信息「邀请链接」行上滑；与群组管理弹窗同一台账 API） ——
  // 全创建者视角：不带 bot_id 过滤，列出该群全部已创建链接（真实台账数据，
  // Telegram APP「邀请链接」页语义 = 按创建者管理员平铺展示 + 撤销）
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [allInviteLinks, setAllInviteLinks] = useState<SimInviteLinkEntry[]>([]);
  const [allInviteLoading, setAllInviteLoading] = useState(false);
  const [sheetBusyId, setSheetBusyId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  const loadAllInviteLinks = useCallback(
    async (chatId: string): Promise<void> => {
      setAllInviteLoading(true);
      try {
        const response = await opsFetch(
          `/api/admin/telegram/invite-links?chat_id=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        const payload = await readJson<{ ok: boolean; error?: string; data?: { links: SimInviteLinkEntry[] } }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
          return;
        }
        if (!payload.ok) {
          showFlash(false, payload.error ?? "读取邀请链接失败");
          return;
        }
        setAllInviteLinks(payload.data?.links ?? []);
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "读取邀请链接失败");
      } finally {
        setAllInviteLoading(false);
      }
    },
    [showFlash],
  );

  // 打开群组信息浮层时加载全部邀请链接（行右侧真实条数 + 上滑面板同源数据）
  useEffect(() => {
    if (screen === "settings" && activeChatId) void loadAllInviteLinks(activeChatId);
  }, [screen, activeChatId, loadAllInviteLinks]);

  // 每次上滑面板打开时重新拉取台账（台账是活数据：期间可能新增/撤销了链接）
  useEffect(() => {
    if (inviteSheetOpen && activeChatId) void loadAllInviteLinks(activeChatId);
  }, [inviteSheetOpen, activeChatId, loadAllInviteLinks]);

  // 面板动作（撤销/删除）：bot_id 优先取台账记录的创建者，未登记时回退当前选中机器人
  const actOnInviteLink = useCallback(
    async (action: "revoke" | "delete", entry: SimInviteLinkEntry): Promise<void> => {
      if (!activeChatId || sheetBusyId) return;
      setSheetBusyId(entry.id);
      try {
        const response = await opsFetch("/api/admin/telegram/invite-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: activeChatId,
            bot_id: entry.bot_id ?? selectedBotId,
            action,
            link_id: entry.id,
          }),
        });
        const payload = await readJson<{ ok: boolean; error?: string; data?: { message?: string } }>(response);
        if (!payload) {
          showFlash(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
          return;
        }
        if (!payload.ok) {
          showFlash(false, payload.error ?? (action === "revoke" ? "撤销失败" : "删除失败"));
          return;
        }
        showFlash(true, payload.data?.message ?? (action === "revoke" ? "链接已撤销" : "记录已删除"));
        await loadAllInviteLinks(activeChatId);
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "操作失败");
      } finally {
        setSheetBusyId(null);
      }
    },
    [activeChatId, sheetBusyId, selectedBotId, showFlash, loadAllInviteLinks],
  );

  const copyInviteLink = useCallback((entry: SimInviteLinkEntry): void => {
    void navigator.clipboard.writeText(entry.link).then(() => {
      setCopiedLinkId(entry.id);
      window.setTimeout(() => setCopiedLinkId(null), 1500);
    });
  }, []);

  // 按创建者管理员平铺（真实 APP 邀请链接页语义：同创建者的链接归组展示）
  const inviteSheetGroups = useMemo(() => {
    const byCreator = new Map<string, SimInviteLinkEntry[]>();
    for (const entry of allInviteLinks) {
      const key = entry.bot_id ?? "";
      const list = byCreator.get(key) ?? [];
      list.push(entry);
      byCreator.set(key, list);
    }
    return [...byCreator.entries()].map(([key, items]) => ({
      key,
      label: key ? (bots.find((bot) => bot.id === key)?.name ?? `机器人 #${key}`) : "未登记创建者",
      items,
    }));
  }, [allInviteLinks, bots]);

  const activeGroup = useMemo(
    () => groups.find((group) => group.chatId === activeChatId) ?? null,
    [groups, activeChatId],
  );

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

  // —— 设置 / 权限浮层（iOS 风格页，覆盖在聊天区上方） ——
  const settingsOverlay = (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setScreen("chat")}
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
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-white transition-transform active:scale-95 disabled:opacity-60"
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
            {/* 头像区 */}
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
                <p className="mb-2 text-[17px] text-black">验证渠道</p>
                <div className="flex rounded-lg bg-black/[0.05] p-0.5">
                  {([
                    { value: "auto", label: "自动" },
                    { value: "group", label: "群内验证" },
                    { value: "dm", label: "私聊验证" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, verification_channel: option.value }))}
                      className={`flex-1 rounded-[7px] py-1.5 text-[13px] font-medium transition-all ${
                        form.verification_channel === option.value
                          ? "bg-white text-black shadow-sm"
                          : "text-[#8e8e93]"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-[#8e8e93]">
                  {form.verification_channel === "group"
                    ? "群内验证：申请后自动进群，在群内点击按钮完成验证（输入内容其他成员不可见），超时未验证移出群组"
                    : form.verification_channel === "dm"
                      ? "私聊验证：验证提示通过机器人私聊发送（用户须先启动机器人），群内零消息"
                      : "自动（默认）：超级群/频道 → 群内验证；基础群 → 私聊验证（Telegram 限制：基础群不支持申请制入群）"}
                </p>
              </div>
              {/* 直连入群踢出开关（默认关闭）：公开邀请链接/被拉入群的已有用户超时/失败是否移出 */}
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5">
                <span className="text-[17px] leading-snug text-black">
                  直连入群超时踢出
                  <span className="block text-[12px] text-[#8e8e93]">
                    默认关闭：邀请链接/被拉入群的成员验证超时或失败后保留在群内
                  </span>
                </span>
                <Switch
                  checked={form.kick_direct_joins}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, kick_direct_joins: checked }))}
                  className="data-[state=checked]:bg-[#34c759]"
                  aria-label="直连入群超时踢出"
                />
              </div>
              {/* v2.1.5 群内回复输码快速验证（默认关闭）：force_reply 定位输入框 + 验证后自动删除消息 */}
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5">
                <span className="text-[17px] leading-snug text-black">
                  群内回复输码快速验证
                  <span className="block text-[12px] text-[#8e8e93]">
                    默认关闭：开启后群内提示送达即定位输入框，回复输码后自动删除验证码消息
                  </span>
                </span>
                <Switch
                  checked={form.reply_code_in_group}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, reply_code_in_group: checked }))}
                  className="data-[state=checked]:bg-[#34c759]"
                  aria-label="群内回复输码快速验证"
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
                  {/* v2.1.2 验证 API 配置入口：URL + apikey + 传参 + 响应解析 + 联调测试（与「验证方式」页同源） */}
                  <button
                    type="button"
                    onClick={() => setScreen("apiconfig")}
                    className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-lg bg-[#3390ec]/10 px-3 py-2.5 text-left transition-transform active:scale-[0.99]"
                  >
                    <Settings2 className="h-4 w-4 shrink-0 text-[#3390ec]" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-[#3390ec]">配置外部验证 API</span>
                      <span className="block truncate text-[12px] text-[#8e8e93]">
                        {apiConfigMethodName
                          ? `${apiConfigMethodName}（方法 #${apiConfigMethodId ?? "-"}）· 点击修改`
                          : "验证 API 地址 / Bearer apikey / 传参 / 响应解析 / 超时"}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[#c7c7cc]" />
                  </button>
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
                  <span className="block text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                    机器人在群里怎么收验证码。开启（默认）：入群者「回复」机器人发的验证消息提交验证码，机器人只收得到回复，无需读取群内普通消息的权限；关闭：入群者直接在群里发验证码，但机器人必须能读到群内全部消息（需 BotFather 关闭隐私模式或设为群管理员）
                  </span>
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

            {/* 群组信息行（v2.2.7：右侧全部为展示时实时获取的真实状态，无硬编码假数据） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#3390ec">
                  <Users className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">群组类型</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("type")}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#34c759">
                  <MessageSquareText className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">聊天记录</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("history")}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <button
                type="button"
                onClick={() => setInviteSheetOpen(true)}
                className="flex w-full cursor-pointer items-center gap-3 border-b border-black/[0.06] px-4 py-2.5 text-left"
              >
                <IosRowIcon bg="#f5a623">
                  <Link2 className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">邀请链接</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {allInviteLoading ? "…" : String(allInviteLinks.length)}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </button>
              <div className="flex items-center gap-3 border-b border-black/[0.06] px-4 py-2.5">
                <IosRowIcon bg="#eb5545">
                  <Heart className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">表情回应</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("reactions")}
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
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("appearance")}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <IosRowIcon bg="#6ec9cb">
                  <ListTree className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">话题</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("topics")}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </div>
            </div>
            {!chatStateLoading && chatStateError ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-700">
                实时状态获取失败（右侧显示「—」）：{chatStateError}
              </p>
            ) : null}
            <p className="px-1 text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              群聊将被划分为由管理员或用户创建的话题。
            </p>

            {/* 机器人权限配置入口 */}
            <button
              type="button"
              onClick={() => setScreen("admins")}
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

  const adminsOverlay = (
    <div className="relative flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setScreen("settings")}
          aria-label="返回群组设置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">管理员</span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      {/* 滚动内容区：paddingBottom 加高，避免底部浮动保存按钮遮挡最后的内容 */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 pt-4" style={{ paddingBottom: 116 }}>
        {adminsLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
          </div>
        ) : (
          <>
            {/* 机器人信息卡片 */}
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

            {/* 权限开关列表（iOS 绿色开关） */}
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

            {/* 机器人创建的邀请链接台账（与群组管理邀请链接弹窗同一 API） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[17px] text-black">
                  邀请链接
                  <span className="block text-[12px] text-[#8e8e93]">
                    机器人创建的入群邀请链接（台账）
                  </span>
                </span>
                {inviteLinksLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#8e8e93]" />
                ) : (
                  <span className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                    {inviteLinks.length} 条
                  </span>
                )}
              </div>
              {inviteLinks.length > 0 ? (
                inviteLinks.map((entry, index) => (
                  <div
                    key={entry.id}
                    className="border-t border-black/[0.06]"
                  >
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate font-mono text-[13px] text-black"
                          title={entry.link}
                        >
                          {entry.link}
                        </p>
                        <p className="mt-0.5 truncate text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                          <ListTime iso={entry.created_time} />
                          {" · "}
                          {entry.is_revoked ? "已撤销/失效" : "有效"}
                          {entry.name ? ` · ${entry.name}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteInviteLink(entry.id)}
                        disabled={inviteBusyId === entry.id}
                        aria-label="删除邀请链接记录"
                        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#ff3b30] transition-transform active:scale-90 disabled:opacity-50"
                      >
                        {inviteBusyId === entry.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div
                  className="border-t border-black/[0.06] px-4 py-4 text-center text-[13px]"
                  style={{ color: IOS_TEXT_SECONDARY }}
                >
                  暂无记录：机器人在该群创建邀请链接后会自动登记
                </div>
              )}
            </div>

            <p className="px-1 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              「添加成员（邀请用户）」是一键部署生成申请制入群链接的必需权限。
            </p>
          </>
        )}
      </div>

      {/* 固定浮动保存按钮（悬浮于滚动区底部，随内容滚动保持不动） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[#efeff4] via-[#efeff4]/95 to-transparent px-4 pb-5 pt-8">
        <button
          type="button"
          onClick={() => void saveBotAdmins()}
          disabled={adminsSaving}
          className="pointer-events-auto w-full cursor-pointer rounded-full py-3.5 text-[17px] font-semibold text-white shadow-sm transition-transform active:scale-[0.99] disabled:opacity-60"
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
      </div>
    </div>
  );

  // —— v2.1.2 外部验证 API 配置浮层（iOS 风格页：URL/apikey/传参/响应解析/超时 + 联调测试） ——
  const apiConfigOverlay = (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setScreen("settings")}
          aria-label="返回群组设置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">外部验证 API</span>
        <button
          type="button"
          onClick={() => void saveApiConfig()}
          disabled={apiConfigSaving || apiConfigLoading}
          aria-label="保存验证 API 配置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-white transition-transform active:scale-95 disabled:opacity-60"
          style={{ backgroundColor: IOS_GREEN }}
        >
          {apiConfigSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <span className="text-lg font-bold leading-none">✓</span>}
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {apiConfigLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
          </div>
        ) : (
          <>
            <p className="px-1 text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              用户输入验证码后，机器人携带 <span className="font-mono">Authorization: Bearer &lt;apikey&gt;</span>{" "}
              调用下方 API 完成核验；配置保存在「验证方式」库（{apiConfigMethodName ?? "保存时自动创建"}），仿真与真实验证共用。
            </p>

            <div className="space-y-3 rounded-xl bg-white px-4 py-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">验证 API 地址 *</span>
                <input
                  value={apiForm.url}
                  onChange={(event) => setApiForm((prev) => ({ ...prev, url: event.target.value }))}
                  placeholder="https://your-api.example.com/verify"
                  className="w-full rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] text-black outline-none"
                  aria-label="验证 API 地址"
                />
              </label>

              <div>
                <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">请求方式</span>
                <div className="flex rounded-lg bg-black/[0.05] p-0.5">
                  {([
                    { value: "GET", label: "GET（参数拼 URL）" },
                    { value: "POST", label: "POST（JSON 请求体）" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setApiForm((prev) => ({ ...prev, http_method: option.value }))}
                      className={`flex-1 rounded-[7px] py-1.5 text-[13px] font-medium transition-all ${
                        apiForm.http_method === option.value
                          ? "bg-white text-black shadow-sm"
                          : "text-[#8e8e93]"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">Bearer API Key *</span>
                <input
                  value={apiForm.api_key}
                  onChange={(event) => setApiForm((prev) => ({ ...prev, api_key: event.target.value }))}
                  placeholder="sk-xxxx / xyk_xxxx"
                  autoComplete="off"
                  className="w-full rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] text-black outline-none"
                  aria-label="Bearer API Key"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">验证码字段名（传参）</span>
                <input
                  value={apiForm.code_field}
                  onChange={(event) => setApiForm((prev) => ({ ...prev, code_field: event.target.value }))}
                  placeholder="code（兼容 card / key 等自定义字段名）"
                  className="w-full rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] text-black outline-none"
                  aria-label="验证码字段名"
                />
              </label>

              {apiForm.http_method === "POST" ? (
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">
                    请求体模板（可选，{"{{code}} {{user_id}} {{username}}"} 自动替换）
                  </span>
                  <textarea
                    value={apiForm.body_template}
                    onChange={(event) => setApiForm((prev) => ({ ...prev, body_template: event.target.value }))}
                    rows={3}
                    placeholder='{"key":"{{code}}","uid":{{user_id}}}'
                    className="w-full resize-none rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] leading-relaxed text-black outline-none"
                    aria-label="请求体模板"
                  />
                  <span className="mt-1 block text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                    留空时默认发送 {"{ \"" + (apiForm.code_field.trim() || "code") + "\": \"{{code}}\" }"}
                  </span>
                </label>
              ) : null}

              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">成功状态码</span>
                  <input
                    value={apiForm.success_status}
                    onChange={(event) => setApiForm((prev) => ({ ...prev, success_status: event.target.value }))}
                    inputMode="numeric"
                    className="w-full rounded-lg bg-black/[0.04] px-2 py-2 text-center font-mono text-[13px] text-black outline-none"
                    aria-label="成功状态码"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">判定字段</span>
                  <input
                    value={apiForm.success_field}
                    onChange={(event) => setApiForm((prev) => ({ ...prev, success_field: event.target.value }))}
                    placeholder="success"
                    className="w-full rounded-lg bg-black/[0.04] px-2 py-2 font-mono text-[13px] text-black outline-none"
                    aria-label="判定字段"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">判定值</span>
                  <input
                    value={apiForm.success_value}
                    onChange={(event) => setApiForm((prev) => ({ ...prev, success_value: event.target.value }))}
                    placeholder="true"
                    className="w-full rounded-lg bg-black/[0.04] px-2 py-2 font-mono text-[13px] text-black outline-none"
                    aria-label="判定值"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-[#3b4a54]">超时（秒，5~60）</span>
                <input
                  value={apiForm.timeout_seconds}
                  onChange={(event) => setApiForm((prev) => ({ ...prev, timeout_seconds: event.target.value }))}
                  inputMode="numeric"
                  className="w-24 rounded-lg bg-black/[0.04] px-2 py-2 text-center font-mono text-[13px] text-black outline-none"
                  aria-label="超时秒数"
                />
              </label>
            </div>

            {/* 请求预览 */}
            <div className="rounded-xl bg-white px-4 py-3">
              <p className="mb-2 text-[13px] font-medium text-[#3b4a54]">请求预览</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/[0.04] p-2 font-mono text-[11px] leading-relaxed text-[#3b4a54]">
                {apiForm.http_method === "POST"
                  ? `POST ${apiForm.url.trim() || "https://…"}\nAuthorization: Bearer ${apiForm.api_key.trim() || "…"}\nContent-Type: application/json\n\n${apiForm.body_template.trim() || JSON.stringify({ [apiForm.code_field.trim() || "code"]: "{{code}}" })}`
                  : `GET ${apiForm.url.trim() || "https://…"}?user_id=777000&${apiForm.code_field.trim() || "code"}={{code}}&username=preview_user\nAuthorization: Bearer ${apiForm.api_key.trim() || "…"}`}
              </pre>
              <p className="mt-2 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                判定规则：HTTP 状态等于「成功状态码」且响应 JSON 中「判定字段」等于「判定值」即验证通过；
                失败原因（error/msg/message 字段）会透传给用户。
              </p>
            </div>

            {/* 联调测试 */}
            <div className="space-y-2 rounded-xl bg-white px-4 py-3">
              <p className="text-[13px] font-medium text-[#3b4a54]">联调测试（保存后可真实调用一次外部 API）</p>
              <div className="flex gap-2">
                <input
                  value={testCode}
                  onChange={(event) => setTestCode(event.target.value)}
                  placeholder="输入要测试的验证码/卡密"
                  className="h-9 min-w-0 flex-1 rounded-lg bg-black/[0.04] px-3 text-[14px] text-black outline-none"
                  aria-label="测试验证码"
                />
                <button
                  type="button"
                  onClick={() => void runApiTest()}
                  disabled={testRunning || !testCode.trim()}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-4 text-[14px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-60"
                  style={{ backgroundColor: IOS_BLUE }}
                >
                  {testRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  测试
                </button>
              </div>
              {testResult ? (
                <p
                  className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                    testResult.ok ? "bg-[#34c759]/12 text-[#1e8e3e]" : "bg-[#eb5545]/12 text-[#eb5545]"
                  }`}
                  role="status"
                >
                  {testResult.text}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );

  // —— v2.2.7 机器人关键节点真实检测浮层（iOS 风格页：顺序✅/❌ + 耗时 + 错误 + 修复建议） ——
  const checkResultFor = (index: number): BotCheckResult | undefined => checkResults[index];
  const botcheckOverlay = (
    <div className="relative flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setScreen("chat")}
          aria-label="关闭机器人检测"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>
        <span className="text-[17px] font-semibold text-black">机器人检测</span>
        <button
          type="button"
          onClick={() => void loadCheckPlan()}
          disabled={checkRunningIndex >= 0}
          aria-label="重新加载检测计划"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95 disabled:opacity-60"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" style={{ paddingBottom: 116 }}>
        {/* 机器人信息卡 */}
        <div className="flex items-center gap-3 rounded-xl bg-white p-4">
          <GroupAvatar title={botName} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-semibold text-black">{botName}</p>
            <p className="truncate text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
              {botUsername ? `@${botUsername}` : "未获取用户名"} · 关键节点按消息链路顺序真实检测
            </p>
          </div>
        </div>
        <p className="px-1 text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
          每个节点均为真实检测（真实 Telegram API 调用 / 真实数据库读取 / 真实运行实例状态），
          耗时为本次真实耗时；通过打 ✅ 继续下一节点，失败打 ❌ 后停止并给出修复建议。
        </p>

        {/* 节点列表 */}
        {checkError ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-700">{checkError}</p>
        ) : null}
        <div className="overflow-hidden rounded-xl bg-white">
          {!checkPlan ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
            </div>
          ) : (
            checkPlan.map((node, index) => {
              const result = checkResultFor(index);
              const running = checkRunningIndex === index;
              const pending = !result && !running;
              return (
                <div
                  key={`${node.key}-${index}`}
                  className={`px-4 py-3 ${index > 0 ? "border-t border-black/[0.06]" : ""}`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                      {result ? (
                        result.ok ? (
                          <Check className="h-5 w-5 text-[#34c759]" aria-label="通过" />
                        ) : (
                          <X className="h-5 w-5 text-[#eb5545]" aria-label="失败" />
                        )
                      ) : running ? (
                        <Loader2 className="h-4.5 w-4.5 animate-spin text-[#3390ec]" />
                      ) : (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: pending ? "#c7c7cc" : "transparent" }}
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-[16px] font-medium text-black">{node.label}</span>
                    {result ? (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium"
                        style={{
                          backgroundColor: result.ok ? "rgba(52,199,89,0.12)" : "rgba(235,85,69,0.12)",
                          color: result.ok ? "#1e8e3e" : "#eb5545",
                        }}
                      >
                        ⏱ {result.ms}ms
                      </span>
                    ) : null}
                  </div>
                  {!result && !running ? (
                    <p className="mt-1 pl-8.5 text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                      {node.hint}
                    </p>
                  ) : null}
                  {running ? (
                    <p className="mt-1 pl-8.5 text-[13px] text-[#3390ec]">正在真实检测…</p>
                  ) : null}
                  {result?.ok ? (
                    <p className="mt-1 break-words pl-8.5 text-[13px] leading-relaxed text-[#1e8e3e]">{result.detail}</p>
                  ) : null}
                  {result && !result.ok ? (
                    <div className="mt-2 space-y-1.5 pl-8.5">
                      <p className="rounded-lg bg-[#eb5545]/10 px-3 py-2 text-[13px] leading-relaxed break-words text-[#b3261e]">
                        {result.error}
                      </p>
                      {result.suggestion ? (
                        <p className="rounded-lg bg-[#3390ec]/10 px-3 py-2 text-[13px] leading-relaxed break-words text-[#1a5c9e]">
                          💡 修复建议：{result.suggestion}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {checkStarted && checkRunningIndex < 0 && checkPlan ? (
          <p className="px-1 text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
            {checkResults.length === checkPlan.length
              ? `全部 ${checkPlan.length} 个节点检测通过 ✅`
              : `检测已停止：第 ${checkResults.length + 1} 个节点未通过（后续节点未检测）`}
          </p>
        ) : null}
      </div>

      {/* 底部固定动作按钮 */}
      <div className="absolute inset-x-0 bottom-0 border-t border-black/[0.06] bg-white/95 px-4 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => void runBotCheck()}
          disabled={!checkPlan || checkRunningIndex >= 0}
          className="pointer-events-auto w-full cursor-pointer rounded-full py-3.5 text-[17px] font-semibold text-white shadow-sm transition-transform active:scale-[0.99] disabled:opacity-60"
          style={{ backgroundColor: checkStarted ? IOS_GREEN : IOS_BLUE }}
        >
          {checkRunningIndex >= 0 ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              正在按顺序真实检测…
            </span>
          ) : checkStarted ? (
            "重新检测"
          ) : (
            "开始检测"
          )}
        </button>
      </div>
    </div>
  );

  const joinPanelOverlay = joinPanel ? (
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

  const chatPane = activeChatId ? (
    /* 移动端：全屏覆盖列表；桌面端：右侧聊天栏（双栏） */
    <div className="absolute inset-0 z-30 flex min-w-0 flex-1 lg:static lg:z-auto">
      <div className="relative min-w-0 flex-1">
        <DoodleWallpaper />
        <div className="absolute inset-0">
          <TgDesktopChat
            key={`${selectedBotId}-${activeChatId}`}
            config={config}
            botName={botName}
            groupTitle={view === "private" ? botName : (activeGroup?.chatTitle ?? "测试群组")}
            memberCount={memberCount}
            isPrivate={view === "private"}
            systemNote={systemNote}
            templateVars={templateVars}
            promptMessage={promptMessage}
            onUserSend={onUserSend}
            joinPhase={joinPhase}
            onRequestJoin={onRequestJoin}
            onOpenSettings={() => setScreen("settings")}
            onBackToList={onBackToList}
            pendingJoinCount={view === "private" ? 0 : (activeGroup?.unread ?? 0)}
            onOpenJoinRequests={openJoinRequests}
            realMessages={view === "private" ? [] : (realMessages ?? [])}
            realMessagesState={realMessagesState}
            onRefreshRealMessages={onRefreshRealMessages}
          />
        </div>

        {/* 群组设置 / 机器人权限浮层（覆盖聊天区；移动端覆盖全屏） */}
        <AnimatePresence initial={false}>
          {screen === "settings" ? (
            <motion.div
              key="settings"
              variants={OVERLAY_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-40"
            >
              {settingsOverlay}
            </motion.div>
          ) : null}
          {screen === "admins" ? (
            <motion.div
              key="admins"
              variants={OVERLAY_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-40"
            >
              {adminsOverlay}
            </motion.div>
          ) : null}
          {/* v2.1.2 外部验证 API 配置浮层 */}
          {screen === "apiconfig" ? (
            <motion.div
              key="apiconfig"
              variants={OVERLAY_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-40"
            >
              {apiConfigOverlay}
            </motion.div>
          ) : null}
          {/* v2.0.16 加群申请上滑面板（真实 APP：标题条横幅点击 → 底部滑出申请列表） */}
          {joinSheetOpen ? (
            <motion.div
              key="join-requests-sheet"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-0 z-40 flex items-end justify-center bg-black/40"
              onClick={() => setJoinSheetOpen(false)}
            >
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                className="flex max-h-[82%] w-full flex-col overflow-hidden rounded-t-2xl bg-white"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-label="加群申请"
              >
                {/* 顶部把手 + 标题 */}
                <div className="flex items-center justify-between px-5 pb-2 pt-3">
                  <span className="h-1 w-10 rounded-full bg-black/15" aria-hidden />
                  <div className="flex items-center gap-2">
                    <UserRoundPlus className="h-5 w-5 text-[#3390ec]" aria-hidden />
                    <span className="text-[17px] font-semibold text-black">加群申请</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setJoinSheetOpen(false)}
                    aria-label="关闭加群申请"
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="px-5 pb-2 text-[13px] text-[#8e8e93]">
                  {activeGroup?.chatTitle ?? ""} · 共 {joinRequests.length} 条待处理申请
                </p>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
                  {joinRequestsLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
                    </div>
                  ) : joinRequests.length === 0 ? (
                    <div className="px-6 py-10 text-center text-[14px] leading-relaxed text-[#8e8e93]">
                      没有待处理的加群申请
                    </div>
                  ) : singleJoinRequest ? (
                    /* 只有 1 条申请：直接展示用户卡片 + 通过申请 / 拒绝申请 两个按钮（真实 APP 一致） */
                    <div className="flex flex-col items-center pt-2">
                      <GroupAvatar title={
                        [singleJoinRequest.first_name, singleJoinRequest.last_name].filter(Boolean).join(" ") ||
                        (singleJoinRequest.username ? `@${singleJoinRequest.username}` : `用户 ${singleJoinRequest.user_id}`)
                      } size={72} />
                      <p className="mt-2 text-[18px] font-semibold text-black">
                        {[singleJoinRequest.first_name, singleJoinRequest.last_name].filter(Boolean).join(" ") ||
                          (singleJoinRequest.username ? `@${singleJoinRequest.username}` : `用户 ${singleJoinRequest.user_id}`)}
                      </p>
                      <p className="mt-0.5 text-[13px] text-[#8e8e93]">
                        {singleJoinRequest.username ? `@${singleJoinRequest.username} · ` : ""}ID {singleJoinRequest.user_id} · {formatRequestTime(singleJoinRequest.request_time)} 申请
                      </p>
                      <div className="mt-5 flex w-full gap-3">
                        <button
                          type="button"
                          onClick={() => void handleJoinAction(singleJoinRequest, "approve")}
                          disabled={joinActionToken === singleJoinRequest.token}
                          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl py-3.5 text-[16px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                          style={{ backgroundColor: "#34c759" }}
                        >
                          {joinActionToken === singleJoinRequest.token ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <Check className="h-5 w-5" />
                          )}
                          通过申请
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleJoinAction(singleJoinRequest, "deny")}
                          disabled={joinActionToken === singleJoinRequest.token}
                          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl py-3.5 text-[16px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                          style={{ backgroundColor: "#eb5545" }}
                        >
                          {joinActionToken === singleJoinRequest.token ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <X className="h-5 w-5" />
                          )}
                          拒绝申请
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 多条申请：Telegram APP 列表样式（每行头像+名称+时间+✓/✗） */
                    <div className="divide-y divide-black/[0.06]">
                      {joinRequests.map((request) => {
                        const displayName =
                          [request.first_name, request.last_name].filter(Boolean).join(" ") ||
                          (request.username ? `@${request.username}` : `用户 ${request.user_id}`);
                        const busy = joinActionToken === request.token;
                        return (
                          <div key={request.id} className="flex items-center gap-3 py-2.5">
                            <GroupAvatar title={displayName} size={44} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[16px] font-medium text-black">{displayName}</p>
                              <p className="truncate text-[12.5px] text-[#8e8e93]">
                                {request.username ? `@${request.username} · ` : ""}ID {request.user_id} · {formatRequestTime(request.request_time)}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleJoinAction(request, "approve")}
                              disabled={busy}
                              aria-label={`通过 ${displayName} 的加群申请`}
                              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#34c759]/12 text-[#1e8e3e] transition-transform active:scale-95 disabled:opacity-60"
                            >
                              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleJoinAction(request, "deny")}
                              disabled={busy}
                              aria-label={`拒绝 ${displayName} 的加群申请`}
                              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#eb5545]/12 text-[#eb5545] transition-transform active:scale-95 disabled:opacity-60"
                            >
                              <X className="h-5 w-5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  ) : (
    /* 截图1 空态：绿色涂鸦壁纸 + 居中「选择一个会话开始聊天」+ 右上角 ⓘ（仅桌面双栏显示） */
    <div className="relative hidden min-w-0 flex-1 items-center justify-center lg:flex">
      <DoodleWallpaper />
      <button
        type="button"
        onClick={() =>
          showFlash(
            true,
            "从左侧列表选择一个群组，即可在右侧打开群聊；搜索框支持粘贴 t.me 加群链接发起申请",
          )
        }
        className="relative z-10 cursor-pointer rounded-full bg-[#e5ffd1]/95 px-5 py-2.5 text-[15px] font-medium text-[#4a7a52] shadow-[0_1px_6px_rgba(0,0,0,0.14)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
      >
        选择一个会话开始聊天
      </button>
      <button
        type="button"
        onClick={() =>
          showFlash(
            true,
            "仿真说明：左侧为当前机器人 Token 下的真实群组；列表项按钮支持一键部署与模拟加群申请；点击群组在右侧打开聊天，点头像/三个点进入群组设置",
          )
        }
        aria-label="仿真说明"
        className="absolute right-5 top-5 z-10 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#5e6e7e] shadow-[0_1px_8px_rgba(0,0,0,0.16)] transition-colors hover:text-[#3390ec]"
      >
        <Info className="h-5 w-5" />
      </button>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-[560px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
      <div className="flex h-full w-full">
        {/* —— 左侧：会话列表窗口卡（样式与旧版列表一致，图1） —— */}
        <div className="flex h-full w-full min-w-0 flex-col border-r border-black/10 bg-white lg:w-[360px] lg:shrink-0">
          {/* macOS 红绿灯标题栏（截图1） */}
          <div className="relative flex items-center justify-center px-4 pt-3.5 pb-2.5">
            <div className="absolute left-4 flex items-center gap-2" aria-hidden>
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            <span className="text-[16px] font-semibold text-black">聊天</span>
            <div className="absolute right-4 flex items-center gap-3.5 text-[#3390ec]">
              <button
                type="button"
                onClick={() => setScreen("botcheck")}
                aria-label="机器人检测"
                title="机器人检测：按顺序真实检测该机器人全部关键节点（Token/Webhook/投递/运行实例/指令/群组/门禁/界面配置），失败即停并给出修复建议"
                className="cursor-pointer transition-transform active:scale-95"
              >
                <HeartPulse className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => setScreen("proxy")}
                aria-label="代理偏好设置"
                title="代理偏好设置：管理 Telegram API 代理（原系统设置代理配置）"
                className="cursor-pointer transition-transform active:scale-95"
              >
                <ShieldCheck className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => setScreen("newgroup")}
                aria-label="新建群组"
                title="新建群组：选择机器人并登记待绑定群组"
                className="cursor-pointer transition-transform active:scale-95"
              >
                <SquarePen className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 搜索框：普通文本过滤群组；输入加群链接回车 → 真实解析并弹出加群确认面板 */}
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 rounded-[10px] bg-black/[0.07] px-2.5 py-[7px]">
              <Search className="h-4 w-4 shrink-0 text-[#8e8e93]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isJoinLink) void openJoinLink();
                }}
                placeholder="搜索（⌘K）或粘贴加群链接（t.me/+...）"
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

          {/* 同步真实群组（由父组件触发，与页面上方按钮同一管道） */}
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

          {/* 群组列表（保持旧版列表样式；选中项蓝色高亮，点击在右侧打开聊天） */}
          <div className="flex-1 overflow-y-auto">
            {filteredGroups.length === 0 ? (
              <div className="px-6 py-10 text-center text-[14px] leading-relaxed text-[#8e8e93]">
                {groups.length === 0
                  ? "该机器人尚未登记群组：把机器人拉进群设为管理员后在群里发一条消息，再点「同步真实群组」"
                  : "没有匹配的群组"}
              </div>
            ) : (
              filteredGroups.map((group, index) => {
                const isSelected = group.chatId === activeChatId;
                return (
                  <div key={group.chatId} className={index > 0 ? "border-t border-black/[0.07]" : ""}>
                    <button
                      type="button"
                      onClick={() => onSelectGroup(group.chatId)}
                      aria-current={isSelected ? "true" : undefined}
                      className={`flex w-full items-center gap-3 px-3 pt-2 pb-1.5 text-left transition-colors ${
                        isSelected ? "bg-[#3390ec]" : "hover:bg-black/[0.04] active:bg-black/[0.06]"
                      }`}
                    >
                      <GroupAvatar title={group.chatTitle} size={54} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p
                            className={`min-w-0 truncate text-[16px] font-semibold ${
                              isSelected ? "text-white" : "text-black"
                            }`}
                          >
                            {group.chatTitle || `群组 ${group.chatId}`}
                            {group.enabled ? null : (
                              <span
                                className={`ml-1.5 rounded px-1 py-0.5 align-middle text-[10px] font-medium ${
                                  isSelected ? "bg-white/25 text-white" : "bg-black/10 text-[#8e8e93]"
                                }`}
                              >
                                已停用
                              </span>
                            )}
                          </p>
                          <ListTime iso={group.updatedTime} active={isSelected} />
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <p
                            className={`min-w-0 truncate text-[14.5px] ${
                              isSelected ? "text-white/85" : "text-[#8e8e93]"
                            }`}
                          >
                            {group.methodName ?? methodLabel(group.method)}
                            {group.deployed ? " · 已部署" : ""}
                          </p>
                          {group.unread > 0 ? (
                            <span
                              className={`flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full px-1.5 text-[13px] font-semibold ${
                                isSelected ? "bg-white text-[#3390ec]" : "bg-[#3390ec] text-white"
                              }`}
                            >
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
                );
              })
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

        {/* —— 右侧：群组内对话区域 / 空态（图1 空态、图2 聊天） —— */}
        {chatPane}
      </div>

      {/* v2.0.15 代理偏好设置 / 新建群组浮层：桌面端只覆盖右侧区域（左滑滑入，复刻图3/图4），
          移动端覆盖全屏；不依赖当前会话 —— 与群组设置浮层（需先打开会话）不同 */}
      <AnimatePresence initial={false}>
        {screen === "botcheck" ? (
          <motion.div
            key="botcheck"
            variants={OVERLAY_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 z-40 lg:left-[360px]"
          >
            {botcheckOverlay}
          </motion.div>
        ) : null}
        {screen === "proxy" ? (
          <motion.div
            key="proxy"
            variants={OVERLAY_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 z-40 lg:left-[360px]"
          >
            <TgProxyPanel onClose={() => setScreen("chat")} onNotify={showFlash} />
          </motion.div>
        ) : null}
        {screen === "newgroup" ? (
          <motion.div
            key="newgroup"
            variants={OVERLAY_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 z-40 lg:left-[360px]"
          >
            <TgNewGroupPanel
              bots={bots}
              onClose={() => setScreen("chat")}
              onNotify={showFlash}
              onMutated={onSettingsSaved}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 加群确认面板（最高层级浮层，覆盖整个窗口） */}
      <AnimatePresence>
        {joinPanelOverlay ? (
          <motion.div
            key="join-panel"
            variants={OVERLAY_VARIANTS}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 z-50"
          >
            {joinPanelOverlay}
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
            className="absolute inset-0 z-50 flex items-end justify-center bg-black/40"
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
                    {deployResult.reused
                      ? "入群申请链接（复用已有链接，未生成新链接）"
                      : "入群申请链接（发给买家 / 配置到闲鱼自动发货）"}
                  </p>
                  {deployResult.migrated_from_chat_id ? (
                    <p className="mb-1.5 text-[12px] leading-relaxed text-[#c2410c]">
                      ⚠️ 该群已升级为超级群（{deployResult.migrated_from_chat_id} → 新群 ID），旧链接已全部作废，请以此链接为准
                    </p>
                  ) : null}
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

      {/* 邀请链接聚合面板（真实 APP「邀请链接」页：底部上滑，按创建者管理员平铺） */}
      <AnimatePresence>
        {inviteSheetOpen ? (
          <motion.div
            key="invite-links-sheet"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-50 flex items-end justify-center bg-black/40"
            onClick={() => setInviteSheetOpen(false)}
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="flex max-h-[82%] w-full flex-col overflow-hidden rounded-t-2xl bg-white"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-label="邀请链接列表"
            >
              <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-black/15" aria-hidden />
              <div className="flex shrink-0 items-center justify-between px-4 py-3">
                <span className="text-[17px] font-semibold text-black">邀请链接</span>
                <span className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {allInviteLinks.length} 条 · 按创建者管理员
                </span>
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-6">
                {allInviteLoading ? (
                  <div className="flex justify-center py-10">
                    <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
                  </div>
                ) : inviteSheetGroups.length === 0 ? (
                  <div className="px-2 py-10 text-center text-[14px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                    暂无邀请链接记录：机器人在该群创建邀请链接后会自动登记；
                    历史遗留链接可在「群组管理 → 邀请链接」弹窗手动登记后一并管理。
                  </div>
                ) : (
                  <>
                    {inviteSheetGroups.map((creator) => (
                      <div key={creator.key || "unassigned"} className="mt-3 first:mt-0">
                        <div className="mb-1.5 flex items-center gap-2">
                          <IosRowIcon bg="#3390ec">
                            <Users className="h-3.5 w-3.5" />
                          </IosRowIcon>
                          <span className="text-[15px] font-semibold text-black">{creator.label}</span>
                          <span className="text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                            {creator.items.length} 条
                          </span>
                        </div>
                        <div className="space-y-2">
                          {creator.items.map((entry) => (
                            <div
                              key={entry.id}
                              className="rounded-xl border border-black/[0.06] bg-black/[0.02] px-3 py-2.5"
                            >
                              <p className="truncate font-mono text-[13px] text-black" title={entry.link}>
                                {entry.link}
                              </p>
                              <p className="mt-0.5 truncate text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                                <ListTime iso={entry.created_time} />
                                {" · "}
                                {entry.is_revoked ? "已撤销/失效" : entry.creates_join_request ? "有效 · 申请制" : "有效"}
                                {entry.source === "deploy" ? " · 部署生成" : entry.source === "manual" ? " · 手动登记" : ""}
                                {entry.name ? ` · ${entry.name}` : ""}
                              </p>
                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => copyInviteLink(entry)}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/[0.06] px-3 py-1.5 text-[12px] font-medium text-black transition-transform active:scale-95"
                                  aria-label="复制邀请链接"
                                >
                                  <Copy className="h-3 w-3" />
                                  {copiedLinkId === entry.id ? "已复制" : "复制"}
                                </button>
                                {!entry.is_revoked ? (
                                  <button
                                    type="button"
                                    onClick={() => void actOnInviteLink("revoke", entry)}
                                    disabled={sheetBusyId === entry.id}
                                    className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-[#f5a623]/15 px-3 py-1.5 text-[12px] font-medium text-[#b45309] transition-transform active:scale-95 disabled:opacity-50"
                                    aria-label="撤销邀请链接（Telegram 侧真实作废）"
                                  >
                                    {sheetBusyId === entry.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <ShieldBan className="h-3 w-3" />
                                    )}
                                    撤销
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void actOnInviteLink("delete", entry)}
                                  disabled={sheetBusyId === entry.id}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-[#ff3b30]/10 px-3 py-1.5 text-[12px] font-medium text-[#ff3b30] transition-transform active:scale-95 disabled:opacity-50"
                                  aria-label="删除邀请链接台账记录"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  删除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="mt-3 px-1 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                      撤销 = 调用 Telegram revokeChatInviteLink 真实作废（立即失效，已持有者无法再使用）；
                      删除 = 仅移除台账记录，Telegram 侧状态不变。
                    </p>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 深色 flash 提示 */}
      <AnimatePresence>
        {flash ? (
          <motion.div
            key="flash"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            className="pointer-events-none absolute left-1/2 top-3 z-[60] w-[86%] -translate-x-1/2"
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
  );
}
