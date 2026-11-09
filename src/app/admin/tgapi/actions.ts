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
import { parseBotProfile, stopMenuBot } from "@/bot/multi-runtime";
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
 */
function buildTgApiConfig(formData: FormData): TgApiBotConfig {
  const unlockModeRaw = String(formData.get("unlock_mode") ?? "captcha").trim();
  const unlockMode: TgApiUnlockMode = unlockModeRaw === "stars" ? "stars" : "captcha";

  const methodRaw = String(formData.get("verification_method_id") ?? "").trim();
  const starsRaw = String(formData.get("stars_amount") ?? "").trim();
  const starsAmount = starsRaw === "" ? NaN : Number(starsRaw);

  if (unlockMode === "captcha" && (!methodRaw || !/^\d+$/.test(methodRaw))) {
    redirect(tgapiPath({ error: "method-required" }));
  }
  if (unlockMode === "stars" && (!Number.isFinite(starsAmount) || starsAmount < 1)) {
    redirect(tgapiPath({ error: "invalid-stars" }));
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

  return {
    enabled: true,
    unlockMode,
    verificationMethodId:
      unlockMode === "captcha" && methodRaw ? Number(methodRaw) : undefined,
    starsAmount:
      unlockMode === "stars" && Number.isFinite(starsAmount) ? Math.floor(starsAmount) : undefined,
    starsTitle: String(formData.get("stars_title") ?? "").trim() || undefined,
    askAppDetails: formData.get("ask_app_details") === "1",
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
  profile.tgapi = buildTgApiConfig(formData);
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
      detail: `状态：${enabled ? "启用" : "停用"}（仅保存配置，未部署）`,
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
      detail: `Token 尾号：${token.slice(-6)}（仅保存配置，未部署）`,
      headers: await headers(),
    });
    revalidatePath("/admin/tgapi");
    redirect(tgapiPath({ saved: "1" }));
  }
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
