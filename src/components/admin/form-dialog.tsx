"use client";

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function FormDialog({
  trigger,
  triggerClassName,
  title,
  description,
  action,
  submitLabel = "保存",
  children,
  contentClassName,
  footerExtra,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  title: string;
  description?: string;
  action: (formData: FormData) => Promise<void>;
  submitLabel?: string;
  children: ReactNode;
  contentClassName?: string;
  footerExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent
        className={`flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-xl ${contentClassName ?? ""}`}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
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
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-6 py-4">
            {children}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
            {footerExtra}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {pending ? "提交中…" : submitLabel}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
