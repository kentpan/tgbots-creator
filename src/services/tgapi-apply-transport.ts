/**
 * TGAPI 申请传输层：统一让管理向导和真实 Telegram Bot 使用同一代理选择逻辑。
 * 代理启用时不允许静默回退直连；代理会话 Cookie/token 必须随申请会话保存。
 */
import {
  loginStepGetStelCookie,
  requestTgCodeGetRandomHash,
  scrapeTgExistingApp,
  createNewTgApp,
  type TgOrgScrapeResult,
} from "@/services/my-telegram-org";
import {
  getTgapiProxyConfig,
  proxySendCode,
  proxyVerifyCode,
  proxyGetApp,
  proxyCreateApp,
} from "@/services/tgapi-proxy";

export type TgApiFlowTransport =
  | { mode: "direct" }
  | { mode: "proxy"; stelToken: string | null; cookies: Record<string, string> };

export interface TgApiFlowLoginResult {
  ok: boolean;
  cookie: string;
  error: string;
  transport: TgApiFlowTransport;
}

function asScrapeResult(data: {
  appExists: boolean;
  appId: string;
  apiHash: string;
  appHash: string;
}): TgOrgScrapeResult {
  if (data.appExists && data.appId && data.apiHash) {
    return {
      ok: true,
      info: {
        appId: data.appId,
        apiHash: data.apiHash,
        testConfiguration: { ip: "", dc: "" },
        productionConfiguration: { ip: "", dc: "" },
      },
      appHash: "",
    };
  }
  return { ok: false, info: null, appHash: data.appHash };
}

/** 按当前全局配置选择直连或代理；代理开启但无效时明确失败，绝不静默直连。 */
export async function sendTgApiLoginCode(
  phone: string,
): Promise<{ randomHash: string; transport: TgApiFlowTransport }> {
  const config = await getTgapiProxyConfig();
  if (!config.enabled) {
    return { randomHash: await requestTgCodeGetRandomHash(phone), transport: { mode: "direct" } };
  }
  const result = await proxySendCode(phone);
  return {
    randomHash: result.randomHash,
    transport: { mode: "proxy", stelToken: null, cookies: result.cookies },
  };
}

/** 使用发送验证码时选定的传输路径登录，后续步骤不再重新选择路径。 */
export async function verifyTgApiLoginCode(
  phone: string,
  randomHash: string,
  code: string,
  transport: TgApiFlowTransport,
): Promise<TgApiFlowLoginResult> {
  if (transport.mode === "proxy") {
    const result = await proxyVerifyCode(phone, randomHash, code, transport.cookies);
    if (!result.ok) {
      return { ok: false, cookie: "", error: result.error, transport: { ...transport, cookies: result.cookies } };
    }
    return {
      ok: true,
      cookie: "",
      error: "",
      transport: { mode: "proxy", stelToken: result.stelToken, cookies: result.cookies },
    };
  }
  const result = await loginStepGetStelCookie(phone, randomHash, code);
  return { ...result, transport };
}

/** 拉取现有 APP / 创建表单 hash。 */
export async function getTgApiApp(
  cookie: string,
  transport: TgApiFlowTransport,
): Promise<{ result: TgOrgScrapeResult; transport: TgApiFlowTransport }> {
  if (transport.mode === "proxy") {
    if (!transport.stelToken) throw new Error("TGAPI代理会话缺少 stel_token，请重新申请登录码");
    const result = await proxyGetApp(transport.stelToken, transport.cookies);
    return {
      result: asScrapeResult(result),
      transport: { ...transport, cookies: result.cookies },
    };
  }
  return { result: await scrapeTgExistingApp(cookie), transport };
}

/** 创建应用；代理返回的凭据来自代理端对 my.telegram.org /apps/create 的真实响应。 */
export async function createTgApiApp(
  input: {
    stelToken: string;
    tgAppHash: string;
    appTitle: string;
    appShortName: string;
    appUrl: string;
    appPlatform: string;
    appDescription: string;
  },
  transport: TgApiFlowTransport,
): Promise<{ result: TgOrgScrapeResult; transport: TgApiFlowTransport }> {
  if (transport.mode === "proxy") {
    if (!transport.stelToken) throw new Error("TGAPI代理会话缺少 stel_token，请重新申请登录码");
    const created = await proxyCreateApp({
      stelToken: transport.stelToken,
      cookies: transport.cookies,
      appTitle: input.appTitle,
      appShortName: input.appShortName,
      appPlatform: input.appPlatform,
      appUrl: input.appUrl,
      appDescription: input.appDescription,
    });
    return {
      result: {
        ok: true,
        info: {
          appId: created.appId,
          apiHash: created.apiHash,
          testConfiguration: { ip: "", dc: "" },
          productionConfiguration: { ip: "", dc: "" },
        },
        appHash: "",
      },
      transport: { ...transport, cookies: created.cookies },
    };
  }

  await createNewTgApp({ ...input, stelToken: input.stelToken });
  const result = await scrapeTgExistingApp(input.stelToken);
  return { result, transport };
}
