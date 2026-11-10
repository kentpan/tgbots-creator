"use client";

import { useFormStatus } from "react-dom";

/**
 * 管理后台表单提交按钮（v2.2.5 全站通用）：
 *
 * - loading 态：useFormStatus 观察最近的祖先 <form>，server action 提交期间
 *   自动切换为「旋转动画 + 处理中文案」并禁用（防重复提交）；
 * - confirm 确认：传入 confirmMessage 时点击先弹确认框（window.confirm），
 *   取消则阻止表单提交 —— 全站删除按钮的确认入口。
 *
 * 用法：<form action={serverAction}><SubmitButton confirmMessage="…">删除</SubmitButton></form>
 * 按钮既可直接置于 server component 的 form 内（client 子组件），也可用于 client 弹窗。
 */
export function SubmitButton({
  children,
  className = "",
  confirmMessage,
  pendingLabel = "处理中…",
  title,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  /** 非空时点击先确认（取消 = 阻止提交）；删除等破坏性操作必须提供 */
  confirmMessage?: string;
  /** 提交期间的按钮文案（默认「处理中…」；保存类可传「保存中…」） */
  pendingLabel?: string;
  title?: string;
  disabled?: boolean;
  /** 额外点击回调（confirm 通过后执行；不影响默认提交行为） */
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`${className} ${pending || disabled ? "cursor-not-allowed opacity-70" : ""}`}
      title={title}
      disabled={pending || disabled}
      onClick={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {pendingLabel}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
