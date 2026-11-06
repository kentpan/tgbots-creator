"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hapticError, hapticSuccess, getTg } from "@/lib/webapp";
import { BackButtonCloseEffect } from "./states";

/**
 * 网页输码（v2.1.0）：群内验证渠道下「人机验证 / 外部 API 卡密」的输码界面。
 *
 * 使用场景：用户在群内点「打开验证页面」按钮 → 打开 /verify?token=… →
 * 在本页输入卡密/验证码。页面内容只有用户本人可见，群成员看不到输入内容
 * （满足「群内验证但验证码不可见」的前提条件）。
 *
 * 判定与收口全部在服务端（/api/v1/verify-code → evaluateSubmittedCode）：
 * 错误 3 次 → 计次→失效→rejected→群内告知+踢出；正确 → 落库批准+解禁+删提示+群内欢迎。
 * 本组件只负责输入、倒计时展示与结果反馈。
 */

export interface CodeVerifyClientProps {
  token: string;
  /** 验证方式说明（自动验证码 / 外部 API 卡密） */
  methodLabel: string;
  /** 会话剩余秒数（首次渲染用；客户端自行倒计时） */
  expiresInSeconds: number;
  /** 群名（展示用，可空） */
  chatTitle?: string | null;
  /** 剩余尝试次数（首屏展示；服务端每次提交后返回准确值） */
  maxAttempts: number;
}

interface SubmitPayload {
  success?: boolean;
  outcome?: string;
  message?: string;
  detail?: string;
  reason?: string | null;
  remaining?: number | null;
  network_error?: boolean;
}

export function CodeVerifyClient({
  token,
  methodLabel,
  expiresInSeconds,
  chatTitle,
  maxAttempts,
}: CodeVerifyClientProps) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(
    null,
  );
  const [remaining, setRemaining] = useState(maxAttempts);
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, expiresInSeconds));
  const [finished, setFinished] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (secondsLeft <= 0 || finished) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [secondsLeft, finished]);

  const submit = useCallback(async (): Promise<void> => {
    const value = code.trim();
    if (!value || submitting || finished) return;
    setSubmitting(true);
    setMessage({ kind: "info", text: "🔄 正在核验，请稍候..." });
    try {
      const response = await fetch("/api/v1/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      const payload = (await response.json()) as SubmitPayload;
      const text = payload.message ?? payload.detail ?? "核验失败，请重试";

      if (payload.success) {
        setFinished(true);
        setMessage({ kind: "success", text });
        hapticSuccess();
        const tg = getTg();
        if (tg) {
          setTimeout(() => {
            tg.MainButton.setText("🎉 关闭页面");
            tg.MainButton.show();
            tg.MainButton.enable();
            tg.MainButton.offClick();
            tg.MainButton.onClick(() => tg.close());
          }, 400);
        }
        return;
      }

      if (typeof payload.remaining === "number") setRemaining(payload.remaining);
      setMessage({ kind: "error", text });
      hapticError();
      setCode("");
      inputRef.current?.focus();
      if (payload.outcome === "failed_expired" || payload.outcome === "session_stale") {
        setFinished(true);
      }
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "网络错误，请重试",
      });
      hapticError();
    } finally {
      setSubmitting(false);
    }
  }, [code, finished, submitting, token]);

  const expired = secondsLeft <= 0;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="tg-page min-h-screen flex flex-col">
      <BackButtonCloseEffect />
      <div className="flex-1 flex flex-col justify-center">
        <div className="tg-card">
          <div className="text-center mb-6">
            <div className="text-6xl mb-3">🔐</div>
            <h1 className="text-2xl font-bold mb-2 text-fg">入群验证</h1>
            <p className="text-fg-secondary text-sm">
              {chatTitle ? `群组：${chatTitle} · ` : ""}
              {methodLabel}
            </p>
          </div>

          {expired || finished ? null : (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-fg">请输入验证码 / 卡密</span>
                <input
                  ref={inputRef}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                  inputMode="text"
                  autoComplete="one-time-code"
                  placeholder="在此输入，只有你和机器人能看到"
                  className="w-full rounded-lg border border-black/15 bg-white px-3 py-3 text-center text-lg tracking-widest text-black outline-none focus:border-[#3390ec]"
                />
              </label>

              <button
                type="button"
                onClick={() => void submit()}
                disabled={!code.trim() || submitting}
                className="tg-button w-full disabled:opacity-60"
              >
                {submitting ? "核验中..." : "提交验证"}
              </button>

              <div className="flex items-center justify-between text-xs text-fg-hint">
                <span>⏱ 剩余有效期 {`${minutes}:${String(seconds).padStart(2, "0")}`}</span>
                <span>剩余尝试次数 {remaining}</span>
              </div>

              <p className="rounded-lg bg-black/[0.04] px-3 py-2 text-xs leading-relaxed text-fg-hint">
                💡 本页面内容只有你和机器人可见，群内其他成员看不到你输入的验证码。
                请勿把验证码发到群聊里（机器人不会处理群聊中的明文验证码）。
              </p>
            </div>
          )}

          {expired && !finished ? (
            <div className="rounded-lg bg-orange-50 border border-orange-200 p-4 text-center text-orange-700">
              ⏰ 验证链接已过期，请回到群组重新申请加群。
            </div>
          ) : null}

          {message ? (
            <div
              className={`mt-4 rounded-lg p-4 text-center text-sm ${
                message.kind === "success"
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : message.kind === "error"
                    ? "bg-red-50 border border-red-200 text-red-700"
                    : "bg-blue-50 border border-blue-200 text-blue-700"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.text}</p>
              {message.kind === "success" ? (
                <button
                  type="button"
                  onClick={() => getTg()?.close()}
                  className="mt-3 rounded-lg bg-green-600 px-4 py-2 text-white"
                >
                  返回 Telegram
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 text-center text-sm text-fg-hint">
            <p>⚡ 由 TGuard 提供技术支持</p>
          </div>
        </div>
      </div>
    </div>
  );
}
