"use client";

import { TgApiUnlockMethodBinding } from "@/components/admin/tgapi-unlock-api-config";

/**
 * 解锁门禁配置面板（v2.2.5 通用组件；v2.3 移除星星解锁 —— 门禁仅验证码方式）：
 *
 * 「菜单和键盘 / 功能配置」统一弹窗（TGAPI申请页 + 机器人管理页）共用的门禁配置模块 ——
 * unlock_mode（恒为 captcha）/ verification_method_id 经 hidden 语义表单字段随宿主表单提交
 * （校验规则在两个保存动作中同一实现：绑定验证方式必填）。
 *
 * idScope 用于表单控件 id 去重（同一页面可能同时渲染多处面板）。
 */
export function TgApiGatePanel({
  idScope,
  methods,
  verificationMethodId,
}: {
  /** 表单控件 id 前缀（多面板同页时不冲突） */
  idScope: string;
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  /** 当前绑定的验证方式 id */
  verificationMethodId?: number;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <p className="text-sm font-semibold">🔐 解锁门禁配置（解锁方式与验证方式绑定）</p>
      <p className="text-xs text-muted-foreground">
        门禁开启规则：完成下方配置（绑定验证方式）即开启 —— 自定义键盘模式下，未验证用户
        /start 后先收到门禁消息（文案在「消息配置」里可配置）+「授权认证」内嵌按钮，
        点击按钮输入解锁验证码（或直接发送验证码文本），真实核验通过后才调起自定义键盘；
        消息内嵌按钮模式下由各按钮的「首次对话解锁门禁」开关触发。解锁一次永久有效；
        门禁真实调用外部验证 API 核验，验证不通过绝不放行；不配置 = 不开启门禁。
      </p>
      {/* 门禁固定验证码解锁（v2.3 移除星星解锁；hidden 字段保持宿主保存动作兼容） */}
      <input type="hidden" name="unlock_mode" value="captcha" />
      <TgApiUnlockMethodBinding
        initialMethods={methods}
        initialMethodId={verificationMethodId ?? null}
      />
    </div>
  );
}
