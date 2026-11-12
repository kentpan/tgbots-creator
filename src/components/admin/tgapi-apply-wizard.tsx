"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { TGAPI_DEFAULT_APP } from "@/services/tgapi-config";
import { TGAPI_PLATFORM_LABELS, TGAPI_PLATFORM_VALUES } from "@/services/menu-config";

/**
 * TGAPI申请 管理端「多步骤申请向导」弹窗（v2.1.8）。
 *
 * 流程（对应 my.telegram.org 四步接口，登录码发到对应手机号 Telegram 账号的
 * 「Telegram 服务通知」应用内会话，非短信 —— 任意手机号可申请，无需接码）：
 *   1️⃣ 手机号 → 服务端 POST /auth/send_password（返回 sessionId）
 *   2️⃣ 验证码 → 服务端 POST /auth/login → GET /apps
 *        ├─ 已有 APP → 直接跳 4️⃣ 结果
 *        └─ 无 APP   → 3️⃣
 *   3️⃣ APP 名称/描述 → POST /apps/create → 复核
 *   4️⃣ 结果：APP ID / API HASH / MTProto 服务器（一键复制）
 */

/** /api/admin/tgapi/apply 的响应结构 */
interface ApplyResponse {
  ok: boolean;
  error?: string;
  data?: {
    session_id?: string;
    phone?: string;
    login_ok?: boolean;
    status?: "existing" | "no_app" | "created";
    app?: TgAppInfoView;
    error?: string;
  };
}

/** 结果展示的 APP 信息（与 my-telegram-org.ts TgAppInfo 一致） */
interface TgAppInfoView {
  appId: string;
  apiHash: string;
  testConfiguration: { ip: string; dc: string };
  productionConfiguration: { ip: string; dc: string };
}

const STEP_LABELS = ["手机号", "验证码", "APP 信息", "结果"] as const;

/** 步骤指示条（1️⃣-4️⃣） */
function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {STEP_LABELS.map((label, index) => {
        const current = index + 1;
        const isDone = current < step;
        const isActive = current === step;
        return (
          <div key={label} className="flex items-center gap-1.5">
            {index > 0 ? <span className="text-muted-foreground/60">—</span> : null}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "border border-green-200 bg-green-50 text-green-700"
                    : "border bg-muted/40 text-muted-foreground"
              }`}
            >
              <span className="font-mono">{isDone ? "✓" : current}</span>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 复制按钮（点击后短暂显示「已复制」） */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 剪贴板 API 不可用（非安全上下文）时退回 execCommand
      const textarea = document.createElement("textarea");
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-xs hover:bg-accent"
      aria-label={`复制${label}`}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** 结果展示卡片（APP ID / API HASH / MTProto 服务器） */
function AppResultCard({ app }: { app: TgAppInfoView }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">APP ID（api_id）</p>
            <p className="truncate font-mono text-base font-semibold">{app.appId}</p>
          </div>
          <CopyButton value={app.appId} label="APP ID" />
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">API HASH（api_hash，请勿外传）</p>
            <p className="truncate font-mono text-base font-semibold">{app.apiHash}</p>
          </div>
          <CopyButton value={app.apiHash} label="API HASH" />
        </div>
      </div>
      <div className="rounded-lg border p-4 text-sm space-y-1">
        <p className="font-medium">Available MTProto Servers</p>
        <p className="text-muted-foreground">
          Production：<span className="font-mono">{app.productionConfiguration.ip}</span>{" "}
          <span className="underline">{app.productionConfiguration.dc}</span>
        </p>
        <p className="text-muted-foreground">
          Test：<span className="font-mono">{app.testConfiguration.ip}</span>{" "}
          <span className="underline">{app.testConfiguration.dc}</span>
        </p>
      </div>
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        Disclaimer: It is forbidden to pass this value to third parties.（禁止把该值透露给第三方）
      </p>
    </div>
  );
}

export function TgApiApplyWizard({
  trigger = "⚡ 申请 API",
  triggerClassName = "inline-flex h-10 shrink-0 items-center rounded-md border bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700",
}: {
  trigger?: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [appTitle, setAppTitle] = useState(TGAPI_DEFAULT_APP.appTitle);
  const [appDescription, setAppDescription] = useState(TGAPI_DEFAULT_APP.appDescription);
  const [appPlatform, setAppPlatform] = useState<string>(TGAPI_PLATFORM_VALUES[0]);
  const [resultApp, setResultApp] = useState<TgAppInfoView | null>(null);
  const [resultCreated, setResultCreated] = useState(false);

  /** 打开时重置向导（关闭仅隐藏，下次打开回到第一步） */
  useEffect(() => {
    if (open) {
      setStep(1);
      setPending(false);
      setError(null);
      setPhone("");
      setSessionId(null);
      setCode("");
      setAppTitle(TGAPI_DEFAULT_APP.appTitle);
      setAppDescription(TGAPI_DEFAULT_APP.appDescription);
      setAppPlatform(TGAPI_PLATFORM_VALUES[0]);
      setResultApp(null);
      setResultCreated(false);
    }
  }, [open]);

  async function callApply(payload: Record<string, unknown>): Promise<ApplyResponse> {
    const response = await fetch("/api/admin/tgapi/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await response.json().catch(() => null)) as ApplyResponse | null;
    if (!json) {
      return { ok: false, error: `HTTP ${response.status}：服务端无响应` };
    }
    return json;
  }

  /** Step 1 → 发送验证码 */
  async function handleSendCode(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const res = await callApply({ action: "send_code", phone });
      if (!res.ok) {
        setError(res.error ?? "发送验证码失败");
        return;
      }
      setSessionId(res.data?.session_id ?? null);
      setStep(2);
    } catch (err) {
      console.error("TGAPI apply wizard send_code request failed:", err);
      setError(`网络请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  }

  /** Step 2 → 登录 + 抓取 /apps */
  async function handleVerify(): Promise<void> {
    if (!sessionId) {
      setError("申请会话缺失，请返回第一步重新发送验证码");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await callApply({ action: "verify", session_id: sessionId, code });
      if (!res.ok) {
        setError(res.error ?? "登录失败");
        return;
      }
      if (res.data?.login_ok === false) {
        setError(`my.telegram.org 拒绝登录：${res.data.error || "未知原因"}（可检查验证码后重试）`);
        return;
      }
      if (res.data?.status === "existing" && res.data.app) {
        setResultApp(res.data.app);
        setResultCreated(false);
        setStep(4);
        return;
      }
      setStep(3);
    } catch (err) {
      console.error("TGAPI apply wizard verify request failed:", err);
      setError(`网络请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  }

  /** Step 3 → 创建 APP */
  async function handleCreate(): Promise<void> {
    if (!sessionId) {
      setError("申请会话缺失，请重新开始向导");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await callApply({
        action: "create",
        session_id: sessionId,
        app_title: appTitle,
        app_description: appDescription,
        app_platform: appPlatform,
      });
      if (!res.ok) {
        setError(res.error ?? "创建 APP 失败");
        return;
      }
      if (res.data?.app) {
        setResultApp(res.data.app);
        setResultCreated(res.data.status !== "existing");
        setStep(4);
        return;
      }
      setError("服务端未返回 APP 信息，请重新走一遍向导");
    } catch (err) {
      console.error("TGAPI apply wizard create request failed:", err);
      setError(`网络请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(false);
    }
  }

  /** 回到第一步重新开始（保留弹窗打开状态） */
  function restart(): void {
    setStep(1);
    setSessionId(null);
    setCode("");
    setError(null);
    setResultApp(null);
    setResultCreated(false);
  }

  const footerCommon = "inline-flex h-10 items-center rounded-md px-4 text-sm font-medium";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>申请 Telegram API（my.telegram.org）</DialogTitle>
          <DialogDescription>
            登录码会发送到该手机号对应 Telegram 账号的「Telegram 服务通知」（应用内消息，不是短信），
            因此任意手机号都可申请 —— 请确保你能查看该账号的 Telegram 消息。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <StepIndicator step={step} />
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-wizard-phone">
                  Telegram 手机号（国际格式）*
                </label>
                <input
                  id="tgapi-wizard-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+8613800138000"
                  className={inputClass}
                  autoComplete="off"
                  disabled={pending}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                点击「发送验证码」后，Telegram 官方（服务通知）会向该账号发送一条含登录码的消息；
                在第二步直接转发/粘贴该消息即可，无需接码平台。
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-3">
              <p className="text-sm">
                验证码已发送至 <span className="font-mono font-semibold">{phone}</span>。
                请打开该账号 Telegram 的「Telegram 服务通知」会话查看登录码。
              </p>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-wizard-code">
                  登录码（可整条转发/粘贴官方消息，或直接填登录码）*
                </label>
                <textarea
                  id="tgapi-wizard-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  rows={3}
                  placeholder={"例如：\nLogin code: 12345\n\nDo not give this code to anyone..."}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  disabled={pending}
                />
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-wizard-title">
                  APP 名称（App title，1-32 字符）*
                </label>
                <input
                  id="tgapi-wizard-title"
                  value={appTitle}
                  onChange={(event) => setAppTitle(event.target.value)}
                  className={inputClass}
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground">
                  短名（shortname）由 APP 名称自动派生，不合法时使用默认值。
                </p>
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-wizard-desc">
                  APP 描述（App description）*
                </label>
                <textarea
                  id="tgapi-wizard-desc"
                  value={appDescription}
                  onChange={(event) => setAppDescription(event.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  disabled={pending}
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-wizard-platform">
                  APP 平台（app_platform）*
                </label>
                <select
                  id="tgapi-wizard-platform"
                  value={appPlatform}
                  onChange={(event) => setAppPlatform(event.target.value)}
                  className={inputClass}
                  disabled={pending}
                >
                  {TGAPI_PLATFORM_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {TGAPI_PLATFORM_LABELS[value] ?? value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {step === 4 && resultApp ? (
            <div className="space-y-3">
              <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                {resultCreated ? "✅ APP 创建成功，以下是接口凭证：" : "✅ 该账号已有 APP，以下是接口凭证："}
              </div>
              <AppResultCard app={resultApp} />
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/30 px-6 py-3">
          <div>
            {step === 2 ? (
              <button
                type="button"
                onClick={restart}
                disabled={pending}
                className={`${footerCommon} border hover:bg-accent`}
              >
                ← 重新开始
              </button>
            ) : null}
            {step === 4 ? (
              <button
                type="button"
                onClick={restart}
                className={`${footerCommon} border hover:bg-accent`}
              >
                再申请一个
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={`${footerCommon} border hover:bg-accent`}
            >
              {step === 4 ? "关闭" : "取消"}
            </button>
            {step === 1 ? (
              <button
                type="button"
                onClick={handleSendCode}
                disabled={pending || !phone.trim()}
                className={`${footerCommon} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60`}
              >
                {pending ? "发送中…" : "发送验证码"}
              </button>
            ) : null}
            {step === 2 ? (
              <button
                type="button"
                onClick={handleVerify}
                disabled={pending || !code.trim()}
                className={`${footerCommon} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60`}
              >
                {pending ? "登录中…" : "登录"}
              </button>
            ) : null}
            {step === 3 ? (
              <button
                type="button"
                onClick={handleCreate}
                disabled={pending || !appTitle.trim() || !appDescription.trim()}
                className={`${footerCommon} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60`}
              >
                {pending ? "创建中…" : "创建 APP"}
              </button>
            ) : null}
            {step === 4 ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={`${footerCommon} bg-primary text-primary-foreground hover:bg-primary/90`}
              >
                完成
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
