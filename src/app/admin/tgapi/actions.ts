"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  deleteBotRecord,
  deleteTgApiUnlock,
  getBot,
  listVerificationMethods,
  updateBotRecord,
  createBotRecord,
} from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import { parseBotProfile, restartMenuBot, stopMenuBot } from "@/bot/multi-runtime";
import { deployBotAndReport } from "@/services/bot-deploy";
import { parseBotMenuConfig } from "@/services/menu-config";
import {
  TGAPI_APP_PLATFORMS,
  TGAPI_TEXT_FIELD_KEYS,
  TGAPI_TEXTS_EN,
  TGAPI_TEXTS_ZH,
  type TgApiBotConfig,
  type TgApiBotTexts,
  type TgApiUnlockMode,
} from "@/services/tgapi-config";
import { parseCustomKeyboardConfig } from "@/services/custom-keyboard";
import { tgApiInterfaceMode } from "@/services/tgapi-config";

function tgapiPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/tgapi?${query}` : "/admin/tgapi";
}

/**
 * v2.1.10 整合：部署/真实结果确认的唯一实现在 services/bot-deploy.ts
 *（deployBotAndReport）。v2.1.11：部署入口统一收敛到「仿真APP」页面 ——
 * 本文件不再保留独立部署动作（原 deployTgApiBotAction 已移除），
 * 启停开关保留（TGAPI 页「运行服务」职责：启用即上线/停用即下线）。
 */

function parsePlatforms(formData: FormData): string[] {
  const values = formData.getAll("app_platforms").map((item) => String(item));
  const valid = values.filter((value) =>
    (TGAPI_APP_PLATFORMS as readonly string[]).includes(value),
  );
  return [...new Set(valid)];
}

/**
 * 组装 tgapi 配置段（表单 → bots.config JSON 的 tgapi 字段）。
 * v2.1.7：文案覆盖按语言（text_zh_* / text_en_*）提交，留空 = 清除该条覆盖、
 * 使用内置双语文案；ask_app_details 开启时申请人可自定义 APP 名称/描述。
 * v2.2.6 解耦：interfaceMode（表单 kb_mode checkbox 单选）承载生效模式，
 * customKeyboard 仅是可附加属性（保存/切换/清空语义见 saveTgApiBotAction）。
 */
function buildTgApiConfig(formData: FormData, previousTgapi?: Record<string, unknown>): TgApiBotConfig {
  // v2.3 星星解锁已移除：门禁固定验证码解锁（绑定验证方式）
  const unlockMode: TgApiUnlockMode = "captcha";
  const methodRaw = String(formData.get("verification_method_id") ?? "").trim();
  if (!methodRaw || !/^\d+$/.test(methodRaw)) {
    redirect(tgapiPath({ error: "method-required" }));
  }

  // 按语言文案覆盖：表单字段 text_<lang>_<key>。v2.1.11 表单预填内置默认值，
  // 保存时与内置默认逐字相同的值不落库（等价于「使用内置文案」）—— 避免默认值
  // 被固化进 bots.config（v2.1.10 已专门迁移过此类固化垃圾数据）；
  // 管理员真正修改过的文案照常保存为覆盖。
  const buildLangTexts = (lang: "zh" | "en"): Partial<TgApiBotTexts> | undefined => {
    const builtin = lang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
    const collected: Partial<TgApiBotTexts> = {};
    for (const field of TGAPI_TEXT_FIELD_KEYS) {
      // 浏览器 textarea 会把换行规范为 \r\n，内置默认值使用 \n —— 比较与落库前统一归一化
      const value = String(formData.get(`text_${lang}_${field.name}`) ?? "")
        .replace(/\r\n/g, "\n")
        .trim();
      if (value && value !== builtin[field.name]) collected[field.name] = value;
    }
    return Object.keys(collected).length > 0 ? collected : undefined;
  };
  const zhTexts = buildLangTexts("zh");
  const enTexts = buildLangTexts("en");

  // v2.2.6 生效模式（checkbox 单选）：inline=消息内嵌按钮 / keyboard=自定义键盘。
  // 保存并部署后才对运行实例生效；缺省（未提交）时按旧数据推断（旧语义兼容）。
  const kbModeRaw = String(formData.get("kb_mode") ?? "").trim();
  const interfaceMode =
    kbModeRaw === "keyboard" || kbModeRaw === "inline"
      ? kbModeRaw
      : tgApiInterfaceMode({
          interfaceMode: undefined,
          customKeyboard: parseCustomKeyboardConfig(previousTgapi?.customKeyboard) ?? undefined,
        });

  return {
    enabled: true,
    interfaceMode,
    unlockMode,
    verificationMethodId: Number(methodRaw),
    // v2.1.10：默认值全部中性化，不再携带原项目作者推广链接/署名
    appTitle: String(formData.get("app_title") ?? "").trim() || "usetgapibot",
    appShortName: String(formData.get("app_short_name") ?? "").trim() || "usetgapibot",
    appUrl: String(formData.get("app_url") ?? "").trim() || "https://www.telegram.org",
    appPlatforms: parsePlatforms(formData),
    appDescription:
      String(formData.get("app_description") ?? "").trim() || "My Telegram App",
    // footer 留空 = 结果消息不附加任何署名
    footerText: String(formData.get("footer_text") ?? "").trim(),
    texts: {
      ...(zhTexts ? { zh: zhTexts } : {}),
      ...(enTexts ? { en: enTexts } : {}),
    },
  };
}

export async function saveTgApiBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("tgapi:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const enabled = formData.get("enabled") === "1";
  if (!name) redirect(tgapiPath({ error: "name-required" }));
  const isEdit = Boolean(idRaw && /^\d+$/.test(idRaw));
  if (token && !/^\d{6,}:[\w-]{30,}$/.test(token)) {
    redirect(tgapiPath({ error: "invalid-token" }));
  }
  if (!token && !isEdit) {
    redirect(tgapiPath({ error: "invalid-token" }));
  }

  const existing = isEdit ? await getBot(BigInt(idRaw)) : null;
  if (isEdit && !existing) redirect(tgapiPath({ error: "invalid-id" }));

  // 编辑时保留档案弹窗维护的其他字段（菜单/插件/AI 等），仅覆写 tgapi 段
  const profile = parseBotProfile(existing?.config ?? "{}");
  const previousTgapi = (profile.tgapi ?? {}) as Record<string, unknown>;
  profile.tgapi = buildTgApiConfig(formData, previousTgapi);

  // v2.2.6 自定义键盘可附加属性（统一表单 hidden 字段 custom_keyboard 随 kb_mode 提交）：
  // - 非空 = 解析并保存（或更新）tgapi.customKeyboard —— 勾选内嵌按钮模式时配置同样保留，
  //   仅生效模式切回 inline（不再像旧版那样整体覆盖 tgapi 段丢失键盘配置）；
  // - 空串 = 管理员显式清空键盘配置（原「保存空键盘回到内嵌按钮模式」语义）；
  // - 字段缺失 = 旧调用方/非统一表单，不触碰已有配置（与门禁字段同语义）。
  const nextTgapi = profile.tgapi as unknown as Record<string, unknown>;
  const keyboardRaw = String(formData.get("custom_keyboard") ?? "").trim();
  if (formData.has("custom_keyboard")) {
    if (keyboardRaw) {
      let source: unknown;
      try {
        source = JSON.parse(keyboardRaw);
      } catch {
        redirect(tgapiPath({ error: "invalid-keyboard" }));
      }
      const parsedKeyboard = parseCustomKeyboardConfig(source);
      if (!parsedKeyboard) redirect(tgapiPath({ error: "invalid-keyboard" }));
      nextTgapi.customKeyboard = parsedKeyboard;
    } else {
      delete nextTgapi.customKeyboard;
    }
  }

  // v2.2.8 指令菜单配置（统一弹窗「5️⃣ 指令菜单」模块随表单提交）：隐私模式 + 指令勾选，
  // 写入 bots.config.privacyMode / bots.config.commandIds —— 与机器人管理页
  // 「⌨️ 指令菜单」弹窗（saveBotCommandMenuAction）同一存储位；运行实例注册与
  // setMyCommands 在「仿真APP」部署时执行（registerBotCapabilities 读取同一字段）。
  // 字段缺失 = 不触碰（兼容旧调用方）；commandIds 非法 JSON 直接报错不静默。
  const privacyRaw = formData.get("privacyMode");
  if (privacyRaw !== null) {
    profile.privacyMode = privacyRaw === "1";
  }
  const commandIdsRaw = formData.get("commandIds");
  let savedCommandCount = 0;
  if (commandIdsRaw !== null) {
    let commandIds: number[] = [];
    try {
      const parsedIds = JSON.parse(String(commandIdsRaw)) as unknown;
      if (Array.isArray(parsedIds)) {
        commandIds = parsedIds
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0);
      }
    } catch {
      redirect(tgapiPath({ error: "invalid-commands" }));
    }
    profile.commandIds = commandIds;
    savedCommandCount = commandIds.length;
  }
  // v2.3 功能面板开关（🧩功能开关卡片随表单提交）：与 saveBotFeatureConfigAction
  // 同字段同存储位（bots.config 顶层）—— 部署后运行实例的面板门禁/界面开关据此生效。
  // 字段缺失 = 不触碰（兼容旧调用方）。
  const readFeatureFlag = (key: string): void => {
    const raw = formData.get(key);
    if (raw !== null) (profile as unknown as Record<string, unknown>)[key] = raw === "1";
  };
  readFeatureFlag("menu_enabled");
  readFeatureFlag("keyboard_enabled");
  readFeatureFlag("commands_enabled");
  readFeatureFlag("gate_menu_required");
  readFeatureFlag("gate_keyboard_required");
  readFeatureFlag("gate_commands_required");

  const configJson = JSON.stringify(profile);

  // v2.1.16：内嵌按钮配置随弹窗一并保存（bots.menu_config，含 tgapiDesigner 标记）——
  // 运行实例 /start 初始消息的按钮来自这份配置；轻校验只要求可解析（按钮数为空合法，
  // 运行时回落「🔐 授权认证」单按钮），不走 validateMenuConfig 的「至少一个按钮」门槛。
  const menuConfigRaw = String(formData.get("menu_config") ?? "").trim();
  let menuConfigJson: string | null = null;
  let menuTextValue: string | null = null;
  if (menuConfigRaw) {
    try {
      const parsed = parseBotMenuConfig(menuConfigRaw);
      menuConfigJson = JSON.stringify({
        tgapiDesigner: true,
        content: parsed.content,
        root: parsed.root,
      });
      menuTextValue = parsed.content.text;
    } catch {
      redirect(tgapiPath({ error: "invalid-menu" }));
    }
  }

  // v2.1.9 部署与保存分离：保存只落库，绝不自动触碰运行实例（更不会删了正在
  // 工作的 Webhook 再重注册）——上线/更新运行实例是列表「部署」按钮的显式动作。
  if (isEdit) {
    await updateBotRecord(BigInt(idRaw), {
      name,
      token: token || existing!.token,
      enabled,
      config: configJson,
      ...(menuConfigJson ? { menuConfig: menuConfigJson, menuText: menuTextValue ?? "" } : {}),
    });
    await logOperation(admin, {
      action: "保存TGAPI申请机器人",
      target: name,
      detail: `状态：${enabled ? "启用" : "停用"}（仅保存配置，未部署）；隐私模式：${formData.get("privacyMode") === "1" ? "开启" : "关闭"}；指令 ${savedCommandCount} 条`,
      headers: await headers(),
    });
    revalidatePath("/admin/tgapi");
    redirect(tgapiPath({ saved: "1" }));
  } else {
    const created = await createBotRecord({
      name,
      token,
      enabled,
      config: configJson,
      ...(menuConfigJson ? { menuConfig: menuConfigJson, menuText: menuTextValue ?? "" } : {}),
    });
    if (!created) redirect(tgapiPath({ error: "duplicate-token" }));
    await logOperation(admin, {
      action: "创建TGAPI申请机器人",
      target: name,
      detail: `Token 尾号：${token.slice(-6)}（仅保存配置，未部署）；指令 ${savedCommandCount} 条`,
      headers: await headers(),
    });
    revalidatePath("/admin/tgapi");
    redirect(tgapiPath({ saved: "1" }));
  }
}

/**
 * 保存 TGAPI 自定义键盘（v2.2.0；v2.2.2 起兼收门禁配置字段）：
 * 「自定义键盘」/「菜单和键盘」键盘页签提交 —— 写入 bots.config JSON tgapi 段：
 * - customKeyboard：非空 = 自定义键盘对话流程生效（互斥：消息内嵌按钮不再渲染）；
 *   空提交 = 清除配置，回到消息内嵌按钮模式；
 * - 解锁门禁配置（unlock_mode / verification_method_id）：
 *   键盘页签内嵌的门禁配置模块随表单提交（必须绑定验证方式，
 *   校验规则与机器人保存动作一致）；字段缺失 = 不修改。
 * 保存后热更新运行实例。
 */
export async function saveTgApiCustomKeyboardAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("tgapi:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const keyboardRaw = String(formData.get("custom_keyboard") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(tgapiPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(tgapiPath({ error: "invalid-id" }));

  const profile = parseBotProfile(bot.config);
  const tgapiSection = (profile.tgapi ?? {}) as Record<string, unknown>;
  if (keyboardRaw) {
    let source: unknown;
    try {
      source = JSON.parse(keyboardRaw);
    } catch {
      redirect(tgapiPath({ error: "invalid-keyboard" }));
    }
    const parsed = parseCustomKeyboardConfig(source);
    if (!parsed) redirect(tgapiPath({ error: "invalid-keyboard" }));
    tgapiSection.customKeyboard = parsed;
  } else {
    delete tgapiSection.customKeyboard;
  }

  // v2.2.2 门禁配置模块（键盘页签内嵌）：字段存在时才覆写（保留弹窗外维护的其他字段）。
  // v2.3 星星解锁已移除：门禁固定验证码解锁（绑定验证方式），保存时同时清除存量星星字段。
  const unlockModeRaw = formData.get("unlock_mode");
  if (typeof unlockModeRaw === "string" && unlockModeRaw.trim()) {
    const methodRaw = String(formData.get("verification_method_id") ?? "").trim();
    if (!methodRaw || !/^\d+$/.test(methodRaw)) {
      redirect(tgapiPath({ error: "method-required" }));
    }
    tgapiSection.unlockMode = "captcha";
    tgapiSection.verificationMethodId = Number(methodRaw);
    delete tgapiSection.starsAmount;
    delete tgapiSection.starsTitle;
  }

  profile.tgapi = tgapiSection as unknown as TgApiBotConfig;
  await updateBotRecord(bot.id, { config: JSON.stringify(profile) });
  if (bot.enabled) {
    void restartMenuBot(bot.id).catch((error: unknown) => {
      console.error(`[tgapi] 自定义键盘保存后重启运行实例失败（#id ${bot.id}）:`, error);
    });
  }
  await logOperation(admin, {
    action: keyboardRaw ? "保存TGAPI自定义键盘" : "清除TGAPI自定义键盘",
    target: bot.name,
    headers: await headers(),
  });
  revalidatePath("/admin/tgapi");
  redirect(tgapiPath({ saved: keyboardRaw ? "keyboard" : "1" }));
}

export async function toggleTgApiBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("tgapi:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const enable = formData.get("enable") === "1";
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(tgapiPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(tgapiPath({ error: "invalid-id" }));
  await updateBotRecord(BigInt(idRaw), { enabled: enable });
  const deploy = await deployBotAndReport(BigInt(idRaw), enable);
  await logOperation(admin, {
    action: enable ? "启用TGAPI申请机器人" : "停用TGAPI申请机器人",
    target: bot.name,
    detail: `部署结果：${deploy.message}`,
    headers: await headers(),
  });
  revalidatePath("/admin/tgapi");
  redirect(
    tgapiPath({
      saved: enable ? "enabled" : "disabled",
      deploy: deploy.state,
      deploy_msg: deploy.message,
    }),
  );
}

export async function deleteTgApiBotAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("tgapi:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(tgapiPath({ error: "invalid-id" }));
  const bot = await getBot(BigInt(idRaw));
  if (!bot) redirect(tgapiPath({ error: "invalid-id" }));
  await stopMenuBot(BigInt(idRaw)).catch((error: unknown) => {
    console.error(`[tgapi] 删除前停止机器人 #${idRaw} 失败:`, error);
  });
  await deleteBotRecord(BigInt(idRaw));
  await logOperation(admin, {
    action: "删除TGAPI申请机器人",
    target: bot.name,
    headers: await headers(),
  });
  revalidatePath("/admin/tgapi");
  redirect(tgapiPath({ saved: "deleted" }));
}

export async function revokeTgApiUnlockAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("tgapi:manage");
  const idRaw = String(formData.get("id") ?? "").trim();
  const botIdRaw = String(formData.get("bot_id") ?? "").trim();
  if (!idRaw || !/^\d+$/.test(idRaw)) redirect(tgapiPath({ error: "invalid-id" }));
  await deleteTgApiUnlock(BigInt(idRaw));
  await logOperation(admin, {
    action: "撤销TGAPI解锁",
    target: `解锁记录 #${idRaw}（机器人 #${botIdRaw || "?"}）`,
    headers: await headers(),
  });
  revalidatePath("/admin/tgapi");
  const back: Record<string, string> = { saved: "revoked" };
  if (botIdRaw && /^\d+$/.test(botIdRaw)) {
    back.bot = botIdRaw;
  }
  redirect(tgapiPath(back));
}
