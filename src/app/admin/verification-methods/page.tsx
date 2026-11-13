import { listVerificationMethods, type VerificationMethodRow } from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import { parseCodeApiConfig } from "@/services/external-verify";
import {
  parseMethodConfigByType,
  parseVerificationParams,
  verificationMethodTypeLabel,
} from "@/services/verification-methods";
import { hasRadsIssueConfig } from "@/services/rads-issue";
import { CopyField } from "@/components/admin/copy-field";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import {
  deleteMethodAction,
  issueCardAction,
  saveMethodAction,
  testMethodAction,
} from "./actions";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { MethodFormFields } from "@/components/admin/verification-method-form-fields";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "验证方式已保存",
  deleted: "验证方式已删除",
};

const ERRORS: Record<string, string> = {
  "name-required": "请填写方法名称",
  "invalid-config": "配置 JSON 不合法：需要 url 与 api_key 字段",
  "invalid-type": "方式类型不合法",
  "invalid-id": "验证方法不存在",
  "code-required": "请输入测试验证码",
  "invalid-price": "交易金额必须是大于等于 0 的数字",
};

// v2.0.13：时间展示统一北京时间（服务器/Edge 运行时时区为 UTC）
function formatDateTime(date: Date): string {
  return formatBeijingDateTimeMinute(date);
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
  const parsed = method
    ? parseMethodConfigByType(method.type, method.config)
    : null;
  const defaults = {
    name: method?.name ?? "",
    type: method?.type ?? "code_api",
    config: method?.config ?? "",
    enabled: method ? method.enabled : true,
    params: method ? parseVerificationParams(method.config) : {},
  };
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={method ? `编辑验证方式 · ${method.name}` : "新增验证方式"}
      description="验证方式是全站唯一的方式定义源：加群验证与门禁解锁都从这里选择方式；默认参数只在这里改，机器人在功能配置弹窗中只能按机器人临时覆盖。"
      action={saveMethodAction}
      submitLabel="保存方法"
    >
      <MethodFormFields defaults={defaults} fieldId={fieldId} methodId={method ? String(method.id) : null} />
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
            全站唯一的方式定义源：加群验证与门禁解锁都在这里选择方式。
            「验证码核验 API」= 用户输入验证码后，Bot 用 <span className="font-mono">Authorization: Bearer &lt;apikey&gt;</span> 请求外部接口核验；
            「自动验证码」= 机器人发码用户回输；「人机验证」= WebApp 验证网页。默认参数只在这里改；
            机器人在功能配置弹窗中只能按机器人临时覆盖，覆盖不会回写到这里。
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
                  const parsedByType = parseMethodConfigByType(method.type, method.config);
                  // 摘要列：code_api 显示接口地址；内置方式显示固定说明
                  let summary = "-";
                  let apiUrl = "-";
                  if (parsedByType?.kind === "code_api") {
                    apiUrl = parsedByType.config.url;
                    summary = apiUrl;
                  } else if (parsedByType?.kind === "code_self") {
                    summary = "自动验证码（输入验证码加群）";
                  } else if (parsedByType?.kind === "captcha") {
                    summary = "人机验证（WebApp）";
                  }
                  const parsedConfig = parseCodeApiConfig(method.config);
                  const canIssue = parsedConfig ? hasRadsIssueConfig(parsedConfig) : false;
                  const isCodeApi = method.type === "code_api";
                  return (
                    <tr key={String(method.id)} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{String(method.id)}</td>
                      <td className="px-4 py-3 text-sm">{method.name}</td>
                      <td className="px-4 py-3 text-sm">{verificationMethodTypeLabel(method.type)}</td>
                      <td className="max-w-60 truncate px-4 py-3 font-mono text-sm" title={summary}>
                        {summary}
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
                          {isCodeApi ? (
                            <>
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
                            </>
                          ) : null}
                          <ConfirmDialog
                            title={`删除验证方式「${method.name}」`}
                            description={`确定要删除验证方式「${method.name}」吗？绑定该方式的机器人将无法通过门禁核验，删除后不可恢复！`}
                            action={deleteMethodAction}
                            fields={{ id: String(method.id) }}
                            trigger="删除"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                          />
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
