/**
 * 机器人功能配置统一解析（bots.config JSON 唯一读取口）：
 *
 * 功能配置弹窗中「内嵌按钮 / 指令菜单 / 自定义键盘 / 门禁 / 加群验证」都是带开关的面板，
 * 开关 ON = 生效，OFF = 不生效但配置保留；本模块是运行时与管理端共用的唯一解析口，
 * 任何地方不得再自行 JSON.parse bots.config 读取这些字段。
 *
 * 面板开关解析规则（显式值 > 数据推断）：
 *   显式 boolean 存在时以它为准；
 *   旧数据无显式值 → 按既有数据推断（有菜单配置/勾选指令/键盘配置 = 开），保证升级不静默改变行为；
 *   全新机器人无任何数据 = 全部关闭（加群验证机器人可只开加群验证面板）。
 */

import type { VerificationParams } from "@/services/verification-methods";
import { parseVerificationOverride } from "@/services/verification-methods";

/** 门禁解锁：一个已启用验证方式的引用（复选、按数组顺序尝试） */
export interface GateItemConfig {
  /** verification_methods.id（十进制字符串） */
  methodId: string;
  /** bot 级参数覆盖（不回写验证方式库） */
  override?: VerificationParams;
}

/** 门禁解锁面板（会话级解锁，全局共享解锁状态）：绑定验证方式（v2.3 星星解锁已移除，固定验证码解锁） */
export interface GateFeatureConfig {
  enabled: boolean;
  /** 绑定的验证方式 id（verification_methods，十进制字符串；null = 未绑定 = 门禁不可用） */
  verificationMethodId: string | null;
}

/** 加群验证面板（自动响应加群申请：方式单选 + 参数覆盖 + 文案默认值） */
export interface JoinVerifyFeatureConfig {
  enabled: boolean;
  /** verify=按绑定方式验证；direct=收到申请后直接审批/直连入群不验证 */
  mode: "verify" | "direct";
  /** verification_methods.id（十进制字符串；未选择 = 配置不完整，运行时显式报「未配置验证方式」） */
  methodId: string | null;
  override?: VerificationParams;
}

export interface BotFeatureConfig {
  /** 内嵌按钮面板（menu_config 是否生效） */
  menu: { enabled: boolean };
  /** v2.3 内嵌按钮面板门禁解锁开关（面板内全部按钮点击先验证） */
  gateMenuRequired: boolean;
  /** v2.3 自定义键盘面板门禁解锁开关 */
  gateKeyboardRequired: boolean;
  /** v2.3 指令菜单面板门禁解锁开关 */
  gateCommandsRequired: boolean;
  /** 指令菜单面板（config.commandIds 是否生效） */
  commands: { enabled: boolean; commandIds: number[] };
  /** 自定义键盘面板（config.customKeyboard 是否生效） */
  keyboard: { enabled: boolean };
  /** 界面模式（内嵌 ⇄ 键盘互斥）：undefined = 旧数据按键盘有无推断（与 TGAPI 同规则） */
  interfaceMode: "inline" | "keyboard" | undefined;
  /** 门禁解锁面板 */
  gate: GateFeatureConfig;
  /** 加群验证面板 */
  joinVerify: JoinVerifyFeatureConfig;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseGate(raw: unknown, hasData: boolean): GateFeatureConfig {
  const cfg = asRecord(raw);
  const methodId =
    typeof cfg.verificationMethodId === "string" && /^\d+$/.test(cfg.verificationMethodId)
      ? cfg.verificationMethodId
      : null;
  // 兼容读取旧 items 形态的首个方式（迁移读取：不写回，保存后统一为新形状）
  let legacyMethodId: string | null = null;
  if (!methodId && Array.isArray(cfg.items) && cfg.items.length > 0) {
    const first = asRecord(cfg.items[0]);
    if (typeof first.methodId === "string" && /^\d+$/.test(first.methodId)) {
      legacyMethodId = first.methodId;
    }
  }
  return {
    enabled: parseBoolean(cfg.enabled) ?? Boolean(methodId ?? legacyMethodId),
    verificationMethodId: methodId ?? legacyMethodId,
  };
}

function parseJoinVerify(raw: unknown, hasData: boolean): JoinVerifyFeatureConfig {
  const cfg = asRecord(raw);
  const methodIdRaw = typeof cfg.methodId === "string" && /^\d+$/.test(cfg.methodId) ? cfg.methodId : null;
  return {
    enabled: parseBoolean(cfg.enabled) ?? hasData,
    mode: cfg.mode === "direct" ? "direct" : "verify",
    methodId: methodIdRaw,
    override: parseVerificationOverride(cfg.override),
  };
}

function parseCommandIds(raw: unknown): number[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

/**
 * 解析 bots.config → 功能配置。
 * @param configRaw bots.config 原始 JSON 字符串
 * @param hasMenuConfig menu_config 是否有内容（用于旧数据推断面板初始状态）
 */
export function parseBotFeatureConfig(configRaw: string, hasMenuConfig: boolean): BotFeatureConfig {
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(configRaw || "{}");
    root = asRecord(parsed);
  } catch {
    root = {};
  }

  const commandIds = parseCommandIds(root.commandIds);
  const customKeyboardRaw = asRecord(root.customKeyboard);
  // TGAPI 机器人历史版本把键盘保存在 bots.config.tgapi.customKeyboard；
  // 通用机器人则保存在顶层 customKeyboard。缺少显式 keyboardEnabled 的旧数据
  // 必须兼容两种存储位置，否则升级后 TGAPI 自定义键盘会被误判为关闭。
  const tgapiRaw = asRecord(root.tgapi);
  const tgapiKeyboardRaw = asRecord(tgapiRaw.customKeyboard);
  const keyboardHasData =
    Object.keys(customKeyboardRaw).length > 0 || Object.keys(tgapiKeyboardRaw).length > 0;
  const interfaceModeRaw = root.interfaceMode;

  return {
    menu: { enabled: parseBoolean(root.menuEnabled) ?? hasMenuConfig },
    gateMenuRequired: root.gateMenuRequired === true,
    gateKeyboardRequired: root.gateKeyboardRequired === true,
    gateCommandsRequired: root.gateCommandsRequired === true,
    commands: {
      enabled: parseBoolean(root.commandsEnabled) ?? commandIds.length > 0,
      commandIds,
    },
    keyboard: { enabled: parseBoolean(root.keyboardEnabled) ?? keyboardHasData },
    interfaceMode:
      interfaceModeRaw === "inline" || interfaceModeRaw === "keyboard" ? interfaceModeRaw : undefined,
    gate: parseGate(root.gate, false),
    joinVerify: parseJoinVerify(root.joinVerify, false),
  };
}

/** 界面模式生效判定（与 tgApiInterfaceMode 同规则的通用机器人版本）：显式值 > 键盘有无推断 */
export function resolveInterfaceMode(feature: Pick<BotFeatureConfig, "interfaceMode" | "keyboard">): "inline" | "keyboard" {
  if (feature.interfaceMode === "inline" || feature.interfaceMode === "keyboard") {
    return feature.interfaceMode;
  }
  return feature.keyboard.enabled ? "keyboard" : "inline";
}
