"use client";

import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";
import { inputClass, labelClass } from "@/components/admin/form-styles";

/**
 * 解锁门禁配置面板（v2.2.5 通用组件）：
 *
 * 「菜单和键盘」统一弹窗（TGAPI申请页 + 机器人管理页）共用的门禁配置模块 ——
 * unlock_mode / verification_method_id / stars_amount / stars_title 经 hidden 语义
 * 表单字段随宿主表单提交（键盘页签由 saveTgApiCustomKeyboardAction 兼收，
 * 内嵌页签由 saveTgApiBotAction 收取；校验规则在两个保存动作中同一实现）。
 *
 * idScope 用于表单控件 id 去重（同一页面可能同时渲染多处面板）。
 */
export function TgApiGatePanel({
  idScope,
  methods,
  unlockMode,
  verificationMethodId,
  starsAmount,
  starsTitle,
}: {
  /** 表单控件 id 前缀（多面板同页时不冲突） */
  idScope: string;
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  /** 当前解锁方式（captcha / stars） */
  unlockMode: "captcha" | "stars";
  /** 当前绑定的验证方式 id（captcha 模式） */
  verificationMethodId?: number;
  /** 星星解锁金额（stars 模式） */
  starsAmount?: number;
  /** 星星发票标题（stars 模式） */
  starsTitle?: string;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <p className="text-sm font-semibold">🔐 解锁门禁配置（解锁方式与验证方式绑定）</p>
      <p className="text-xs text-muted-foreground">
        门禁开启规则（v2.2.7）：完成下方配置即开启 —— 自定义键盘模式下，未验证用户
        /start 后先收到门禁消息（文案在「消息配置」里可配置）+「授权认证」内嵌按钮，
        点击按钮输入解锁验证码（或直接发送验证码文本），真实核验通过后才调起自定义键盘；
        消息内嵌按钮模式下由各按钮的「首次对话解锁门禁」开关触发。解锁一次永久有效；
        门禁真实调用外部验证 API 核验，验证不通过绝不放行；不配置 = 不开启门禁。
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`unlock-mode-${idScope}`}>
            解锁方式
          </label>
          <select
            id={`unlock-mode-${idScope}`}
            name="unlock_mode"
            defaultValue={unlockMode}
            className={inputClass}
          >
            <option value="captcha">验证码解锁（外部 API 核验，同加群验证）</option>
            <option value="stars">星星解锁（Telegram Stars 支付）</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`stars-${idScope}`}>
            星星解锁金额（⭐，星星解锁模式使用）
          </label>
          <input
            id={`stars-${idScope}`}
            name="stars_amount"
            type="number"
            min="1"
            step="1"
            defaultValue={starsAmount ?? 100}
            className={inputClass}
          />
        </div>
      </div>
      <TgApiUnlockMethodBinding
        initialMethods={methods}
        initialMethodId={verificationMethodId ?? null}
      />
      <div className="space-y-1">
        <label className={labelClass} htmlFor={`stars-title-${idScope}`}>
          发票标题（星星解锁模式使用）
        </label>
        <input
          id={`stars-title-${idScope}`}
          name="stars_title"
          defaultValue={starsTitle ?? "TGAPI 解锁"}
          className={inputClass}
        />
      </div>
    </div>
  );
}
