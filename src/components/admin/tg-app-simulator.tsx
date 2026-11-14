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
  type MenuTemplateVars,
} from "@/services/menu-config";
import { TgDesktopChat } from "@/components/admin/tg-desktop-chat";
import { TgProxyPanel } from "@/components/admin/tg-proxy-panel";
import { TgNewGroupPanel } from "@/components/admin/tg-new-group-panel";
import { IosStatusBar } from "@/components/admin/ios-status-bar";
import { GroupDeployButton } from "@/components/admin/tg-app-simulator-group-deploy";
import {
  ADMIN_RIGHTS,
  type AppSimGroup,
  type BotCheckPlanNode,
  type BotCheckResult,
  type ChatStateSnapshot,
  type GroupSettingsFormState,
  type JoinVerifyCandidate,
  type BotAdminEntry,
  type JoinResolveResult,
  type PendingJoinRequest,
  type RealChatMessage,
  type SimInviteLinkEntry,
  type SimulatorScreen,
  type TgAppSimulatorProps,
} from "@/components/admin/tg-app-simulator-types";
export type { AppSimGroup, JoinResolveResult, RealChatMessage } from "@/components/admin/tg-app-simulator-types";

import {
  DoodleWallpaper,
  formatJoinRequestTime,
  filterSimulatorGroups,
  groupInviteLinksByCreator,
  isInviteSearch,
  sumSimulatorUnread,
  GroupAvatar,
  IosRowIcon,
  ListTime,
  IOS_BLUE,
  IOS_GREEN,
  IOS_GRAY_BG,
  IOS_TEXT_SECONDARY,
  methodLabel,
  OVERLAY_VARIANTS,
  readJson,
} from "@/components/admin/tg-app-simulator-primitives";

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
}: TgAppSimulatorProps) {
  // —— 浮层屏幕：chat=聊天区（默认初始界面），settings=群组设置，admins=机器人权限 ——
  const [screen, setScreen] = useState<SimulatorScreen>("chat");

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
  const isJoinLink = isInviteSearch(search);
  const filteredGroups = useMemo(() => filterSimulatorGroups(groups, search), [groups, search]);
  const totalUnread = useMemo(() => sumSimulatorUnread(groups), [groups]);

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

  /** 申请时间统一由 primitives 层格式化，固定 Asia/Shanghai。 */
  const formatRequestTime = formatJoinRequestTime;

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
  // v2.3 自动审核机器人候选（bots.config.joinVerify.enabled 的机器人，服务端过滤）
  const [joinVerifyCandidates, setJoinVerifyCandidates] = useState<JoinVerifyCandidate[]>([]);
  const [form, setForm] = useState<GroupSettingsFormState>({
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
    /** v2.3 新成员审核（审批制入群）开关 */
    require_approval: false,
    /** v2.3 自动审核机器人（"" = 手动审核） */
    join_verify_bot_id: "",
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
            enabled: boolean;
            prompt_text: string;
            success_text: string;
            failure_text: string;
            require_approval?: boolean;
            join_verify_bot_id?: string | null;
          } | null;
          join_verify_candidates?: { id: string; name: string }[];
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
      setJoinVerifyCandidates(payload.data.join_verify_candidates ?? []);
      const settings = payload.data.settings;
      setForm((prev) => ({
        ...prev,
        chat_title: settings?.chat_title ?? "",
        enabled: settings?.enabled ?? true,
        prompt_text: settings?.prompt_text ?? "",
        success_text: settings?.success_text ?? "",
        failure_text: settings?.failure_text ?? "",
        require_approval: settings?.require_approval ?? false,
        join_verify_bot_id: settings?.join_verify_bot_id ?? "",
      }));
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
          // v2.3：验证方式配置已迁机器人级，群级只保存 文案 + 新成员审核 + 自动审核机器人
          prompt_text: form.prompt_text,
          success_text: form.success_text,
          failure_text: form.failure_text,
          enabled: form.enabled,
          require_approval: form.require_approval,
          join_verify_bot_id: form.join_verify_bot_id || null,
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
      showFlash(true, "群组配置已保存；若切换了新成员审核状态，请重新部署群组以更新已生成的邀请链接");
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

  // 打开权限浮层时加载当前机器人对该群的权限（邀请链接台账已迁到群组类型子屏）
  useEffect(() => {
    if (screen === "admins" && activeChatId) {
      void loadBotAdmins(activeChatId);
    }
  }, [screen, activeChatId, loadBotAdmins]);

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
  const inviteSheetGroups = useMemo(
    () => groupInviteLinksByCreator(allInviteLinks, bots),
    [allInviteLinks, bots],
  );

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

            {/* v2.3 加群审核（新成员审核开关 + 自动审核机器人指定；验证方式已迁机器人级配置） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[17px] leading-snug text-black">
                  新成员审核
                  <span className="block text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                    开启后入群需要审核：私有超级群部署生成「申请制」链接，申请由下方自动审核机器人验证或人工审批；切换此开关后需重新部署群组更新旧链接。公开群还需在 Telegram 群设置中开启加入审核（Bot API 无法远程切换该开关）
                  </span>
                </span>
                <Switch
                  checked={form.require_approval}
                  onCheckedChange={(checked) => setForm((prev) => ({ ...prev, require_approval: checked }))}
                  className="data-[state=checked]:bg-[#34c759]"
                  aria-label="新成员审核"
                />
              </div>
              {form.require_approval ? (
                <div className="border-t border-black/[0.06] px-4 py-2.5">
                  <p className="mb-1.5 text-[17px] text-black">自动审核机器人</p>
                  <select
                    value={form.join_verify_bot_id}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, join_verify_bot_id: event.target.value }))
                    }
                    className="h-10 w-full rounded-lg border border-black/10 bg-white px-2 text-[15px] text-black outline-none"
                  >
                    <option value="">手动审核（在「加群申请」页人工审批）</option>
                    {joinVerifyCandidates.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}（自动验证加群申请）
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                    列表只显示已开启「自动响应加群申请」的机器人；机器人未出现？到
                    机器人管理 → 功能配置 开启「自动响应加群申请」并选择验证方式，然后点「部署」更新运行实例。
                  </p>
                </div>
              ) : null}
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
              <button
                type="button"
                onClick={() => setScreen("chattype")}
                className="flex w-full cursor-pointer items-center gap-3 border-b border-black/[0.06] px-4 py-2.5 text-left"
              >
                <IosRowIcon bg="#3390ec">
                  <Users className="h-4 w-4" />
                </IosRowIcon>
                <span className="flex-1 text-[17px] text-black">群组类型</span>
                <span className="text-[17px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  {chatStateValue("type")}
                </span>
                <ChevronRight className="h-4 w-4 text-[#c7c7cc]" />
              </button>
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

  // —— v2.3 群组类型左滑子屏（真实展示，无修改 API 的项绝不提供假开关） ——
  // 公开群分享链接 = t.me/<username>（getChat 实时读取）；私密群 = 邀请链接台账真实链接
  const publicShareLink =
    chatState && chatState.active_usernames.length > 0
      ? `https://t.me/${chatState.active_usernames[0]}`
      : null;
  const primaryInviteLink =
    allInviteLinks.find((entry) => !entry.is_revoked)?.link ?? null;
  const [chatTypeLinkCopied, setChatTypeLinkCopied] = useState(false);
  const copyChatTypeLink = useCallback(async (link: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setChatTypeLinkCopied(true);
      window.setTimeout(() => setChatTypeLinkCopied(false), 2000);
    } catch (error) {
      console.error("复制分享链接失败:", error);
      showFlash(false, "复制失败：请手动长按链接复制");
    }
  }, [showFlash]);

  const chatTypeOverlay = (
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
        <span className="text-[17px] font-semibold text-black">群组类型</span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* 当前真实类型（getChat 展示时实时读取，绝不硬编码） */}
        <div className="space-y-2 rounded-xl bg-white px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[17px] text-black">当前类型</span>
            <span className="text-[15px]" style={{ color: IOS_TEXT_SECONDARY }}>
              {chatStateLoading ? "…" : chatStateValue("type")}
            </span>
          </div>
          {chatStateLoading ? null : chatStateError ? (
            <p className="text-[12px] leading-relaxed text-amber-700">实时状态获取失败：{chatStateError}</p>
          ) : null}
          <p className="text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
            Telegram Bot API 未开放「修改群组类型 / 用户名」接口，类型只能在 Telegram 客户端的群管理中切换；
            这里展示的是实时真实状态。
          </p>
        </div>

        {/* 真实分享链接 */}
        <div className="space-y-2 rounded-xl bg-white px-4 py-3">
          <p className="text-[15px] font-medium text-black">分享链接</p>
          {publicShareLink ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] text-[#3390ec]" title={publicShareLink}>
                {publicShareLink}
              </span>
              <button
                type="button"
                onClick={() => void copyChatTypeLink(publicShareLink)}
                className="shrink-0 rounded-md bg-[#3390ec]/10 px-3 py-1.5 text-[13px] font-medium text-[#3390ec]"
              >
                {chatTypeLinkCopied ? "已复制" : "复制"}
              </button>
            </div>
          ) : primaryInviteLink ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] text-[#3390ec]" title={primaryInviteLink}>
                {primaryInviteLink}
              </span>
              <button
                type="button"
                onClick={() => void copyChatTypeLink(primaryInviteLink)}
                className="shrink-0 rounded-md bg-[#3390ec]/10 px-3 py-1.5 text-[13px] font-medium text-[#3390ec]"
              >
                {chatTypeLinkCopied ? "已复制" : "复制"}
              </button>
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              私密群还没有可用的邀请链接：点下方「邀请链接」生成，或回到群组列表点「部署」自动生成。
            </p>
          )}
          <p className="text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
            {publicShareLink
              ? "公开群：任何人都能通过用户名链接找到本群；开启「新成员审核」后搜索进入同样需要审批。"
              : "私密群：只能通过邀请链接进入；链接是否需要审批由「新成员审核」开关决定（返回上一页设置）。"}
          </p>
        </div>

        {/* 邀请链接模块（自管理员子屏迁入：台账真实数据 + 上滑面板） */}
        <button
          type="button"
          onClick={() => setInviteSheetOpen(true)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-white px-4 py-3 text-left transition-transform active:scale-[0.99]"
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

        {/* 只读真实状态项（Telegram 未开放机器人写入，绝不提供假开关） */}
        <div className="overflow-hidden rounded-xl bg-white">
          <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5">
            <span className="text-[15px] leading-snug text-black">
              群级「审核新成员」
              <span className="block text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                影响公开搜索入口是否需要审批；需在 Telegram 客户端群管理中操作（Bot API 只读）
              </span>
            </span>
            <span className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
              {chatStateLoading ? "…" : "客户端设置"}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[15px] leading-snug text-black">
              限制保存内容
              <span className="block text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                禁止转发/保存群内内容；需在 Telegram 客户端群管理中操作（Bot API 只读）
              </span>
            </span>
            <span className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
              {chatStateLoading
                ? "…"
                : chatState
                  ? chatState.has_protected_content
                    ? "已开启"
                    : "未开启"
                  : "—"}
            </span>
          </div>
        </div>
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
          {/* v2.3 群组类型左滑子屏（与机器人管理员权限子屏同一交互模式） */}
          {screen === "chattype" ? (
            <motion.div
              key="chattype"
              variants={OVERLAY_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 z-40"
            >
              {chatTypeOverlay}
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
          {/* 移动端使用 iOS 状态栏；桌面端保留 macOS 窗口标题栏 */}
          <IosStatusBar className="lg:hidden" />
          <div className="relative flex items-center justify-center px-4 pt-3.5 pb-2.5">
            <div className="absolute left-4 hidden items-center gap-2 lg:flex" aria-hidden>
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
                            {group.chatType === "channel" ? (
                              <span
                                className={`ml-1.5 rounded px-1 py-0.5 align-middle text-[10px] font-medium ${
                                  isSelected
                                    ? "bg-white/25 text-white"
                                    : "bg-purple-100 text-purple-700"
                                }`}
                              >
                                📢 频道
                              </span>
                            ) : group.chatType === "group" || group.chatType === "supergroup" ? (
                              <span
                                className={`ml-1.5 rounded px-1 py-0.5 align-middle text-[10px] font-medium ${
                                  isSelected
                                    ? "bg-white/25 text-white"
                                    : "bg-sky-100 text-sky-700"
                                }`}
                              >
                                👥 群组
                              </span>
                            ) : null}
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
                    {/* 每个群组底部的操作行：分体部署按钮（主点击=部署该群全部机器人管理员；▾=单选，已部署绿√） */}
                    <div className="flex px-3 pb-2.5">
                      <GroupDeployButton
                        chatId={group.chatId}
                        fallbackDeployed={group.deployed}
                        fallbackBusy={deployingChatId === group.chatId}
                        onDeployChat={handleDeploy}
                        showFlash={showFlash}
                      />
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

