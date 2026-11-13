"use client";

import { useState } from "react";
import { ConfigPresetButtons } from "@/components/admin/config-presets";
import { inputClass, labelClass } from "@/components/admin/form-styles";

/**
 * 验证方式表单字段（client）：type 切换 code_api（外部 API JSON）/ code_self / captcha（内置方式），
 * 两种类型共用「通用参数」区（验证超时/最大尝试次数/三段文案）——
 * 这些默认值只允许在验证方式页修改；机器人在功能配置弹窗中只能做 per-bot 覆盖，绝不回写这里。
 */

export const GENERIC_PRESET = JSON.stringify(
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

export const RADS_PRESET = JSON.stringify(
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

const PARAM_FIELDS = [
  { key: "timeout_seconds", label: "验证超时（秒）", type: "number", min: 1, placeholder: "300" },
  { key: "max_attempts", label: "最大尝试次数", type: "number", min: 1, placeholder: "3" },
] as const;

const TEXT_PARAM_FIELDS = [
  { key: "prompt_text", label: "提示文案默认值", placeholder: "🔐 请完成验证后加入" },
  { key: "success_text", label: "成功文案默认值", placeholder: "✅ 验证成功，欢迎加入！" },
  { key: "failure_text", label: "失败文案默认值", placeholder: "❌ 验证失败，请重试。" },
] as const;

export interface MethodFormDefaults {
  name: string;
  type: string;
  config: string;
  enabled: boolean;
  /** 已保存方式解析出的通用参数回显（空对象 = 新建） */
  params: {
    timeout_seconds?: number;
    max_attempts?: number;
    prompt_text?: string;
    success_text?: string;
    failure_text?: string;
  };
}

export function MethodFormFields({
  defaults,
  fieldId,
  methodId,
}: {
  defaults: MethodFormDefaults;
  fieldId: string;
  /** 编辑时的方式 id（新建传 null） */
  methodId: string | null;
}) {
  const [type, setType] = useState<"code_api" | "code_self" | "captcha">(
    "code_api",
  );

  return (
    <>
      <input type="hidden" name="id" value={methodId ?? ""} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`name-${fieldId}`}>
            方法名称 *
          </label>
          <input
            id={`name-${fieldId}`}
            name="name"
            required
            defaultValue={defaults.name}
            placeholder="例如：外部会员系统核验"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`type-${fieldId}`}>
            方式类型 *
          </label>
          <select
            id={`type-${fieldId}`}
            name="type"
            value={type}
            onChange={(event) => {
              const value = event.target.value;
              setType(value === "code_self" || value === "captcha" ? value : "code_api");
            }}
            className={inputClass}
          >
            <option value="code_api">验证码核验 API（外部接口核验验证码/卡密）</option>
            <option value="code_self">自动验证码（机器人发码，用户回输入群）</option>
            <option value="captcha">人机验证（WebApp 验证网页）</option>
          </select>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`enabled-${fieldId}`}
          name="enabled"
          type="checkbox"
          value="1"
          defaultChecked={defaults.enabled}
          className="h-4 w-4"
        />
        <label className={labelClass} htmlFor={`enabled-${fieldId}`}>
          启用该方法
        </label>
      </div>

      {type === "code_self" || type === "captcha" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {type === "code_self" ? "自动验证码方式" : "人机验证（WebApp）方式"}
          </p>
          <p className="text-sm text-muted-foreground">
            {type === "code_self"
              ? "机器人自动生成一次性验证码并私聊发给用户，用户回复输入后本地比对：通过自动批准入群，失败 3 次拒绝。"
              : "机器人私聊发送验证网页按钮，用户在网页完成人机验证后自动批准入群（需要配置 Webhook Base URL）。"}
            本类型无外部参数，仅需在下方配置通用参数（超时/尝试次数/文案默认值）。
          </p>
        </div>
      ) : null}

      {type === "code_api" ? (
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
            defaultValue={defaults.type === "code_api" && defaults.config ? defaults.config : GENERIC_PRESET}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          />
          <p className="text-sm text-muted-foreground">
            请求自动携带 <span className="font-mono">Authorization: Bearer api_key</span>；
            <span className="font-mono">{"{{user_id}} {{code}} {{username}}"}</span> 会被替换为实际值；
            判定规则：HTTP 状态等于 success_status 且响应 JSON 中 success_field 等于 success_value。
          </p>
        </div>
      ) : null}

      {/* 通用参数（两种方式共用）：默认值源头 */}
      <div className="space-y-2 rounded-md border border-dashed p-3">
        <p className="text-sm font-medium">通用参数（该方式的默认值）</p>
        <div className="grid gap-4 md:grid-cols-2">
          {PARAM_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className={labelClass} htmlFor={`${field.key}-${fieldId}`}>
                {field.label}
              </label>
              <input
                id={`${field.key}-${fieldId}`}
                name={field.key}
                type={field.type}
                min={field.min}
                defaultValue={defaults.params[field.key as keyof typeof defaults.params] ?? ""}
                placeholder={field.placeholder}
                className={inputClass}
              />
            </div>
          ))}
        </div>
        {TEXT_PARAM_FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <label className={labelClass} htmlFor={`${field.key}-${fieldId}`}>
              {field.label}
            </label>
            <textarea
              id={`${field.key}-${fieldId}`}
              name={field.key}
              rows={2}
              defaultValue={defaults.params[field.key as keyof typeof defaults.params] ?? ""}
              placeholder={field.placeholder}
              className={inputClass}
            />
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          这里是这些参数的唯一默认值源头；机器人功能配置弹窗中可按机器人临时覆盖，覆盖不会回写到这里。
        </p>
      </div>
    </>
  );
}
