"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { opsFetch } from "@/lib/remote-ops";
import { formatBeijingShortDateTime } from "@/utils/datetime";
import {
  Check,
  ChevronDown,
  Copy,
  Loader2,
  PackageOpen,
  RefreshCw,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { TgAppSimulator, type AppSimGroup } from "@/components/admin/tg-app-simulator";
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

interface ProductItem {
  id: string;
  externalId: string | null;
  title: string;
  price: string | null;
  description: string | null;
  imageUrl: string | null;
  detailJson: string | null;
  sourceUrl: string | null;
  rawJson: string | null;
  createdTime: string;
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

interface DeliveryLogView {
  key: string;
  time: string;
  ok: boolean;
  method: string;
  url: string;
  requestHeaders: string | null;
  requestBody: string | null;
  status: number | null;
  durationMs: number | null;
  responseBody: string | null;
  code: string | null;
  message: string | null;
  error: string | null;
}

// v2.0.13：时间展示统一北京时间（服务器/浏览器时区不可控，显式锁定 Asia/Shanghai）
function formatTime(iso: string): string {
  return formatBeijingShortDateTime(new Date(iso));
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
        } catch {
          const textarea = document.createElement("textarea");
          textarea.value = code;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="h-8 gap-1 bg-[#3390ec] px-3 text-white hover:bg-[#2b7fd0]"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "已复制，去仿真屏粘贴" : "复制验证码"}
    </Button>
  );
}

function LogRequestBlock({ log }: { log: DeliveryLogView }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={log.ok ? "default" : "destructive"} className="h-5 px-1.5 text-[11px]">
          {log.ok ? "发货成功" : "发货失败"}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{log.time}</span>
        <span className="font-mono text-[11px]">
          {log.method} {log.url}
        </span>
        {log.status !== null ? (
          <span className={`font-mono text-[11px] ${log.status >= 200 && log.status < 300 ? "text-green-600" : "text-red-500"}`}>
            HTTP {log.status}
          </span>
        ) : null}
        {log.durationMs !== null ? (
          <span className="font-mono text-[11px] text-muted-foreground">{log.durationMs}ms</span>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          请求/响应详情
          <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {log.error ? <p className="text-red-600">错误：{log.error}</p> : null}
      {log.message && !log.error ? <p className="text-muted-foreground">响应消息：{log.message}</p> : null}
      {expanded ? (
        <div className="space-y-2">
          <div>
            <p className="mb-1 font-medium text-muted-foreground">请求头（apikey 已脱敏）</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] leading-relaxed">
              {log.requestHeaders ?? "-"}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-medium text-muted-foreground">请求体</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] leading-relaxed">
              {log.requestBody ?? "-"}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-medium text-muted-foreground">响应体</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] leading-relaxed">
              {log.responseBody ?? "-"}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TestingClient({
  bots,
  relatedBotIds,
  botGroupLinks,
  groups,
  menuConfigs,
  initialProducts,
  origin,
  demoApiKey,
}: {
  bots: BotOption[];
  relatedBotIds: Record<string, string[]>;
  botGroupLinks: { botId: string; chatId: string; deployMode: string | null; inviteLink: string | null }[];
  groups: GroupOption[];
  menuConfigs: Record<string, BotMenuConfig>;
  initialProducts: ProductItem[];
  origin: string;
  demoApiKey: string;
}) {
  const [selectedBotId, setSelectedBotId] = useState<string>(bots[0]?.id ?? "");
  const [selectedChatId, setSelectedChatId] = useState<string>("");
  const [session, setSession] = useState<SimSession | null>(null);
  // 模拟加群申请弹窗：验证 API 配置（与导入闲鱼商品弹窗同风格）
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinPrefilling, setJoinPrefilling] = useState(false);
  // 从哪个群组发起的弹窗（列表项按钮 → 确认配置后自动对该群发起申请）
  const [pendingJoinChatId, setPendingJoinChatId] = useState<string | null>(null);
  // 仿真屏创建验证会话成功后递增：驱动 TgAppSimulator push 到群聊界面
  const [chatOpenRequest, setChatOpenRequest] = useState(0);
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
  // 弹窗「确认配置」暂存的验证 API 配置，点击「申请加入群组」时随请求保存到群组绑定
  const [pendingJoinConfig, setPendingJoinConfig] = useState<JoinApiConfig | null>(null);
  const [products, setProducts] = useState<ProductItem[]>(initialProducts);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState(`${origin}/api/xianyu/products`);
  const [importKey, setImportKey] = useState(demoApiKey);
  const [importCount, setImportCount] = useState("5");
  // 条数参数名（默认 limit）与请求方式（GET 时参数附加到 URL，POST 时放入 JSON 请求体）
  const [importParam, setImportParam] = useState("limit");
  const [importMethod, setImportMethod] = useState<"GET" | "POST">("GET");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [detailProduct, setDetailProduct] = useState<ProductItem | null>(null);
  const [deliverProduct, setDeliverProduct] = useState<ProductItem | null>(null);
  // 模拟发货弹窗默认指向闲鱼发卡平台发货测试接口（配合 xyk_ 业务方 Key）
  const [deliverUrl, setDeliverUrl] = useState("https://xianyu.mfzl.cn/api/cards/deliver-test");
  const [deliverKey, setDeliverKey] = useState("xyk_5d4eeeaa3464287735f4c0a57164493e69a17c547bc98c32");
  const [delivering, setDelivering] = useState(false);
  const [deliverLogs, setDeliverLogs] = useState<DeliveryLogView[]>([]);
  const [latestCode, setLatestCode] = useState<string | null>(null);

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

  const activeGroup = useMemo(
    () => availableGroups.find((group) => group.chatId === selectedChatId) ?? availableGroups[0] ?? null,
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

  const refreshProducts = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/admin/xianyu/products", { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; products?: ProductItem[] };
      if (payload.ok && payload.products) setProducts(payload.products);
    } catch {
      /* keep current list */
    }
  }, []);

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
        setLatestCode(null);
        setJoinPhase("awaiting_code");
        // 与真实 APP 一致：私聊验证模式 → 机器人把验证提示发到买家私聊（切换到私聊视图）；
        // 群内验证模式（auto=超级群）→ 申请自动批准进群，验证消息发到群内（留在群聊视图）
        setSimView(
          isGroupChannelView(payload.data.verification_channel, payload.data.chat_id)
            ? "group"
            : "private",
        );
        setSelectedChatId(chatId);
        setChatOpenRequest((count) => count + 1);
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
    setLatestCode(null);
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
  // 仿真屏列表项按钮入口；结果（stage/guide/链接）由仿真屏内 iOS 弹层展示
  const handleDeployForGroup = useCallback(
    async (
      chatId: string,
    ): Promise<{
      ok: boolean;
      message: string;
      stage?: string;
      guide?: string[];
      invite_link?: string | null;
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
          deployed: "部署成功：入群申请链接已生成并保存为该群组的部署状态",
          add_bot: "机器人还不在群里：请先把机器人拉进群（Telegram 限制：无法由 API 自拉）",
          promote_admin: "机器人已在群内但还不是管理员：请在群设置中添加为管理员",
          grant_permission: "机器人已是管理员但缺少「邀请用户 via 链接」权限：请开启后重新部署",
        };
        return {
          ok: true,
          stage: payload.stage,
          message: stageMessages[payload.stage] ?? "部署校验完成",
          guide: payload.guide,
          invite_link: payload.invite_link ?? null,
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "部署校验失败" };
      } finally {
        setDeployingChatId(null);
      }
    },
    [selectedBotId, deployingChatId],
  );

  const runImport = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const response = await fetch("/api/admin/xianyu/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: importUrl,
          api_key: importKey,
          count: Number(importCount) || 5,
          param_name: importParam,
          method: importMethod,
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        fetched?: number;
        imported?: number;
        updated?: number;
        error?: string;
      };
      if (!payload.ok) {
        setImportError(payload.error ?? "导入失败");
        return;
      }
      await refreshProducts();
      setImportSuccess(
        `拉取 ${payload.fetched ?? 0} 条：新建 ${payload.imported ?? 0} · 更新 ${payload.updated ?? 0}，左侧列表已刷新（同商品 ID 重复导入会更新而非重复插入）`,
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }, [importUrl, importKey, importCount, importParam, importMethod, refreshProducts]);

  const openDeliverDialog = useCallback(async (product: ProductItem) => {
    setDeliverProduct(product);
    setLatestCode(null);
    setDeliverLogs([]);
    try {
      const response = await fetch(`/api/admin/xianyu/deliveries?product_id=${product.id}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        ok: boolean;
        logs?: {
          id: number;
          createdTime: string;
          success: boolean;
          requestMethod: string;
          apiUrl: string;
          requestHeaders: string | null;
          requestBody: string | null;
          responseStatus: number | null;
          durationMs: number | null;
          responseBody: string | null;
          verifyCode: string | null;
          error: string | null;
        }[];
      };
      if (payload.ok && payload.logs) {
        setDeliverLogs(
          payload.logs.map((log) => ({
            key: `history-${log.id}`,
            time: formatTime(log.createdTime),
            ok: log.success,
            method: log.requestMethod,
            url: log.apiUrl,
            requestHeaders: log.requestHeaders,
            requestBody: log.requestBody,
            status: log.responseStatus,
            durationMs: log.durationMs,
            responseBody: log.responseBody,
            code: log.verifyCode,
            message: null,
            error: log.error,
          })),
        );
        const latestWithCode = payload.logs.find((log) => log.verifyCode);
        if (latestWithCode?.verifyCode) setLatestCode(latestWithCode.verifyCode);
      }
    } catch {
      /* history optional */
    }
  }, []);

  const runDeliver = useCallback(async () => {
    if (!deliverProduct) return;
    setDelivering(true);
    try {
      const response = await fetch("/api/admin/xianyu/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: deliverProduct.id, url: deliverUrl, api_key: deliverKey }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        code?: string | null;
        message?: string | null;
        error?: string | null;
        request?: { method: string; url: string; headers: Record<string, string>; body: string | null };
        response?: { status: number; durationMs: number; bodyText: string } | null;
        log?: { id: number; createdTime: string; verifyCode: string | null; success: boolean };
      };
      const log: DeliveryLogView = {
        key: `live-${Date.now()}`,
        time: formatTime(new Date().toISOString()),
        ok: payload.ok,
        method: payload.request?.method ?? "POST",
        url: payload.request?.url ?? deliverUrl,
        requestHeaders: payload.request?.headers
          ? JSON.stringify(payload.request.headers, null, 2)
          : null,
        requestBody: payload.request?.body ?? null,
        status: payload.response?.status ?? null,
        durationMs: payload.response?.durationMs ?? null,
        responseBody: payload.response?.bodyText ?? null,
        code: payload.code ?? null,
        message: payload.message ?? null,
        error: payload.error ?? null,
      };
      setDeliverLogs((prev) => [log, ...prev]);
      if (payload.ok && payload.code) {
        setLatestCode(payload.code);
      } else if (payload.code) {
        setLatestCode(payload.code);
      }
    } catch (error) {
      setDeliverLogs((prev) => [
        {
          key: `live-${Date.now()}`,
          time: formatTime(new Date().toISOString()),
          ok: false,
          method: "POST",
          url: deliverUrl,
          requestHeaders: null,
          requestBody: null,
          status: null,
          durationMs: null,
          responseBody: null,
          code: null,
          message: null,
          error: error instanceof Error ? error.message : "发货请求失败",
        },
        ...prev,
      ]);
    } finally {
      setDelivering(false);
    }
  }, [deliverProduct, deliverUrl, deliverKey]);

  const simulatorConfig = selectedBot ? menuConfigs[selectedBot.id] : null;
  const botName = selectedBot?.name ?? "机器人";

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-6.5rem)] lg:min-h-[640px]">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">机器人测试</h1>
        <p className="text-sm text-muted-foreground">
          右侧仿真屏还原真实 iOS Telegram APP：群组列表展示当前机器人 Token 下的真实群组（点击群组进入群聊，点头像/三个点进入群组设置），
          搜索框粘贴加群链接可弹出真实加群确认面板；左侧导入闲鱼商品并模拟发货获取测试验证码，完整走通加群验证全链路。
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
              // （selectedChatId 残留会让 activeGroup 回退到旧机器人群组）、
              // 验证会话/验证码/加群状态机/聊天视图全部清空
              setSelectedChatId("");
              setSession(null);
              setLatestCode(null);
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

      <div className="flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
        <section
          aria-label="闲鱼商品面板"
          className="flex w-full flex-col gap-3 lg:w-[380px] lg:shrink-0"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">闲鱼商品（{products.length}）</h2>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={refreshProducts} aria-label="刷新商品列表">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="sm" onClick={() => { setImportOpen(true); setImportSuccess(null); setImportError(null); }} className="gap-1">
                <PackageOpen className="h-3.5 w-3.5" />
                导入闲鱼商品
              </Button>
            </div>
          </div>

          <div className="max-h-[420px] flex-1 space-y-2 overflow-y-auto pr-1 lg:max-h-none">
            {products.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                还没有商品，点击「导入闲鱼商品」从商品 API 拉取
              </div>
            ) : (
              products.map((product) => (
                <article key={product.id} className="rounded-xl border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={product.title}>
                        {product.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {product.price ? `¥${product.price}` : "价格未提供"} ·{" "}
                        <span className="font-mono">{product.externalId ?? `#${product.id}`}</span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setDetailProduct(product)}
                    >
                      查看详情
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2.5 text-xs"
                      onClick={() => void openDeliverDialog(product)}
                    >
                      <Truck className="h-3 w-3" />
                      模拟发货
                    </Button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section
          aria-label="仿真屏"
          className="min-h-[560px] min-w-0 overflow-y-auto lg:min-h-0 lg:w-1/3 lg:shrink-0"
        >
          {simulatorConfig && selectedBot ? (
            <div className="h-full">
              <TgAppSimulator
                config={simulatorConfig}
                botName={botName}
                botUsername={selectedBot.username}
                selectedBotId={selectedBot.id}
                groups={appGroups}
                activeChatId={activeGroup ? activeGroup.chatId : null}
                memberCount={activeGroup ? "仿真模式" : "私聊仿真模式"}
                systemNote={
                  !activeGroup
                    ? "私聊仿真模式：请先为该机器人的群组配置验证方式"
                    : joinPhase === "idle"
                      ? `仿真真实加群流程：点击下方「申请加入群组」按钮开始（验证方式：${activeGroup.methodName ?? activeGroup.method}）`
                      : joinPhase === "joined"
                        ? `仿真群 ${activeGroup.chatId} · 已加入群组`
                        : isGroupChannelView(session?.verificationChannel, session?.chatId)
                          ? "群内验证中：申请已自动批准进群，验证消息已发到群内（输入内容其他成员不可见）"
                          : simView === "private"
                            ? "私聊验证中（隐私模式）：验证码仅机器人可见，不会出现在群里"
                            : `仿真群 ${activeGroup.chatId} · 请输入验证码后点击发送按钮`
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
                            ? "群内验证消息（仿真：在下方输入框模拟按钮点选/网页输码）"
                            : "请输入验证码后点击发送按钮（仿真 force_reply）",
                      }
                    : null
                }
                onUserSend={joinPhase === "joined" ? undefined : submitCode}
                joinPhase={joinPhase}
                onRequestJoin={handleRequestJoin}
                view={simView}
                onSelectGroup={(chatId) => {
                  // 进入群聊：重置验证会话（与切换群组同语义）
                  setSelectedChatId(chatId);
                  setSession(null);
                  setLatestCode(null);
                  setJoinPhase("idle");
                  setSimView("group");
                }}
                onSyncGroups={() => void realGroups.sync()}
                syncing={syncing}
                onDeployGroup={handleDeployForGroup}
                deployingChatId={deployingChatId}
                onSimulateJoinForGroup={handleRequestJoinForGroup}
                chatOpenRequest={chatOpenRequest}
                onSettingsSaved={refreshPageData}
              />
            </div>
          ) : (
            <div className="flex h-full min-h-[420px] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
              请先创建机器人
            </div>
          )}
        </section>
      </div>

      <Dialog open={joinOpen} onOpenChange={(open) => { setJoinOpen(open); if (open) setJoinError(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>模拟加群申请</DialogTitle>
            <DialogDescription>
              完整仿真真实 APP 加群流程（下方配置保存到群组绑定，仿真与真实验证共用）：
              ①完成验证 API 配置 → ②仿真屏显示真实加群界面，底部为「申请加入群组」按钮 →
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

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入闲鱼商品</DialogTitle>
            <DialogDescription>
              {importMethod === "GET"
                ? `从商品 API 拉取商品（GET，${importParam.trim() || "limit"} 参数附加到 URL，携带 Bearer apikey），导入后显示在左侧列表。`
                : `从商品 API 拉取商品（POST，${importParam.trim() || "limit"} 参数放入 JSON 请求体，携带 Bearer apikey），导入后显示在左侧列表。`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="import-url">商品 API URL</Label>
              <Input
                id="import-url"
                value={importUrl}
                onChange={(event) => setImportUrl(event.target.value)}
                placeholder="https://your-api.com/xianyu/products"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label>请求方式</Label>
              <Tabs
                value={importMethod}
                onValueChange={(value) => setImportMethod(value as "GET" | "POST")}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="GET">GET（参数附加到 URL）</TabsTrigger>
                  <TabsTrigger value="POST">POST（参数放入请求体）</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-key">Bearer apikey</Label>
              <Input
                id="import-key"
                value={importKey}
                onChange={(event) => setImportKey(event.target.value)}
                placeholder="sk-xxxx"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="import-param">条数参数名</Label>
                <Input
                  id="import-param"
                  value={importParam}
                  onChange={(event) => setImportParam(event.target.value)}
                  placeholder="limit"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="import-count">导入条数</Label>
                <Input
                  id="import-count"
                  type="number"
                  min={1}
                  max={200}
                  value={importCount}
                  onChange={(event) => setImportCount(event.target.value)}
                />
              </div>
            </div>
            {importError ? <p className="text-sm text-red-600">{importError}</p> : null}
            {importSuccess ? (
              <p className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700">✓ {importSuccess}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={runImport} disabled={importing} className="gap-1.5">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailProduct !== null} onOpenChange={(open) => !open && setDetailProduct(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>商品详情</DialogTitle>
          </DialogHeader>
          {detailProduct ? (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">标题</p>
                <p className="font-medium">{detailProduct.title}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">价格</p>
                  <p>{detailProduct.price ? `¥${detailProduct.price}` : "-"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">商品 ID</p>
                  <p className="font-mono text-xs">{detailProduct.externalId ?? `#${detailProduct.id}`}</p>
                </div>
              </div>
              {detailProduct.description ? (
                <div>
                  <p className="text-xs text-muted-foreground">描述</p>
                  <p className="whitespace-pre-wrap">{detailProduct.description}</p>
                </div>
              ) : null}
              <div>
                <p className="text-xs text-muted-foreground">来源 API</p>
                <p className="break-all font-mono text-xs">{detailProduct.sourceUrl ?? "-"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">导入时间</p>
                <p>{formatTime(detailProduct.createdTime)}</p>
              </div>
              <Separator />
              <div>
                <p className="mb-1 text-xs text-muted-foreground">原始 JSON</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
                  {detailProduct.rawJson ?? "-"}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={deliverProduct !== null} onOpenChange={(open) => !open && setDeliverProduct(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>模拟发货 · {deliverProduct?.title ?? ""}</DialogTitle>
            <DialogDescription>
              调用发货 API（POST，携带 Bearer apikey），返回的测试加群验证码模拟买家收到的卡密：复制后点击仿真屏底部「申请加入群组」，在输入框输入该验证码完成验证。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="deliver-url">发货 API URL</Label>
              <Input
                id="deliver-url"
                value={deliverUrl}
                onChange={(event) => setDeliverUrl(event.target.value)}
                placeholder="https://your-api.com/deliver"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deliver-key">Bearer apikey</Label>
              <Input
                id="deliver-key"
                value={deliverKey}
                onChange={(event) => setDeliverKey(event.target.value)}
                placeholder="sk-xxxx"
                className="font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={runDeliver} disabled={delivering} className="gap-1.5">
                {delivering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                发货
              </Button>
              {delivering ? <span className="text-sm text-muted-foreground">请求中…</span> : null}
            </div>

            {latestCode ? (
              <div className="rounded-lg border border-[#3390ec]/40 bg-[#3390ec]/5 p-3">
                <p className="text-xs font-medium text-muted-foreground">获取到测试加群验证码</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-background px-3 py-1.5 font-mono text-lg font-bold tracking-[0.2em] text-[#3390ec]">
                    {latestCode}
                  </code>
                  <CopyCodeButton code={latestCode} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  复制后点击仿真屏底部「申请加入群组」，在输入框输入该验证码并点发送按钮完成验证（也可输入错误验证码测试失败路径）。
                </p>
              </div>
            ) : null}

            <Separator />

            <div className="space-y-2">
              <p className="text-sm font-medium">发货请求详细日志（{deliverLogs.length}）</p>
              {deliverLogs.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  点击「发货」后，这里将展示完整请求/响应日志
                </p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {deliverLogs.map((log) => (
                    <LogRequestBlock key={log.key} log={log} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
