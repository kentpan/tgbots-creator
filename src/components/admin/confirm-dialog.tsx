"use client";

import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * confirm 通用组件：所有删除等破坏性操作必须经过它二次确认。
 * - 传入 action（server action）+ fields：确认后以表单提交到服务端。
 * - 传入 onConfirm：确认后执行客户端回调（可异步）。
 */
export function ConfirmDialog({
  trigger,
  triggerClassName,
  title,
  description,
  confirmLabel = "确认删除",
  cancelLabel = "取消",
  action,
  fields,
  onConfirm,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  action?: (formData: FormData) => Promise<void>;
  fields?: Record<string, string>;
  onConfirm?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    if (onConfirm) {
      setPending(true);
      try {
        await onConfirm();
      } finally {
        setPending(false);
        setOpen(false);
      }
    }
  };

  const confirmButton = onConfirm ? (
    <button
      type="button"
      disabled={pending}
      onClick={() => void handleConfirm()}
      className="inline-flex h-10 items-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
    >
      {pending ? "处理中…" : confirmLabel}
    </button>
  ) : (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
    >
      {pending ? "处理中…" : confirmLabel}
    </button>
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          {action ? (
            <form
              action={async (formData: FormData) => {
                setPending(true);
                try {
                  await action(formData);
                  setOpen(false);
                } finally {
                  setPending(false);
                }
              }}
              className="contents"
            >
              {Object.entries(fields ?? {}).map(([key, value]) => (
                <input key={key} type="hidden" name={key} value={value} />
              ))}
              {confirmButton}
            </form>
          ) : (
            confirmButton
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
