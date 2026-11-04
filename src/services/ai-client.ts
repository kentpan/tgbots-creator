import {
  checkAiRateLimit,
  getAiProvider,
  markAiHit,
  recordAiUsage,
  resolveAiModel,
  resolveDefaultAiProvider,
  type AiProviderRow,
} from "./ai-config";

/**
 * 统一 AI 调用入口（OpenAI 兼容 /chat/completions）
 *
 * 供所有需要 AI 能力的功能复用（客服机器人、意图识别等）：
 * 1. provider 解析：显式 providerId > 系统默认 provider（is_default 且启用）
 * 2. 模型解析：显式 model > provider.selected_model（auto = 拉取列表第一个）
 * 3. 限速：provider 级滑动窗口（如 60 次/60s），超限快速失败并附带重试等待时间
 * 4. 统计：每次调用写入 ai_usage_logs（供图表聚合）
 */

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatInput {
  messages: AiChatMessage[];
  /** 不传时使用系统默认 provider */
  providerId?: bigint | null;
  /** 不传时使用 provider 的 selected_model（auto 语义） */
  model?: string;
  /** 调用场景标记（统计图表按场景聚合）：customer-service / test / classify ... */
  scene?: string;
  botId?: bigint | null;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AiChatResult {
  ok: boolean;
  content: string;
  model: string;
  providerId: bigint | null;
  providerName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
}

async function callProvider(
  provider: AiProviderRow,
  model: string,
  input: AiChatInput,
): Promise<AiChatResult> {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      ok: false,
      content: "",
      model,
      providerId: provider.id,
      providerName: provider.name,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      error: "Base URL 必须以 http:// 或 https:// 开头",
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(120000, Math.max(1000, input.timeoutMs ?? 30000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  markAiHit(provider.id);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const body: Record<string, unknown> = {
      model,
      messages: input.messages,
      stream: false,
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const error = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      await recordAiUsage({
        providerId: provider.id,
        providerName: provider.name,
        model,
        scene: input.scene ?? "chat",
        botId: input.botId ?? null,
        durationMs,
        success: false,
        error,
      });
      return {
        ok: false,
        content: "",
        model,
        providerId: provider.id,
        providerName: provider.name,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs,
        error,
      };
    }

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      const error = "响应不是合法 JSON";
      await recordAiUsage({
        providerId: provider.id,
        providerName: provider.name,
        model,
        scene: input.scene ?? "chat",
        botId: input.botId ?? null,
        durationMs,
        success: false,
        error,
      });
      return {
        ok: false,
        content: "",
        model,
        providerId: provider.id,
        providerName: provider.name,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs,
        error,
      };
    }

    const content = payload.choices?.[0]?.message?.content ?? "";
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const totalTokens = payload.usage?.total_tokens ?? promptTokens + completionTokens;
    const errorMessage = payload.error?.message;

    await recordAiUsage({
      providerId: provider.id,
      providerName: provider.name,
      model,
      scene: input.scene ?? "chat",
      botId: input.botId ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
      success: content.length > 0,
      error: errorMessage ?? (content.length === 0 ? "响应缺少 choices[0].message.content" : null),
    });

    return {
      ok: content.length > 0,
      content,
      model,
      providerId: provider.id,
      providerName: provider.name,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
      error: errorMessage,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const friendly = message === "This operation was aborted" ? `请求超时（${timeoutMs / 1000}s）` : message;
    await recordAiUsage({
      providerId: provider.id,
      providerName: provider.name,
      model,
      scene: input.scene ?? "chat",
      botId: input.botId ?? null,
      durationMs,
      success: false,
      error: friendly,
    });
    return {
      ok: false,
      content: "",
      model,
      providerId: provider.id,
      providerName: provider.name,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs,
      error: friendly,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 统一 AI 对话调用：provider/模型解析 → 限速 → 请求 → 统计落库 */
export async function aiChatCompletion(input: AiChatInput): Promise<AiChatResult> {
  const fail = (error: string): AiChatResult => ({
    ok: false,
    content: "",
    model: input.model ?? "",
    providerId: input.providerId ?? null,
    providerName: "",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    error,
  });

  const provider = input.providerId
    ? await getAiProvider(input.providerId)
    : await resolveDefaultAiProvider();
  if (!provider) return fail("未找到可用的 AI 提供方：请先在「AI 配置」中添加并启用");
  if (!provider.enabled) return fail(`AI 提供方「${provider.name}」已停用`);

  const decision = checkAiRateLimit(provider);
  if (!decision.allowed) {
    const waitSeconds = Math.ceil(decision.retryAfterMs / 1000);
    await recordAiUsage({
      providerId: provider.id,
      providerName: provider.name,
      model: input.model ?? provider.selectedModel,
      scene: input.scene ?? "chat",
      botId: input.botId ?? null,
      durationMs: 0,
      success: false,
      error: `触发接口限速（${decision.limit} 次/${decision.windowSeconds}s），${waitSeconds}s 后可重试`,
    });
    return {
      ok: false,
      content: "",
      model: input.model ?? provider.selectedModel,
      providerId: provider.id,
      providerName: provider.name,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      error: `触发接口限速（${decision.limit} 次/${decision.windowSeconds}s），请 ${waitSeconds}s 后重试`,
      rateLimited: true,
      retryAfterMs: decision.retryAfterMs,
    };
  }

  const model = (input.model ?? "").trim() || resolveAiModel(provider);
  return callProvider(provider, model, input);
}

/** AI 模型下拉浮层选项：第一项恒为 auto（自动选择），其余为各 provider 的可选模型 */
export interface AiModelOption {
  /** 组合值：auto | <providerId>:<model> | <providerId>:auto */
  value: string;
  label: string;
  providerId: number;
  providerName: string;
  model: string;
  isDefaultProvider: boolean;
}

export async function listAiModelOptions(): Promise<{
  options: AiModelOption[];
  defaultProviderId: number | null;
}> {
  const { listEnabledAiProviders } = await import("./ai-config");
  const providers = await listEnabledAiProviders();
  const options: AiModelOption[] = [
    {
      value: "auto",
      label: "⚡ auto · 自动选择（默认模型）",
      providerId: 0,
      providerName: "auto",
      model: "auto",
      isDefaultProvider: false,
    },
  ];
  for (const provider of providers) {
    const tag = provider.isDefault ? "（默认）" : "";
    if (provider.models.length === 0) {
      options.push({
        value: `${provider.id}:auto`,
        label: `${provider.name} · auto（未拉取模型列表）${tag}`,
        providerId: Number(provider.id),
        providerName: provider.name,
        model: "auto",
        isDefaultProvider: provider.isDefault,
      });
      continue;
    }
    for (const model of provider.models) {
      options.push({
        value: `${provider.id}:${model}`,
        label: `${provider.name} · ${model}${tag}`,
        providerId: Number(provider.id),
        providerName: provider.name,
        model,
        isDefaultProvider: provider.isDefault,
      });
    }
  }
  const fallback = providers.find((provider) => provider.isDefault) ?? providers[0];
  return { options, defaultProviderId: fallback ? Number(fallback.id) : null };
}

/** 解析下拉值（"auto" | "<providerId>:<model>"）为具体 provider + model */
export async function resolveAiSelection(value: string): Promise<{ providerId: bigint | null; model: string | null }> {
  if (!value || value === "auto") return { providerId: null, model: null };
  const separator = value.indexOf(":");
  if (separator <= 0) return { providerId: null, model: null };
  const idPart = value.slice(0, separator);
  const modelPart = value.slice(separator + 1);
  try {
    const providerId = BigInt(idPart);
    return { providerId, model: modelPart === "auto" ? null : modelPart };
  } catch {
    return { providerId: null, model: null };
  }
}
