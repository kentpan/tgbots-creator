import { listVerificationMethods, type VerificationMethodRow } from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { parseCodeApiConfig } from "@/services/external-verify";
import { hasRadsIssueConfig } from "@/services/rads-issue";
import { CopyField } from "@/components/admin/copy-field";
import { ConfigPresetButtons } from "@/components/admin/config-presets";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import {
  deleteMethodAction,
  issueCardAction,
  saveMethodAction,
  testMethodAction,
} from "./actions";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "验证方式已保存",
  deleted: "验证方式已删除",
};

const ERRORS: Record<string, string> = {
  "name-required": "请填写方法名称",
  "invalid-config": "配置 JSON 不合法：需要 url 与 api_key 字段",
  "invalid-id": "验证方法不存在",
  "code-required": "请输入测试验证码",
  "invalid-price": "交易金额必须是大于等于 0 的数字",
};

const GENERIC_PRESET = JSON.stringify(
  {
    url: "https://api.example.com/members/verify",
    api_key: "sk-your-apikey",
    http_method: "POST",
    body_template: '{"user_id":{{user_id}},"code":"{{code}}"}',
    success_status: 200,
    success_field: "valid",
    success_value: "true",
    timeout_seconds: 10,
  },
  null,
  2,
);

const RADS_PRESET = JSON.stringify(
  {
    url: "http://127.0.0.1:3001/api/redeem",
    api_key: "rads-public-redeem",
    http_method: "POST",
    body_template: '{"key":"{{code}}"}',
    success_status: 200,
    success_field: "ok",
    success_value: "true",
    timeout_seconds: 10,
    rads_base_url: "http://127.0.0.1:3001",
    rads_issue_key: "ak-86f5b3bc34c3ed383035e40603e159",
    rads_script_id: 2,
    rads_title: "TGuard 入群验证卡",
    rads_price: 9.9,
    rads_max_uses: 3,
  },
  null,
  2,
);

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function MethodFormDialog({
  method,
  trigger,
  triggerClassName,
}: {
  method?: VerificationMethodRow;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const fieldId = method ? `config-${String(method.id)}` : "config-new";
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={method ? `编辑验证方式 · ${method.name}` : "新增验证方式"}
      description="用户输入验证码后，Bot 使用 Authorization: Bearer <apikey> 请求外部 API 完成核验；对接资源自动交付系统时验证码即 8 位卡密。"
      action={saveMethodAction}
      submitLabel="保存方法"
    >
      <input type="hidden" name="id" value={method ? String(method.id) : ""} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`name-${fieldId}`}>
            方法名称 *
          </label>
          <input
            id={`name-${fieldId}`}
            name="name"
            required
            defaultValue={method?.name ?? ""}
            placeholder="例如：外部会员系统核验"
            className={inputClass}
          />
        </div>
        <div className="flex items-center gap-2 pt-7">
          <input
            id={`enabled-${fieldId}`}
            name="enabled"
            type="checkbox"
            value="1"
            defaultChecked={method ? method.enabled : true}
            className="h-4 w-4"
          />
          <label className={labelClass} htmlFor={`enabled-${fieldId}`}>
            启用该方法
          </label>
        </div>
      </div>
      <div className="space-y-2">
        <label className={labelClass} htmlFor={fieldId}>
          外部 API 配置（JSON）*
        </label>
        <ConfigPresetButtons
          targetId={fieldId}
          presets={[
            { label: "通用外部 API", value: GENERIC_PRESET },
            { label: "资源自动交付系统（卡密核销）", value: RADS_PRESET },
          ]}
        />
        <textarea
          id={fieldId}
          name="config"
          rows={12}
          required
          defaultValue={method?.config ?? GENERIC_PRESET}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
        />
        <p className="text-sm text-muted-foreground">
          请求自动携带 <span className="font-mono">Authorization: Bearer api_key</span>；
          <span className="font-mono">{"{{user_id}} {{code}} {{username}}"}</span> 会被替换为实际值；
          判定规则：HTTP 状态等于 success_status 且响应 JSON 中 success_field 等于 success_value。
        </p>
      </div>
    </FormDialog>
  );
}

export default async function VerificationMethodsPage({
  searchParams,
}: {
  searchParams: Promise<{
    edit?: string;
    saved?: string;
    error?: string;
    test?: string;
    message?: string;
    issued?: string;
    key?: string;
    url?: string;
  }>;
}) {
  await requirePermission("methods:view");
  const params = await searchParams;
  const methods = await listVerificationMethods();

  const editId = params.edit && /^\d+$/.test(params.edit) ? params.edit : null;
  const editingConfig = editId
    ? (() => {
        const found = methods.find((method) => String(method.id) === editId);
        return found ? parseCodeApiConfig(found.config) : null;
      })()
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">验证方式</h1>
          <p className="text-sm text-muted-foreground">
            自定义验证方式：用户输入验证码后，Bot 使用 <span className="font-mono">Authorization: Bearer &lt;apikey&gt;</span> 请求外部 API 完成核验。
            对接资源自动交付系统时，验证码即买家持有的 8 位卡密，Bot 调用其卡密核销接口完成验证。
          </p>
        </div>
        <MethodFormDialog
          trigger="+ 新增验证方式"
          triggerClassName="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        />
      </div>

      {params.saved && NOTICES[params.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[params.saved]}
        </div>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[params.error]}
        </div>
      ) : null}
      {params.test ? (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            params.test === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-orange-200 bg-orange-50 text-orange-700"
          }`}
        >
          外部 API 测试{params.test === "ok" ? "通过" : "未通过"}：{params.message ?? "-"}
        </div>
      ) : null}
      {params.issued === "ok" && params.key ? (
        <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-700">卡密生成成功，把下方分享链接发给买家：</p>
          <CopyField label="卡密（买家在群内输入的验证码）" value={params.key} />
          {params.url ? (
            <>
              <CopyField label="加密分享链接（买家浏览器打开）" value={params.url} />
              <a
                href={params.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
              >
                打开分享链接
              </a>
            </>
          ) : null}
        </div>
      ) : null}
      {params.issued === "fail" ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          发卡失败：{params.message ?? "-"}
        </div>
      ) : null}

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">类型</th>
                <th className="px-4 py-3 font-medium">接口地址</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">更新时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {methods.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有自定义验证方式，点击右上角「新增验证方式」创建
                  </td>
                </tr>
              ) : (
                methods.map((method) => {
                  let apiUrl = "-";
                  try {
                    apiUrl = (JSON.parse(method.config) as { url?: string }).url ?? "-";
                  } catch {
                    apiUrl = "-";
                  }
                  const parsedConfig = parseCodeApiConfig(method.config);
                  const canIssue = parsedConfig ? hasRadsIssueConfig(parsedConfig) : false;
                  return (
                    <tr key={String(method.id)} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{String(method.id)}</td>
                      <td className="px-4 py-3 text-sm">{method.name}</td>
                      <td className="px-4 py-3 text-sm">验证码核验 API</td>
                      <td className="max-w-60 truncate px-4 py-3 font-mono text-sm" title={apiUrl}>
                        {apiUrl}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                            method.enabled
                              ? "border-green-200 bg-green-50 text-green-700"
                              : "border-gray-200 bg-gray-50 text-gray-500"
                          }`}
                        >
                          {method.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(method.updatedTime)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <MethodFormDialog
                            method={method}
                            trigger="编辑"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          />
                          <FormDialog
                            trigger="测试"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                            title={`发送测试验证码 · ${method.name}`}
                            description="直接调用外部 API 验证一次输入的验证码，用于联调。"
                            action={testMethodAction}
                            submitLabel="调用外部 API 测试"
                          >
                            <input type="hidden" name="id" value={String(method.id)} />
                            <div className="space-y-1">
                              <label className={labelClass} htmlFor={`test-${String(method.id)}`}>
                                测试验证码
                              </label>
                              <input
                                id={`test-${String(method.id)}`}
                                name="code"
                                required
                                placeholder="输入要测试的验证码"
                                className={inputClass}
                              />
                            </div>
                          </FormDialog>
                          {canIssue && parsedConfig ? (
                            <FormDialog
                              trigger="发卡"
                              triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                              title={`资源自动交付系统 · 发卡（${method.name}）`}
                              description="调用交付系统发卡 API 生成卡密与加密分享链接：买家打开链接复制卡密 → 点击入群邀请 → 加群输入卡密 → Bot 调核销接口验证，失败 3 次踢出。"
                              action={issueCardAction}
                              submitLabel="生成卡密"
                            >
                              <input type="hidden" name="id" value={String(method.id)} />
                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-1">
                                  <label className={labelClass} htmlFor={`issue-title-${String(method.id)}`}>
                                    商品名称
                                  </label>
                                  <input
                                    id={`issue-title-${String(method.id)}`}
                                    name="title"
                                    defaultValue={parsedConfig.rads_title ?? ""}
                                    placeholder="TGuard 入群验证卡"
                                    className={inputClass}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <label className={labelClass} htmlFor={`issue-price-${String(method.id)}`}>
                                    交易金额
                                  </label>
                                  <input
                                    id={`issue-price-${String(method.id)}`}
                                    name="price"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    defaultValue={parsedConfig.rads_price ?? 0}
                                    className={inputClass}
                                  />
                                </div>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                发卡接口：<span className="font-mono">{parsedConfig.rads_base_url}/api/issue</span>
                                ，资源 ID：<span className="font-mono">{parsedConfig.rads_script_id ?? "-"}</span>
                                ，可用次数：<span className="font-mono">{parsedConfig.rads_max_uses ?? 3}</span>。
                              </p>
                            </FormDialog>
                          ) : null}
                          <form action={deleteMethodAction}>
                            <input type="hidden" name="id" value={String(method.id)} />
                            <button
                              type="submit"
                              className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                            >
                              删除
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
