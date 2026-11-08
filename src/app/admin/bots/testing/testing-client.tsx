"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { opsFetch } from "@/lib/remote-ops";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TgAppSimulator, type AppSimGroup, type RealChatMessage } from "@/components/admin/tg-app-simulator";
import { useRealGroups } from "@/components/admin/use-real-groups";
import type { BotMenuConfig } from "@/services/menu-config";

interface BotOption {
  id: string;
  name: string;
  username: string | null;
  enabled: boolean;
  tokenMasked: string;
}

interface GroupOption {
  chatId: string;
  chatTitle: string;
  enabled: boolean;
  method: string;
  methodId: string | null;
  methodName: string | null;
  timeoutSeconds: number;
  maxAttempts: number;
  /** 待处理加群申请数（join_requests.status=pending 真实统计，仿真屏未读徽章） */
  unread: number;
  /** 群组配置更新时间（ISO，仿真屏列表时间列） */
  updatedTime: string;
}

interface JoinApiConfig {
  url: string;
  api_key: string;
  http_method: string;
  code_field?: string;
  body_template?: string;
  success_status: number;
  success_field?: string;
  success_value: string;
  timeout_seconds: number;
}

/** 一键部署校验结果 stage：deployed=已部署，其余为需要手动补齐的前置步骤 */
interface DeployResult {
  stage: "deployed" | "add_bot" | "promote_admin" | "grant_permission";
  bot_username: string | null;
  chat_title: string;
  bot_status?: string;
  invite_link?: string;
  deployed_at?: string;
  guide?: string[];
  /** v2.0.14：true = 复用了已生成的有效邀请链接（未新建） */
  reused?: boolean;
  /** v2.0.14：实际部署的群 chat_id（基础群升级超级群自动迁移后为新 ID） */
  chat_id?: string | null;
  /** v2.0.14：非空 = 该群从旧 chat_id 迁移而来，旧链接已被 Telegram 作废 */
  migrated_from_chat_id?: string | null;
}

interface SimSession {
  token: string;
  chatId: string;
  chatTitle: string | null;
  promptText: string;
  successText: string;
  failureText: string;
  maxAttempts: number;
  expiresAt: string;
  methodName: string;
  /** v2.0.12 三态验证渠道：group=群内验证 / dm=私聊验证 / auto=按群类型自动（超级群→群内，基础群→私聊） */
  verificationChannel: "group" | "dm" | "auto";
}

/**
 * v2.0.12 三态渠道视图判定：群内验证视图 = 显式 group 或（auto 且超级群 chat_id）。
 * 与服务端 resolveVerificationChannel/isSuperGroupChatId 同语义（chat_id -100 前缀）。
 */
export function isGroupChannelView(channel: string | null | undefined, chatId?: string | null): boolean {
  if (channel === "group") return true;
  if (channel === "dm") return false;
  return Boolean(chatId && chatId.startsWith("-100"));
}

export function TestingClient({
  bots,
  relatedBotIds,
  botGroupLinks,
  groups,
  menuConfigs,
}: {
  bots: BotOption[];
  relatedBotIds: Record<string, string[]>;
  botGroupLinks: { botId: string; chatId: string; deployMode: string | null; inviteLink: string | null }[];
  groups: GroupOption[];
  menuConfigs: Record<string, BotMenuConfig>;
}) {
  const [selectedBotId, setSelectedBotId] = useState<string>(bots[0]?.id ?? "");
  const [selectedChatId, setSelectedChatId] = useState<string>("");
  const [session, setSession] = useState<SimSession | null>(null);
  // 模拟加群申请弹窗：验证 API 配置
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinPrefilling, setJoinPrefilling] = useState(false);
  // 从哪个群组发起的弹窗（列表项按钮 → 确认配置后自动对该群发起申请）
  const [pendingJoinChatId, setPendingJoinChatId] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("https://xianyu.mfzl.cn/api/verify-codes/verify");
  const [joinKey, setJoinKey] = useState("xyk_c4e5615d8bc990e2e5225d332c264eb70011dd69b24d3065");
  const [joinHttpMethod, setJoinHttpMethod] = useState<"GET" | "POST">("POST");
  const [joinCodeField, setJoinCodeField] = useState("code");
  const [joinSuccessStatus, setJoinSuccessStatus] = useState("200");
  const [joinSuccessField, setJoinSuccessField] = useState("success");
  const [joinSuccessValue, setJoinSuccessValue] = useState("true");
  // 验证接口超时（秒）：Cloudflare Pages 等外部接口延迟波动大，默认 30s，可配 5~60s
  const [joinTimeout, setJoinTimeout] = useState("30");
  const [joinError, setJoinError] = useState<string | null>(null);
  // 加群仿真状态机（与真实 Telegram 加群一致）：idle=未加入（底部「申请加入群组」按钮）→
  // awaiting_code=已提交申请等待验证码 → joined=验证通过已入群
  const [joinPhase, setJoinPhase] = useState<"idle" | "awaiting_code" | "joined">("idle");
  // 仿真屏当前聊天视图：group=群组聊天（真实加群界面），private=与机器人私聊（验证码在此输入，隐私模式）
  const [simView, setSimView] = useState<"group" | "private">("group");
  // 隐私红线（v1.1.3）：仿真动作一律只停留在仿真屏，绝不真实发送到群组；
  // 原因：验证提示/结果只会通过机器人私聊发给真实用户，群组内不允许出现验证消息。
  // 「同步真实群组」：统一获取 Hook（v1.1.1）—— 全站共用 useRealGroups +
  // /api/admin/telegram/real-groups。打开页面只读取数据库已登记群组（零 Telegram 请求），
  // 已有数据直接展示；只有点「同步真实群组」按钮才 POST 实时校验，不默认自动同步
  const realGroups = useRealGroups({ botId: selectedBotId || null });
  const syncing = realGroups.syncing;
  const syncNote = realGroups.note;
  const router = useRouter();

  // 仿真屏配置保存后刷新页面数据（服务端重新拉取群组配置/未读数）+ 重载已登记群组
  const refreshPageData = useCallback((): void => {
    router.refresh();
    void realGroups.reload();
  }, [router, realGroups]);

  // 统一 Hook 返回的真实群组 → 测试页 GroupOption 形状（供 availableGroups 合并：配置缺标题时作回退标题，新群组直接追加）
  // 注意：必须定义在 availableGroups 之前（deps 数组引用，避免 TDZ）
  const syncedGroups = useMemo<GroupOption[]>(
    () =>
      realGroups.groups.map((group) => ({
        chatId: group.chatId,
        chatTitle: group.chatTitle,
        enabled: true,
        method: "captcha",
        methodId: null,
        methodName: null,
        timeoutSeconds: 300,
        maxAttempts: 3,
        unread: 0,
        updatedTime: "",
      })),
    [realGroups.groups],
  );

  const [deployingChatId, setDeployingChatId] = useState<string | null>(null);
  // v2.1.0：Edge 环境代理提醒 —— 进入仿真APP页面后，若当前为 edge 环境（线上部署）
  // 且代理开关开启（edge 出站会被代理回退链改写），在仿真屏上方与选择机器人面板
  // 之间显示醒目横幅：检测到当前为Edge环境, 请关闭代理!
  const [edgeProxyWarning, setEdgeProxyWarning] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/admin/telegram/proxy-config", { cache: "no-store" });
        const payload = (await response.json()) as {
          ok?: boolean;
          data?: { runtime?: string; enabled?: boolean };
        };
        setEdgeProxyWarning(
          payload.ok === true && payload.data?.runtime === "edge" && payload.data?.enabled === true,
        );
      } catch {
        setEdgeProxyWarning(false);
      }
    })();
  }, []);
  // 弹窗「确认配置」暂存的验证 API 配置，点击「申请加入群组」时随请求保存到群组绑定
  const [pendingJoinConfig, setPendingJoinConfig] = useState<JoinApiConfig | null>(null);

  // —— v2.1.2 真实群消息（按 bot 权限视角）：拉取 chat_messages 台账 ——
  // v2.1.3 D1 读额度保护：废除 v2.1.2 的 10s 轮询（轮询 100 行/次 × 6 次/分 × 挂机时长，
  // 长时间挂机会烧掉 D1 免费层 500 万行读/天的大头）。现在只在「展现时」获取一次：
  // 点击群组打开聊天 / 私聊验证后返回群聊视图，各拉取一次；其余时间提供手动刷新按钮。
  const [realMessages, setRealMessages] = useState<RealChatMessage[]>([]);
  const [realMessagesState, setRealMessagesState] = useState<{
    loading: boolean;
    fetchedAt: string | null;
    error: string | null;
  }>({ loading: false, fetchedAt: null, error: null });

  const loadRealMessages = useCallback(async (chatId: string, botId: string): Promise<void> => {
    setRealMessagesState((prev) => ({ ...prev, loading: true }));
    try {
      const params = new URLSearchParams({ chat_id: chatId, bot_id: botId, limit: "100" });
      const response = await fetch(`/api/admin/telegram/chat-messages?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        data?: { messages: RealChatMessage[] };
      };
      if (!payload.ok) {
        setRealMessagesState({ loading: false, fetchedAt: null, error: payload.error ?? "读取失败" });
        return;
      }
      setRealMessages(payload.data?.messages ?? []);
      setRealMessagesState({ loading: false, fetchedAt: new Date().toISOString(), error: null });
    } catch (error) {
      setRealMessagesState({
        loading: false,
        fetchedAt: null,
        error: error instanceof Error ? error.message : "网络错误",
      });
    }
  }, []);

  // 展现时获取（去重守卫）：同一 (bot, chat, 视图) 只自动拉取一次 ——
  // React StrictMode 下 effect 双触发不会重复打库；视图切换（私聊→群聊）算新一次展现
  const lastRealMessagesKeyRef = useRef<string>("");
  const fetchRealMessagesOnDisplay = useCallback(
    async (chatId: string, botId: string): Promise<void> => {
      const key = `${botId}:${chatId}:${simView}`;
      if (lastRealMessagesKeyRef.current === key) return;
      lastRealMessagesKeyRef.current = key;
      await loadRealMessages(chatId, botId);
    },
    [loadRealMessages, simView],
  );

  useEffect(() => {
    if (!selectedChatId || !selectedBotId) {
      setRealMessages([]);
      setRealMessagesState({ loading: false, fetchedAt: null, error: null });
      lastRealMessagesKeyRef.current = "";
      return;
    }
    // v2.1.3 只在展现时获取：群聊视图可见（simView=group）时拉一次，无任何轮询
    if (simView !== "group") return;
    void fetchRealMessagesOnDisplay(selectedChatId, selectedBotId);
  }, [selectedChatId, selectedBotId, simView, fetchRealMessagesOnDisplay]);

  // 手动刷新（聊天区同步胶囊上的刷新按钮）：绕过去重守卫强制拉取
  const refreshRealMessages = useCallback((): Promise<void> => {
    if (!selectedChatId || !selectedBotId) return Promise.resolve();
    return loadRealMessages(selectedChatId, selectedBotId);
  }, [selectedChatId, selectedBotId, loadRealMessages]);

  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null;

  // 选中机器人的 Token 所关联的全部机器人条目 → 这些条目在群组中配置的 Chat ID 集合。
  // v2.0.13 修复「切换机器人时仿真屏所属群组不同步」：严格按当前机器人 Token 关联的
  // 群组过滤（部署链接 bot_admins ∪ 该 Token 已登记真实群组 chat_registry），
  // 绝不回退到全量 group_settings —— 旧逻辑在机器人无部署链接时把其他机器人的
  // 群组全部展示出来，看起来像切换失效。
  const availableGroups = useMemo<GroupOption[]>(() => {
    if (!selectedBot) return [];
    const relatedIds = new Set(relatedBotIds[selectedBot.id] ?? [selectedBot.id]);
    const linkedChatIds = new Set(
      botGroupLinks.filter((link) => relatedIds.has(link.botId)).map((link) => link.chatId),
    );
    const syncedChatIds = new Set(syncedGroups.map((group) => group.chatId));
    // 群组合并：同 chatId 时群组配置（groups，来自 group_settings）的非空群名优先 ——
    // 数据库里有群名的群永远显示群名，绝不被同步数据的空标题覆盖；
    // 配置缺标题时才用同步数据标题，两者皆空显示空
    const merged = new Map<string, GroupOption>();
    for (const group of groups) {
      if (!linkedChatIds.has(group.chatId) && !syncedChatIds.has(group.chatId)) continue;
      merged.set(group.chatId, group);
    }
    for (const group of syncedGroups) {
      const existing = merged.get(group.chatId);
      merged.set(
        group.chatId,
        existing
          ? {
              ...existing,
              chatTitle: existing.chatTitle.trim() ? existing.chatTitle : group.chatTitle,
            }
          : group,
      );
    }
    return [...merged.values()];
  }, [selectedBot, relatedBotIds, botGroupLinks, groups, syncedGroups]);

  // v2.0.14：初始界面为空态（图1「选择一个会话开始聊天」），点击左侧群组才在右侧打开聊天；
  // 不再自动回退到第一个群组
  const activeGroup = useMemo(
    () => availableGroups.find((group) => group.chatId === selectedChatId) ?? null,
    [availableGroups, selectedChatId],
  );

  // 仿真屏群组列表数据源：在 GroupOption 基础上补充部署状态/时间列/未读徽章
  const appGroups = useMemo<AppSimGroup[]>(
    () =>
      availableGroups.map((group) => {
        const relatedIds = selectedBot ? new Set(relatedBotIds[selectedBot.id] ?? [selectedBot.id]) : null;
        const deployLink = botGroupLinks.find(
          (link) =>
            link.chatId === group.chatId &&
            (relatedIds ? relatedIds.has(link.botId) : true) &&
            link.deployMode === "join_request",
        );
        return {
          chatId: group.chatId,
          chatTitle: group.chatTitle,
          enabled: group.enabled,
          method: group.method,
          methodId: group.methodId,
          methodName: group.methodName,
          timeoutSeconds: group.timeoutSeconds,
          maxAttempts: group.maxAttempts,
          deployed: Boolean(deployLink),
          unread: group.unread,
          updatedTime: group.updatedTime,
        };
      }),
    [availableGroups, botGroupLinks, relatedBotIds, selectedBot],
  );

  // 打开弹窗：拉取群组当前绑定的验证 API 配置预填（无配置时用默认值）
  const openJoinDialog = useCallback(
    async (chatId: string): Promise<void> => {
      setPendingJoinChatId(chatId);
      setJoinOpen(true);
      setJoinError(null);
      setJoinPrefilling(true);
      try {
        const response = await opsFetch(
          `/api/admin/bots/testing/join-request?chat_id=${encodeURIComponent(chatId)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as { ok: boolean; data?: { config?: JoinApiConfig | null } };
        const config = payload.ok ? payload.data?.config : null;
        if (config) {
          setJoinUrl(config.url);
          setJoinKey(config.api_key);
          setJoinHttpMethod(config.http_method === "GET" ? "GET" : "POST");
          setJoinCodeField(config.code_field ?? "code");
          setJoinSuccessStatus(String(config.success_status ?? 200));
          setJoinSuccessField(config.success_field ?? "success");
          setJoinSuccessValue(config.success_value ?? "true");
          setJoinTimeout(String(config.timeout_seconds ?? 30));
        }
      } catch {
        /* 预填失败时保留默认值 */
      } finally {
        setJoinPrefilling(false);
      }
    },
    [],
  );

  // 创建模拟加群申请会话（chatId 参数化，供群聊内按钮 / 列表按钮 / 加群确认面板三个入口共用）
  const createJoinSession = useCallback(
    async (
      chatId: string,
      apiConfig: JoinApiConfig | null,
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        const response = await opsFetch("/api/admin/bots/testing/join-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            bot_id: selectedBotId,
            ...(apiConfig ? { api_config: apiConfig } : {}),
          }),
        });
        const payload = (await response.json()) as {
          ok: boolean;
          error?: string;
          data?: Record<string, string>;
        };
        if (!payload.ok || !payload.data) {
          setSession(null);
          setJoinPhase("idle");
          setSimView("group");
          return { ok: false, message: payload.error ?? "申请加入失败" };
        }
        setSession({
          token: payload.data.token,
          chatId: payload.data.chat_id,
          chatTitle: payload.data.chat_title,
          promptText: payload.data.prompt_text,
          successText: payload.data.success_text,
          failureText: payload.data.failure_text,
          maxAttempts: Number(payload.data.max_attempts ?? 3),
          expiresAt: payload.data.expires_at,
          methodName: payload.data.method_name,
          verificationChannel:
            payload.data.verification_channel === "dm"
              ? "dm"
              : payload.data.verification_channel === "group"
                ? "group"
                : "auto",
        });
        setJoinPhase("awaiting_code");
        // 与真实 APP 一致：私聊验证模式 → 机器人把验证提示发到买家私聊（切换到私聊视图）；
        // 群内验证模式（auto=超级群）→ 申请自动批准进群，验证消息发到群内（留在群聊视图）
        setSimView(
          isGroupChannelView(payload.data.verification_channel, payload.data.chat_id)
            ? "group"
            : "private",
        );
        setSelectedChatId(chatId);
        return { ok: true, message: "已提交加群申请" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "申请加入失败" };
      }
    },
    [selectedBotId],
  );

  // 弹窗「完成配置」：校验并暂存验证 API 配置；从列表项发起时自动对该群创建申请会话
  const confirmJoinDialog = useCallback(() => {
    const url = joinUrl.trim();
    const apiKey = joinKey.trim();
    const codeField = joinCodeField.trim() || "code";
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setJoinError("验证 API 地址不合法（需 http/https 开头）");
      return;
    }
    if (!apiKey) {
      setJoinError("请填写 Bearer API Key");
      return;
    }
    const config: JoinApiConfig = {
      url,
      api_key: apiKey,
      http_method: joinHttpMethod,
      code_field: codeField,
      success_status: Number(joinSuccessStatus) || 200,
      success_field: joinSuccessField.trim() || "success",
      success_value: joinSuccessValue.trim() || "true",
      // 超时可配置（预填取群组绑定配置的现值，无配置时默认 30s）：Cloudflare Pages 等
      // 外部验证接口延迟波动大（实测 1s~25s），硬编码 10s 会频繁误判网络异常
      timeout_seconds: Math.min(Math.max(Number(joinTimeout) || 30, 5), 60),
    };
    setPendingJoinConfig(config);
    setSession(null);
    setJoinPhase("idle");
    setSimView("group");
    setJoinOpen(false);
    const targetChatId = pendingJoinChatId;
    setPendingJoinChatId(null);
    if (targetChatId) {
      void createJoinSession(targetChatId, config);
    }
  }, [
    joinUrl,
    joinKey,
    joinHttpMethod,
    joinCodeField,
    joinSuccessStatus,
    joinSuccessField,
    joinSuccessValue,
    joinTimeout,
    pendingJoinChatId,
    createJoinSession,
  ]);

  // 仿真屏群聊内「申请加入群组」按钮：对当前聊天群组发起申请（沿用已有配置）
  const handleRequestJoin = useCallback(
    (): Promise<{ ok: boolean; message: string }> =>
      activeGroup
        ? createJoinSession(activeGroup.chatId, pendingJoinConfig)
        : Promise.resolve({ ok: false, message: "请先选择机器人和群组" }),
    [activeGroup, pendingJoinConfig, createJoinSession],
  );

  // 仿真屏群组列表「模拟加群申请」按钮：
  // 已配置验证方式（自动验证码/外部API）的群组直接发起；其余打开配置弹窗（确认后自动发起）
  const handleRequestJoinForGroup = useCallback(
    async (chatId: string): Promise<{ ok: boolean; message: string }> => {
      const group = availableGroups.find((item) => item.chatId === chatId);
      if (!group) return { ok: false, message: "群组不存在，请先同步真实群组" };
      const hasCodeConfig =
        group.method === "code_self" || (group.method === "code_api" && group.methodId);
      if (hasCodeConfig) {
        return createJoinSession(chatId, pendingJoinConfig);
      }
      await openJoinDialog(chatId);
      return { ok: true, message: "请在弹窗中完成验证 API 配置" };
    },
    [availableGroups, createJoinSession, pendingJoinConfig, openJoinDialog],
  );

  const submitCode = useCallback(
    async (text: string): Promise<{ ok: boolean; text: string; joined?: boolean }> => {
      if (!session) {
        return { ok: false, text: "尚未加入群组：请先点击下方「申请加入群组」按钮" };
      }
      try {
        const response = await opsFetch("/api/admin/bots/testing/submit-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: session.token,
            code: text,
          }),
        });
        const payload = (await response.json()) as {
          ok: boolean;
          error?: string;
          data?: {
            outcome: string;
            replyText: string;
            approved?: boolean;
            approval_note?: string | null;
            network_error?: boolean;
            reapply?: boolean;
          };
        };
        if (!payload.ok || !payload.data) {
          return { ok: false, text: payload.error ?? "提交失败" };
        }
        if (payload.data.outcome === "success") {
          setJoinPhase("joined");
          // 与真实 APP 一致：验证成功后回到群组（私聊验证对话保留在私聊流中）
          setSimView("group");
          const note = payload.data.approval_note ? `\n${payload.data.approval_note}` : "";
          return { ok: true, text: `${payload.data.replyText}${note}`, joined: true };
        }
        if (payload.data.outcome === "failed_expired") {
          // 与真实 APP 一致：尝试次数用尽，验证失效 —— 输入框位置恢复为「申请加入群组」按钮，
          // 点击后重新走完整加群申请流程（重新创建会话，与真实 chat_join_request 一致）
          setSession(null);
          setJoinPhase("idle");
          setSimView("group");
          return { ok: true, text: `${payload.data.replyText}` };
        }
        return { ok: true, text: `${payload.data.replyText}` };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : "提交失败" };
      }
    },
    [session],
  );

  // 一键部署（按群组）：Token → 已在群 → 管理员 → 邀请权限 → 生成入群申请链接并保存部署状态
  // 仿真屏列表项按钮入口；结果（stage/guide/链接）由仿真屏内浮层展示
  const handleDeployForGroup = useCallback(
    async (
      chatId: string,
    ): Promise<{
      ok: boolean;
      message: string;
      stage?: string;
      guide?: string[];
      invite_link?: string | null;
      chat_title?: string | null;
      reused?: boolean;
      chat_id?: string | null;
      migrated_from_chat_id?: string | null;
    } | null> => {
      if (!selectedBotId || deployingChatId) return null;
      setDeployingChatId(chatId);
      try {
        const response = await opsFetch("/api/admin/bots/testing/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bot_id: selectedBotId, chat_id: chatId }),
        });
        const payload = (await response.json()) as { ok: boolean; error?: string } & DeployResult;
        if (!payload.ok) {
          return { ok: false, message: payload.error ?? "部署校验失败" };
        }
        const stageMessages: Record<DeployResult["stage"], string> = {
          deployed: payload.reused
            ? "部署成功：复用已生成的有效邀请链接（未重复生成新链接）"
            : "部署成功：入群申请链接已生成并保存为该群组的部署状态",
          add_bot: "机器人还不在群里：请先把机器人拉进群（Telegram 限制：无法由 API 自拉）",
          promote_admin: "机器人已在群内但还不是管理员：请在群设置中添加为管理员",
          grant_permission: "机器人已是管理员但缺少「邀请用户 via 链接」权限：请开启后重新部署",
        };
        // v2.0.14：基础群升级超级群自动迁移 —— 刷新群组列表（新 chat_id 登记后出现、
        // 旧 chat_id 待同步淘汰），并把选中切到新群 ID，避免继续对旧 ID 操作
        if (payload.stage === "deployed" && payload.migrated_from_chat_id) {
          if (selectedChatId === String(payload.migrated_from_chat_id)) {
            setSelectedChatId(String(payload.chat_id ?? ""));
          }
          void realGroups.reload();
          router.refresh();
        }
        return {
          ok: true,
          stage: payload.stage,
          message: stageMessages[payload.stage] ?? "部署校验完成",
          guide: payload.guide,
          invite_link: payload.invite_link ?? null,
          chat_title: payload.chat_title ?? null,
          reused: payload.reused ?? false,
          chat_id: payload.chat_id ?? null,
          migrated_from_chat_id: payload.migrated_from_chat_id ?? null,
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "部署校验失败" };
      } finally {
        setDeployingChatId(null);
      }
    },
    [selectedBotId, deployingChatId, selectedChatId, realGroups, router],
  );

  const simulatorConfig = selectedBot ? menuConfigs[selectedBot.id] : null;
  const botName = selectedBot?.name ?? "机器人";

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-6.5rem)] lg:min-h-[680px]">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">机器人测试</h1>
        <p className="text-sm text-muted-foreground">
          Telegram 桌面客户端仿真屏：左侧为当前机器人 Token 下的真实群组列表（点击群组在右侧打开聊天，点头像/三个点进入群组设置），
          搜索框粘贴加群链接可弹出真实加群确认面板；列表项支持一键部署与模拟加群申请，完整走通加群验证全链路。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-[260px] flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">机器人（当前 BOT TOKEN）</span>
          <Select
            value={selectedBotId}
            onValueChange={(value) => {
              setSelectedBotId(value);
              // v2.0.13：切换机器人必须同步重置仿真屏上下文 ——
              // 群组列表（availableGroups 随 selectedBot 重算）、当前打开的会话视图
              // （selectedChatId 残留会让右侧聊天区显示旧机器人群组）、
              // 验证会话/加群状态机/聊天视图全部清空
              setSelectedChatId("");
              setSession(null);
              setJoinPhase("idle");
              setSimView("group");
            }}
          >
            <SelectTrigger aria-label="选择机器人" className="w-full">
              <SelectValue placeholder="选择机器人" />
            </SelectTrigger>
            <SelectContent>
              {bots.map((bot) => (
                <SelectItem key={bot.id} value={bot.id}>
                  {bot.name}
                  {bot.username ? `（@${bot.username}）` : ""} · {bot.tokenMasked}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-transparent">同步</span>
          <Button
            type="button"
            variant="outline"
            onClick={() => void realGroups.sync()}
            disabled={!selectedBotId || syncing}
            aria-label="同步真实群组"
            className="gap-1.5"
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            同步真实群组
          </Button>
        </div>

        <div className="ml-auto flex flex-col items-end gap-1 text-right">
          <span className="text-xs font-medium text-muted-foreground">验证会话状态</span>
          {session ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {/* 会话标识（非 API Key）：后台用它定位本次验证会话/计次/过期，
                  外部验证接口的 apikey 只在服务端调用时使用，两者无关 */}
              <Badge
                variant="outline"
                className="gap-1 font-mono text-[11px]"
                title="验证会话标识（非 API Key）：后台用它定位本次验证会话与尝试次数，与外部验证接口的 apikey 无关"
              >
                会话 {session.token.slice(0, 10)}…
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                {session.methodName}
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                限时 {Math.max(0, Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000))}s
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                最多 {session.maxAttempts} 次
              </Badge>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">未开始</span>
          )}
        </div>
      </div>
      {syncNote ? (
        <p className={`text-xs leading-relaxed ${syncNote.ok ? "text-green-700" : "text-red-600"}`}>
          {syncNote.ok ? "✓ " : "⚠ "}{syncNote.text}
        </p>
      ) : null}

      {/* v2.1.0 Edge 环境代理提醒：仿真屏上方、选择机器人面板之下 */}
      {edgeProxyWarning ? (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-xl border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            检测到当前为Edge环境, 请关闭代理!
            <span className="ml-1.5 font-normal text-amber-700/80">
              （在仿真屏盾牌图标 →「代理偏好设置」中关闭「代理」总开关，Edge 站直连 api.telegram.org 无需代理）
            </span>
          </span>
        </div>
      ) : null}

      {/* 仿真屏（Telegram 桌面客户端双栏：左侧会话列表 + 右侧聊天区） */}
      <section aria-label="仿真屏" className="min-h-[640px] flex-1 overflow-hidden">
        {simulatorConfig && selectedBot ? (
          <div className="h-full min-h-[640px]">
            <TgAppSimulator
              config={simulatorConfig}
              botName={botName}
              botUsername={selectedBot.username}
              selectedBotId={selectedBot.id}
              groups={appGroups}
              activeChatId={activeGroup ? activeGroup.chatId : null}
              memberCount="仿真模式"
              systemNote={
                joinPhase === "idle"
                  ? `仿真真实加群流程：点击下方「申请加入群组」按钮开始（验证方式：${activeGroup?.methodName ?? activeGroup?.method ?? "未配置"}）`
                  : joinPhase === "joined"
                    ? `仿真群 ${activeGroup?.chatId ?? ""} · 已加入群组`
                    : isGroupChannelView(session?.verificationChannel, session?.chatId)
                      ? "群内验证中：申请已自动批准进群，验证消息已发到群内（输入内容其他成员不可见）"
                      : simView === "private"
                        ? "私聊验证中（隐私模式）：验证码仅机器人可见，不会出现在群里"
                        : `仿真群 ${activeGroup?.chatId ?? ""} · 请输入验证码后点击发送按钮`
              }
              templateVars={
                activeGroup
                  ? { chat_id: activeGroup.chatId, chat_title: activeGroup.chatTitle, user_id: "777000", username: "preview_user" }
                  : undefined
              }
              promptMessage={
                session
                  ? {
                      id: 1,
                      text: session.promptText,
                      hint:
                        isGroupChannelView(session.verificationChannel, session.chatId)
                          ? "群内验证消息（仿真：点击消息下方按钮/在输入框模拟输码）"
                          : "请输入验证码后点击发送按钮（仿真 force_reply）",
                    }
                  : null
              }
              onUserSend={joinPhase === "joined" ? undefined : submitCode}
              joinPhase={joinPhase}
              onRequestJoin={handleRequestJoin}
              view={simView}
              onSelectGroup={(chatId) => {
                // 打开/切换右侧聊天：重置验证会话（与切换群组同语义）
                setSelectedChatId(chatId);
                setSession(null);
                setJoinPhase("idle");
                setSimView("group");
              }}
              onBackToList={() => setSelectedChatId("")}
              onSyncGroups={() => void realGroups.sync()}
              syncing={syncing}
              onDeployGroup={handleDeployForGroup}
              deployingChatId={deployingChatId}
              onSimulateJoinForGroup={handleRequestJoinForGroup}
              onSettingsSaved={refreshPageData}
              realMessages={realMessages}
              realMessagesState={realMessagesState}
              onRefreshRealMessages={refreshRealMessages}
              bots={bots.map((bot) => ({
                id: bot.id,
                name: bot.name,
                username: bot.username,
                tokenMasked: bot.tokenMasked,
              }))}
            />
          </div>
        ) : (
          <div className="flex h-full min-h-[420px] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
            请先创建机器人
          </div>
        )}
      </section>

      <Dialog open={joinOpen} onOpenChange={(open) => { setJoinOpen(open); if (open) setJoinError(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>模拟加群申请</DialogTitle>
            <DialogDescription>
              完整仿真真实 APP 加群流程（下方配置保存到群组绑定，仿真与真实验证共用）：
              ①完成验证 API 配置 → ②仿真屏右侧显示真实加群界面，底部为「申请加入群组」按钮 →
              ③点击按钮，仿真屏切换到与机器人的私聊（隐私模式：验证码仅机器人可见，群里看不到），出现输入框和发送按钮 →
              ④输入验证码点击发送，实时调用验证 API：成功发送欢迎词并自动加入群组，失败透传接口原因可重试。
              仿真动作只停留在仿真屏（隐私红线）：真实群组内永远不出现验证消息，验证提示只会由机器人私聊发送给真实用户。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="join-url">验证 API URL</Label>
              <Input
                id="join-url"
                value={joinUrl}
                onChange={(event) => setJoinUrl(event.target.value)}
                placeholder="https://xianyu.mfzl.cn/api/verify-codes/verify"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label>请求方式</Label>
              <Tabs
                value={joinHttpMethod}
                onValueChange={(value) => setJoinHttpMethod(value as "GET" | "POST")}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="GET">GET（参数附加到 URL）</TabsTrigger>
                  <TabsTrigger value="POST">POST（验证码放入请求体）</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="join-key">Bearer API Key</Label>
              <Input
                id="join-key"
                value={joinKey}
                onChange={(event) => setJoinKey(event.target.value)}
                placeholder="xyk_xxxx（「API Key管理」生成的业务方 Key）"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="join-code-field">验证码字段名</Label>
              <Select value={joinCodeField} onValueChange={setJoinCodeField}>
                <SelectTrigger id="join-code-field" className="w-full">
                  <SelectValue placeholder="code" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="code">code（默认）</SelectItem>
                  <SelectItem value="card">card</SelectItem>
                  <SelectItem value="key">key</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                买家输入的验证码在请求中使用的字段名（验证接口兼容 code / card / key 三种）。
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="join-success-status">成功状态码</Label>
                <Input
                  id="join-success-status"
                  type="number"
                  value={joinSuccessStatus}
                  onChange={(event) => setJoinSuccessStatus(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="join-success-field">判定字段</Label>
                <Input
                  id="join-success-field"
                  value={joinSuccessField}
                  onChange={(event) => setJoinSuccessField(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="join-success-value">判定值</Label>
                <Input
                  id="join-success-value"
                  value={joinSuccessValue}
                  onChange={(event) => setJoinSuccessValue(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="join-timeout">超时（秒）</Label>
                <Input
                  id="join-timeout"
                  type="number"
                  min={5}
                  max={60}
                  value={joinTimeout}
                  onChange={(event) => setJoinTimeout(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>请求预览</Label>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                {joinPrefilling
                  ? "正在读取当前配置…"
                  : joinHttpMethod === "POST"
                    ? `POST ${joinUrl.trim() || "https://…"}\nAuthorization: Bearer ${joinKey.trim() || "xyk_…"}\nContent-Type: application/json\n\n{ "${joinCodeField.trim() || "code"}": "{{code}}" }`
                    : `GET ${joinUrl.trim() || "https://…"}?user_id=777000&${joinCodeField.trim() || "code"}={{code}}&username=preview_user\nAuthorization: Bearer ${joinKey.trim() || "xyk_…"}`}
              </pre>
              <p className="text-xs text-muted-foreground">
                买家在仿真屏输入验证码发送时，<code className="font-mono">{"{{code}}"}</code> 替换为实际输入；HTTP 状态码等于
                「成功状态码」且响应中「判定字段」等于「判定值」即验证通过，否则透传接口失败原因（鉴权失败 401/403/429 同样会提示原因）。
              </p>
            </div>

            {joinError ? <p className="text-sm text-red-600">{joinError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setJoinOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={confirmJoinDialog} disabled={joinPrefilling} className="gap-1.5">
              {joinPrefilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              完成配置，去仿真屏加群
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
