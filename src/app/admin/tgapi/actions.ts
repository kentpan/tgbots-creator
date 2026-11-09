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
import {
  parseBotProfile,
  restartMenuBot,
  stopMenuBot,
  getMenuBotDeployState,
  waitForMenuBotDeployConfirmation,
} from "@/bot/multi-runtime";
import { getTelegramRuntimeSettings, resolveBotRuntime } from "@/services/bot-transport";
import {
  TGAPI_APP_PLATFORMS,
  TGAPI_TEXT_FIELD_KEYS,
  type TgApiBotConfig,
  type TgApiBotTexts,
  type TgApiUnlockMode,
} from "@/services/tgapi-config";

function tgapiPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return query ? `/admin/tgapi?${query}` : "/admin/tgapi";
}

/** 部署结果（真实结果，非预期值）随 redirect 传回页面展示 */
interface TgApiDeployOutcome {
  state: "ok" | "fail" | "pending" | "stopped";
  message: string;
}

const DEPLOY_CONFIRM_TIMEOUT_MS = 12000;

function truncateDeployMessage(message: string): string {
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * 保存/启停后的真实部署确认：await 运行实例重启（不再 fire-and-forget），
 * 按生效传输模式取真实结果：
 * - webhook：setWebhook 注册结果（startMenuBot 返回时已定）
 * - polling：有界等待 getMe 确认（onStart）/ 失败退出（onExit），超时如实报 pending
 * 部署失败绝不静默：原因随 redirect 回显到页面横幅。
 */
async function deployTgApiBotAndReport(botId: bigint, enabled: boolean): Promise<TgApiDeployOutcome> {
  if (!enabled) {
    return { state: "stopped", message: "机器人已停用，运行实例已停止" };
  }
  try {
    await restartMenuBot(botId);
  } catch (error) {
    console.error(`[tgapi] 机器人 #${String(botId)} 部署（重启运行实例）失败:`, error);
    return {
      state: "fail",
      message: truncateDeployMessage(error instanceof Error ? error.message : String(error)),
    };
  }
  await waitForMenuBotDeployConfirmation(botId, DEPLOY_CONFIRM_TIMEOUT_MS);
  const row = await getBot(botId);
  if (!row) {
    return { state: "fail", message: "部署失败：机器人记录不存在" };
  }
  const global = await getTelegramRuntimeSettings();
  const runtime = resolveBotRuntime(String(botId), row.config, global);
  const state = getMenuBotDeployState(botId);
  if (runtime.mode === "webhook") {
    if (state.transportOk === true) {
      return { state: "ok", message: `部署成功：Webhook 已注册（${state.transportUrl ?? "回调地址已生效"}）` };
    }
    if (state.transportOk === false) {
      return { state: "fail", message: `部署失败：${truncateDeployMessage(state.transportError ?? "Webhook 注册失败")}` };
    }
    return { state: "pending", message: "部署确认中：Webhook 注册尚未返回，请稍后刷新本页查看部署状态" };
  }
  if (state.started) {
    return { state: "ok", message: `部署成功：长轮询运行中（${state.transportUrl ?? "已连接 Telegram"}）` };
  }
  if (!state.running) {
    return {
      state: "fail",
      message: `部署失败：${truncateDeployMessage(state.startError ?? state.transportError ?? "轮询未启动，详见服务器日志")}`,
    };
  }
  return { state: "pending", message: "部署确认中：长轮询启动尚未确认，请稍后刷新本页查看部署状态" };
}

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

  // 按语言文案覆盖：表单字段 text_<lang>_<key>，留空 = 清除该条覆盖
  const buildLangTexts = (lang: "zh" | "en"): Partial<TgApiBotTexts> | undefined => {
    const collected: Partial<TgApiBotTexts> = {};
    for (const field of TGAPI_TEXT_FIELD_KEYS) {
      const value = String(formData.get(`text_${lang}_${field.name}`) ?? "").trim();
      if (value) collected[field.name] = value;
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
    appTitle: String(formData.get("app_title") ?? "").trim() || "usetgxbot",
    appShortName: String(formData.get("app_short_name") ?? "").trim() || "usetgxbot",
    appUrl: String(formData.get("app_url") ?? "").trim() || "https://telegram.dog/UseTGxBot",
    appPlatforms: parsePlatforms(formData),
    appDescription:
      String(formData.get("app_description") ?? "").trim() ||
      "created using https://telegram.dog/UseTGxBot",
    footerText: String(formData.get("footer_text") ?? "").trim() || "❤️ @SpEcHlDe",
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

  if (isEdit) {
    await updateBotRecord(BigInt(idRaw), {
      name,
      token: token || existing!.token,
      enabled,
      config: configJson,
    });
    const deploy = await deployTgApiBotAndReport(BigInt(idRaw), enabled);
    await logOperation(admin, {
      action: "保存TGAPI申请机器人",
      target: name,
      detail: `状态：${enabled ? "启用" : "停用"}；部署结果：${deploy.message}`,
      headers: await headers(),
    });
    revalidatePath("/admin/tgapi");
    redirect(tgapiPath({ saved: "1", deploy: deploy.state, deploy_msg: deploy.message }));
  } else {
    const created = await createBotRecord({
      name,
      token,
      enabled,
      config: configJson,
    });
    if (!created) redirect(tgapiPath({ error: "duplicate-token" }));
    const deploy = await deployTgApiBotAndReport(created.id, enabled);
    await logOperation(admin, {
      action: "创建TGAPI申请机器人",
      target: name,
      detail: `Token 尾号：${token.slice(-6)}；部署结果：${deploy.message}`,
      headers: await headers(),
    });
    revalidatePath("/admin/tgapi");
    redirect(tgapiPath({ saved: "1", deploy: deploy.state, deploy_msg: deploy.message }));
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
  const deploy = await deployTgApiBotAndReport(BigInt(idRaw), enable);
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
