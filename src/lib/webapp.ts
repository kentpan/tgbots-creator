"use client";

export function getTg(): TelegramWebApp | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.Telegram?.WebApp ?? null;
}

export function initTelegramWebApp(): void {
  const tg = getTg();
  if (!tg) {
    return;
  }

  tg.ready();
  tg.expand();
  tg.setHeaderColor("secondary_bg_color");
  tg.disableClosingConfirmation();
}

export function hapticSuccess(): void {
  const tg = getTg();
  if (tg?.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred("success");
  }
}

export function hapticError(): void {
  const tg = getTg();
  if (tg?.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred("error");
  }
}

export function closeWebApp(): void {
  getTg()?.close();
}
