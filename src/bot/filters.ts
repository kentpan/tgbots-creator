import type { Context } from "grammy";
import { config } from "@/config/settings";

export function isAdmin(userId: number | undefined): boolean {
  if (userId === undefined) {
    return false;
  }
  return config.bot.adminIds.includes(userId);
}

export async function adminOnly(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (!ctx.from) {
    return;
  }
  if (isAdmin(ctx.from.id)) {
    await next();
  }
}
