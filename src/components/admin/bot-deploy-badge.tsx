import type { BotDeployCheck } from "@/services/bot-deploy";

/**
 * 机器人真实部署状态徽章（v2.1.10 整合）：
 * 机器人管理页列表与 TGAPI 申请页列表共用同一展示（一个实现，两处入口）。
 * 详情悬浮展示完整原因，绝不截断成模糊的“异常”。
 */
const BADGE_STYLES: Record<BotDeployCheck["key"], string> = {
  deployed: "border-green-200 bg-green-50 text-green-700",
  undeployed: "border-red-200 bg-red-50 text-red-700",
  mismatch: "border-amber-200 bg-amber-50 text-amber-700",
  deploying: "border-amber-200 bg-amber-50 text-amber-700",
  "delivery-error": "border-red-200 bg-red-50 text-red-700",
  unknown: "border-amber-200 bg-amber-50 text-amber-700",
  disabled: "border-gray-200 bg-gray-50 text-gray-500",
};

const BADGE_LABELS: Record<BotDeployCheck["key"], string> = {
  deployed: "已部署",
  undeployed: "未部署",
  mismatch: "Webhook 指向异常",
  deploying: "启动确认中",
  "delivery-error": "投递异常",
  unknown: "状态未知",
  disabled: "已停用",
};

export function BotDeployBadge({ check }: { check: BotDeployCheck }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${BADGE_STYLES[check.key]}`}
      title={"detail" in check ? check.detail : undefined}
    >
      {BADGE_LABELS[check.key]}
    </span>
  );
}

/** 页面展示用详情截断（完整原因放 title 悬浮，列表不撑破版式） */
export function briefDeployDetail(detail: string): string {
  return detail.length > 120 ? `${detail.slice(0, 120)}…` : detail;
}
