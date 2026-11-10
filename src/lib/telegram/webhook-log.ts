/**
 * 入站 Webhook 请求日志（v2.2.5）：POST /api/telegram/webhook/** 全量落 api_logs
 * （webhook 类别）—— 密钥校验失败/机器人不存在/格式错误等拒绝路径与正常处理路径
 * 全部记录（原始 update JSON 截断入库），供管理后台「API 日志」页排查。
 */

import { logApi } from "@/lib/api-log";

/** 拒绝路径（密钥不符 / 机器人不存在 / JSON 解析失败）统一记录 */
export function logWebhookRejected(botId: string, statusCode: number, detail: string): void {
  logApi({
    category: "webhook",
    botId,
    method: "rejected",
    ok: false,
    statusCode,
    error: detail,
  });
}

/** 更新类型（update 对象首个非 update_id 字段；未知返回 "unknown"） */
export function webhookUpdateMethod(update: unknown): string {
  if (!update || typeof update !== "object") return "unknown";
  const keys = Object.keys(update as Record<string, unknown>).filter((key) => key !== "update_id");
  return keys[0] ?? "unknown";
}

/** 正常处理路径记录（成功/处理异常均落库，raw JSON 为请求原文） */
export function logWebhookUpdate(input: {
  botId: string;
  botLabel?: string | null;
  update: unknown;
  ok: boolean;
  error?: string | null;
  durationMs: number;
}): void {
  logApi({
    category: "webhook",
    botId: input.botId,
    botLabel: input.botLabel ?? null,
    method: webhookUpdateMethod(input.update),
    ok: input.ok,
    requestPayload: JSON.stringify(input.update ?? null),
    error: input.error ?? null,
    durationMs: input.durationMs,
  });
}
