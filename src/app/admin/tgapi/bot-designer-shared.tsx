"use client";

import {
  TGAPI_DEFAULT_APP,
  type TgApiBotConfig,
} from "@/services/tgapi-config";
import { parseCustomKeyboardConfig } from "@/services/custom-keyboard";

/**
 * 机器人设计器弹窗共享层（v2.3 重构：机器人管理「功能配置」与 TGAPI申请「菜单和键盘」
 * 两个弹窗共用的解析工具与基础模块）—— 弹窗本体各自独立，杜绝 variant 条件分支交织。
 */

export function designerInputClass(): string {
  return "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
}

export interface DesignerBotInfo {
  id: string;
  name: string;
  username: string | null;
  enabled: boolean;
  config: string;
  menuConfig: string;
}

/** 解析 bots.config 的 tgapi 段（弹窗草稿初始值；v2.3 星星已移除，门禁固定验证码解锁） */
export function parseDesignerTgApiCfg(bot?: DesignerBotInfo): TgApiBotConfig {
  if (!bot) return { enabled: false, unlockMode: "captcha" as const, ...TGAPI_DEFAULT_APP };
  try {
    const parsed = JSON.parse(bot.config) as { tgapi?: unknown };
    const tgapi = (parsed.tgapi ?? {}) as Record<string, unknown>;
    return {
      enabled: tgapi.enabled === true,
      unlockMode: "captcha" as const,
      verificationMethodId:
        typeof tgapi.verificationMethodId === "number" ? tgapi.verificationMethodId : undefined,
      starsAmount: undefined,
      starsTitle: undefined,
      appTitle:
        typeof tgapi.appTitle === "string" && tgapi.appTitle
          ? tgapi.appTitle
          : TGAPI_DEFAULT_APP.appTitle,
      appShortName:
        typeof tgapi.appShortName === "string" && tgapi.appShortName
          ? tgapi.appShortName
          : TGAPI_DEFAULT_APP.appShortName,
      appUrl:
        typeof tgapi.appUrl === "string" && tgapi.appUrl ? tgapi.appUrl : TGAPI_DEFAULT_APP.appUrl,
      appPlatforms: Array.isArray(tgapi.appPlatforms)
        ? (tgapi.appPlatforms as string[])
        : [...TGAPI_DEFAULT_APP.appPlatforms],
      appDescription:
        typeof tgapi.appDescription === "string" && tgapi.appDescription
          ? tgapi.appDescription
          : TGAPI_DEFAULT_APP.appDescription,
      footerText:
        typeof tgapi.footerText === "string" ? tgapi.footerText : TGAPI_DEFAULT_APP.footerText,
      texts:
        typeof tgapi.texts === "object" && tgapi.texts !== null
          ? (tgapi.texts as TgApiBotConfig["texts"])
          : undefined,
      customKeyboard: parseCustomKeyboardConfig(tgapi.customKeyboard) ?? undefined,
      interfaceMode:
        tgapi.interfaceMode === "inline" || tgapi.interfaceMode === "keyboard"
          ? tgapi.interfaceMode
          : undefined,
    } satisfies TgApiBotConfig;
  } catch {
    return { enabled: false, unlockMode: "captcha" as const, ...TGAPI_DEFAULT_APP };
  }
}

export interface DesignerProfile {
  privacyMode: boolean;
  commandIds: number[];
}

/** 解析 bots.config 的隐私模式 + 指令勾选（与 saveBotCommandMenuAction 同存储位） */
export function parseDesignerProfile(bot?: DesignerBotInfo): DesignerProfile {
  if (!bot) return { privacyMode: true, commandIds: [] };
  try {
    const parsed = JSON.parse(bot.config) as { privacyMode?: unknown; commandIds?: unknown };
    return {
      // 未设置 = 开启（parseBotPrivacyMode 同语义）
      privacyMode: parsed.privacyMode !== false,
      commandIds: Array.isArray(parsed.commandIds)
        ? parsed.commandIds.map(Number).filter((item) => Number.isInteger(item) && item > 0)
        : [],
    };
  } catch {
    return { privacyMode: true, commandIds: [] };
  }
}

/** 1️⃣ 基本信息（名称 / Token / 启用）：两个弹窗共写同一表单字段 */
export function DesignerBasicInfo({
  bot,
  suffix,
  defaultName,
}: {
  bot?: DesignerBotInfo;
  suffix: string;
  defaultName: string;
}) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      <p className="text-sm font-semibold">1️⃣ 基本信息</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor={`name-${suffix}`}>
            名称 *
          </label>
          <input
            id={`name-${suffix}`}
            name="name"
            required
            defaultValue={bot?.name ?? defaultName}
            placeholder={defaultName}
            className={designerInputClass()}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor={`token-${suffix}`}>
            Bot Token {bot ? "（留空保留原值）" : "*"}
          </label>
          <input
            id={`token-${suffix}`}
            name="token"
            defaultValue=""
            placeholder={bot ? "留空保留原 Token" : "从 @BotFather 获取：123456:AA..."}
            className={designerInputClass()}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={`enabled-${suffix}`}
          name="enabled"
          type="checkbox"
          value="1"
          defaultChecked={bot ? bot.enabled : true}
          className="h-4 w-4"
        />
        <label className="text-sm font-medium" htmlFor={`enabled-${suffix}`}>
          启用机器人
        </label>
      </div>
    </div>
  );
}
