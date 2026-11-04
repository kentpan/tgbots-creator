import type { Context, SessionFlavor } from "grammy";
import type { Menu } from "@grammyjs/menu";
import type { BotSessionData } from "./session-storage";

/**
 * 管理后台机器人的统一上下文：含 grammY session（支持外部存储：SQLite/D1/R2）。
 *
 * botMenu：当前机器人实例自己安装的根菜单（@grammyjs/menu 官方约束：Menu 实例只能
 * 发送到安装了它的 bot 上 —— src/bot/menus.ts 的全局 mainMenu 仅装在主 bot，
 * 菜单 bot（bots 表实例）发送它会抛 "Cannot send menu"。multi-runtime 的
 * createMenuBot 通过中间件把实例菜单写入 ctx.botMenu，cmdStart/cmdMenu 优先使用）。
 */
export type BotContext = Context & SessionFlavor<BotSessionData> & { botMenu?: Menu<Context> };
