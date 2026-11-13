"use client";

import { useState } from "react";
import { ChevronRight, Loader2, Settings2, X } from "lucide-react";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";

/**
 * 「绑定验证方法 + 配置外部验证 API」（v2.1.7，管理后台表单内嵌组件）：
 *
 * 与机器人测试仿真屏「验证方式 → 外部API」同款交互（图 2 红框入口卡）：
 * - 绑定验证方法下拉：列出验证方式库全部方法（#id 名称（启用/停用）），不再只显示启用的；
 * - 「配置外部验证 API」入口卡：点击展开内联编辑器（URL / Bearer apikey / GET·POST /
 *   验证码字段名 / 请求体模板 / 响应解析 / 超时），保存写入「验证方式」库同一数据源；
 *   未绑定方法时保存自动创建（默认名 TGAPI解锁核验（外部API），可用 autoCreateName 定制）；
 * - 联调测试：用编辑器当前配置真实调用一次外部 API。
 *
 * 绑定结果通过 hidden input（verification_method_id）随外层表单一起提交；
 * 非表单场景（v2.1.13 菜单设计器「外部验证 API」按钮）可通过 onChange 回调
 * 同步绑定结果到受控状态，此时 hidden input 无害（目标 action 不读该字段）。
 */

interface MethodOption {
  id: number;
  name: string;
  enabled: boolean;
  type: string;
}

interface MethodApiConfigForm {
  url: string;
  http_method: "GET" | "POST";
  api_key: string;
  code_field: string;
  body_template: string;
  success_status: string;
  success_field: string;
  success_value: string;
  timeout_seconds: string;
}

const EMPTY_API_FORM: MethodApiConfigForm = {
  url: "",
  http_method: "POST",
  api_key: "",
  code_field: "code",
  body_template: "",
  success_status: "200",
  success_field: "success",
  success_value: "true",
  timeout_seconds: "10",
};

type StatusMessage = { kind: "ok" | "error"; text: string } | null;

interface ApiPayload<T> {
  ok?: boolean;
  error?: string;
  data?: T;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; error?: string; data?: T }> {
  try {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as ApiPayload<T> | null;
    if (!payload) {
      return { ok: false, error: `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试` };
    }
    if (!payload.ok) {
      return { ok: false, error: payload.error ?? `请求失败（HTTP ${response.status}）` };
    }
    return { ok: true, data: payload.data as T };
  } catch (error) {
    console.error(`TGAPI method-config 请求失败 (${url}):`, error);
    return { ok: false, error: `网络请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function formStateFromConfig(config: Record<string, unknown> | null): MethodApiConfigForm {
  if (!config) return { ...EMPTY_API_FORM };
  return {
    url: typeof config.url === "string" ? config.url : "",
    http_method: config.http_method === "GET" ? "GET" : "POST",
    api_key: typeof config.api_key === "string" ? config.api_key : "",
    code_field: typeof config.code_field === "string" && config.code_field ? config.code_field : "code",
    body_template: typeof config.body_template === "string" ? config.body_template : "",
    success_status: String(config.success_status ?? 200),
    success_field: typeof config.success_field === "string" && config.success_field ? config.success_field : "success",
    success_value: config.success_value === undefined || config.success_value === null ? "true" : String(config.success_value),
    timeout_seconds: String(config.timeout_seconds ?? 10),
  };
}

export function TgApiUnlockMethodBinding({
  initialMethods,
  initialMethodId,
  /** 绑定结果同步回调（v2.1.13）：下拉切换/保存成功后回传当前方法 id（null = 未绑定），供受控状态场景使用 */
  onChange,
  /** 未绑定时保存自动创建的方法名（v2.1.13，默认 TGAPI解锁核验（外部API）） */
  autoCreateName,
  /** 方法类型过滤（v2.1.13，如 "code_api"）：下拉与保存后刷新均只保留该类型 */
  typeFilter,
  /** 调用来源（v2.1.13）：随 PUT body 传给 method-config API，日志按来源区分 */
  source,
  /** v2.3 绑定结果 hidden 字段名（默认 verification_method_id；同表单多处绑定时区分） */
  hiddenName,
}: {
  initialMethods: MethodOption[];
  initialMethodId: number | null;
  onChange?: (methodId: number | null) => void;
  autoCreateName?: string;
  typeFilter?: string;
  source?: string;
  hiddenName?: string;
}) {
  // 类型过滤统一应用：初始列表与保存后刷新列表同一谓词，保证下拉选项稳定
  const filterMethods = (methods: MethodOption[]): MethodOption[] =>
    typeFilter ? methods.filter((method) => method.type === typeFilter) : methods;
  const [methods, setMethods] = useState<MethodOption[]>(() => filterMethods(initialMethods));
  const [methodId, setMethodId] = useState<string>(initialMethodId ? String(initialMethodId) : "");
  const [editorOpen, setEditorOpen] = useState(false);
  const [apiForm, setApiForm] = useState<MethodApiConfigForm>({ ...EMPTY_API_FORM });
  const [newMethodName, setNewMethodName] = useState("");
  const [testCode, setTestCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);

  const selected = methods.find((method) => String(method.id) === methodId) ?? null;

  /** 绑定变化统一出口：受控场景经 onChange 同步外层状态 */
  const notifyChange = (nextId: string): void => {
    setMethodId(nextId);
    onChange?.(nextId ? Number(nextId) : null);
  };

  const updateField = (patch: Partial<MethodApiConfigForm>): void => {
    setApiForm((prev) => ({ ...prev, ...patch }));
  };

  const apiConfigPayload = () => ({
    url: apiForm.url.trim(),
    api_key: apiForm.api_key.trim(),
    http_method: apiForm.http_method,
    code_field: apiForm.code_field.trim(),
    body_template: apiForm.body_template,
    success_status: Number(apiForm.success_status),
    success_field: apiForm.success_field.trim(),
    success_value: apiForm.success_value.trim(),
    timeout_seconds: Number(apiForm.timeout_seconds),
  });

  /** 展开编辑器：已绑定方法时先拉取其 config 回显（失败不静默，直接提示） */
  const openEditor = async (): Promise<void> => {
    setEditorOpen(true);
    if (!methodId) {
      setApiForm({ ...EMPTY_API_FORM });
      setStatus(null);
      return;
    }
    setLoading(true);
    const result = await requestJson<{
      config: Record<string, unknown> | null;
    }>(`/api/admin/tgapi/method-config?method_id=${encodeURIComponent(methodId)}`);
    setLoading(false);
    if (!result.ok || !result.data) {
      setStatus({ kind: "error", text: result.error ?? "读取验证方式配置失败" });
      return;
    }
    setApiForm(formStateFromConfig(result.data.config));
    setStatus(null);
  };

  /** 保存（创建/更新验证方式）并同步绑定下拉 */
  const saveConfig = async (): Promise<void> => {
    setSaving(true);
    setStatus(null);
    const result = await requestJson<{
      method_id: string;
      method_name: string;
      config: Record<string, unknown> | null;
      methods: MethodOption[];
    }>("/api/admin/tgapi/method-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method_id: methodId || undefined,
        method_name: newMethodName.trim() || autoCreateName || undefined,
        config: apiConfigPayload(),
        ...(source ? { source } : {}),
      }),
    });
    setSaving(false);
    if (!result.ok || !result.data) {
      setStatus({ kind: "error", text: result.error ?? "保存失败" });
      return;
    }
    setMethods(filterMethods(result.data.methods));
    notifyChange(result.data.method_id);
    setApiForm(formStateFromConfig(result.data.config));
    setNewMethodName("");
    setStatus({ kind: "ok", text: `已保存并绑定验证方式：${result.data.method_name}（方法 #${result.data.method_id}）` });
  };

  /** 联调测试：用编辑器当前配置真实调用一次外部 API（无需先保存） */
  const runTest = async (): Promise<void> => {
    if (!testCode.trim()) {
      setStatus({ kind: "error", text: "请先输入测试验证码" });
      return;
    }
    setTesting(true);
    setStatus(null);
    const result = await requestJson<{ verify_ok: boolean; message: string; network_error: boolean }>(
      "/api/admin/tgapi/method-config",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method_id: methodId || undefined,
          config: apiConfigPayload(),
          code: testCode.trim(),
        }),
      },
    );
    setTesting(false);
    if (!result.ok || !result.data) {
      setStatus({ kind: "error", text: result.error ?? "测试请求失败" });
      return;
    }
    setStatus({
      kind: result.data.verify_ok ? "ok" : "error",
      text: `外部 API 测试${result.data.verify_ok ? "通过" : "未通过"}：${result.data.message}`,
    });
  };

  return (
    <div className="space-y-2">
      <input type="hidden" name={hiddenName ?? "verification_method_id"} value={methodId} />
      <label className={labelClass} htmlFor="tgapi-unlock-method-binding">
        绑定验证方法（验证方式库全部方法）
      </label>
      <select
        id="tgapi-unlock-method-binding"
        value={methodId}
        onChange={(event) => {
          notifyChange(event.target.value);
          setEditorOpen(false);
          setStatus(null);
        }}
        className={selectClass}
      >
        <option value="">请选择验证方式</option>
        {methods.map((method) => (
          <option key={method.id} value={String(method.id)}>
            #{method.id} {method.name}（{method.enabled ? "启用" : "停用"}）
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          if (editorOpen) {
            setEditorOpen(false);
            return;
          }
          void openEditor();
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg bg-primary/10 px-3 py-2.5 text-left transition-colors hover:bg-primary/15"
      >
        <Settings2 className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-primary">配置外部验证 API</span>
          <span className="block truncate text-xs text-muted-foreground">
            {selected
              ? `${selected.name}（方法 #${selected.id}）· 点击修改`
              : "验证 API 地址 / Bearer apikey / 传参 / 响应解析 / 超时 · 未绑定时保存自动创建"}
          </span>
        </span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${editorOpen ? "rotate-90" : ""}`} />
      </button>

      {editorOpen ? (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">外部验证 API 配置（与「验证方式」库同一数据源）</p>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              aria-label="收起外部验证 API 配置"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {!methodId ? (
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-method-name">
                    方法名称（保存时按名称复用或自动创建）
                  </label>
                  <input
                    id="tgapi-method-name"
                    value={newMethodName}
                    onChange={(event) => setNewMethodName(event.target.value)}
                    placeholder="默认：TGAPI解锁核验（外部API）"
                    className={inputClass}
                  />
                </div>
              ) : null}
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-api-url">
                  验证 API 地址 *
                </label>
                <input
                  id="tgapi-api-url"
                  value={apiForm.url}
                  onChange={(event) => updateField({ url: event.target.value })}
                  placeholder="https://your-api.example.com/verify"
                  className={`${inputClass} font-mono`}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <span className={labelClass}>请求方式</span>
                <div className="flex rounded-md border p-0.5">
                  {([
                    { value: "GET", label: "GET（参数拼 URL）" },
                    { value: "POST", label: "POST（JSON 请求体）" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updateField({ http_method: option.value })}
                      className={`flex-1 rounded-[5px] px-2 py-1.5 text-sm font-medium transition-colors ${
                        apiForm.http_method === option.value
                          ? "bg-background shadow-sm border"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-api-key">
                  Bearer API Key *
                </label>
                <input
                  id="tgapi-api-key"
                  value={apiForm.api_key}
                  onChange={(event) => updateField({ api_key: event.target.value })}
                  placeholder="sk-xxxx / xyk_xxxx"
                  className={`${inputClass} font-mono`}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="tgapi-code-field">
                  验证码字段名（传参）
                </label>
                <input
                  id="tgapi-code-field"
                  value={apiForm.code_field}
                  onChange={(event) => updateField({ code_field: event.target.value })}
                  placeholder="code（兼容 card / key 等自定义字段名）"
                  className={`${inputClass} font-mono`}
                />
              </div>
              {apiForm.http_method === "POST" ? (
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-body-template">
                    请求体模板（可选，{"{{code}} {{user_id}} {{username}}"} 自动替换）
                  </label>
                  <textarea
                    id="tgapi-body-template"
                    value={apiForm.body_template}
                    onChange={(event) => updateField({ body_template: event.target.value })}
                    rows={3}
                    placeholder='{"key":"{{code}}","uid":{{user_id}}}'
                    className={`${inputClass} resize-none font-mono`}
                  />
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-success-status">
                    判定 HTTP 状态码
                  </label>
                  <input
                    id="tgapi-success-status"
                    value={apiForm.success_status}
                    onChange={(event) => updateField({ success_status: event.target.value })}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-success-field">
                    判定字段（success_field）
                  </label>
                  <input
                    id="tgapi-success-field"
                    value={apiForm.success_field}
                    onChange={(event) => updateField({ success_field: event.target.value })}
                    placeholder="success / valid / ok"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-success-value">
                    判定值（success_value）
                  </label>
                  <input
                    id="tgapi-success-value"
                    value={apiForm.success_value}
                    onChange={(event) => updateField({ success_value: event.target.value })}
                    placeholder="true"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="tgapi-timeout">
                    超时秒数（5-60）
                  </label>
                  <input
                    id="tgapi-timeout"
                    value={apiForm.timeout_seconds}
                    onChange={(event) => updateField({ timeout_seconds: event.target.value })}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-40 flex-1 space-y-1">
                  <label className={labelClass} htmlFor="tgapi-test-code">
                    测试验证码（联调）
                  </label>
                  <input
                    id="tgapi-test-code"
                    value={testCode}
                    onChange={(event) => setTestCode(event.target.value)}
                    placeholder="输入真实卡密/验证码"
                    className={inputClass}
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void runTest()}
                  disabled={testing}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent disabled:opacity-60"
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  调用外部 API 测试
                </button>
                <button
                  type="button"
                  onClick={() => void saveConfig()}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  保存配置
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                请求自动携带 <span className="font-mono">Authorization: Bearer api_key</span>；
                判定规则：HTTP 状态等于判定状态码且响应 JSON 中判定字段等于判定值。保存后绑定关系随本表单一并提交。
              </p>
            </>
          )}
          {status ? (
            <p
              className={`rounded-md border px-3 py-2 text-sm ${
                status.kind === "ok"
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {status.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
