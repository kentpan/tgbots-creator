/**
 * my.telegram.org 抓取客户端（v2.1.6）——
 * 原样移植 SpEcHiDe/MyTelegramOrgRoBot 的 bot/helper_funcs/my_telegram_org/ 四个步骤
 * （step_one.py → step_four.py），Python aiohttp/BeautifulSoup 改写为 Node fetch + 正则解析。
 *
 * 四步流程（与原项目逐字对应）：
 * 1. POST /auth/send_password {phone}            → JSON {random_hash}（step_one.request_tg_code_get_random_hash）
 * 2. POST /auth/login {phone,random_hash,password} → 文本 "true" + Set-Cookie stel_token
 *                                                   （step_two.login_step_get_stel_cookie）
 * 3. GET  /apps（带 Cookie）                      → 已有 APP：解析 app_id/api_hash/MTProto 服务器；
 *                                                   无 APP：解析创建表单的 hash（step_three.scarp_tg_existing_app）
 * 4. POST /apps/create {hash,app_title,...}       → 创建 APP（step_four.create_new_tg_app）
 */

const MY_TELEGRAM_ORG_ORIGIN = "https://my.telegram.org";
const REQUEST_TIMEOUT_MS = 30000;

/** 请求 UA：原项目为 aiohttp 默认 UA；这里使用固定标识 UA（部分站点会拦截 Python UA） */
const REQUEST_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TGuardTGApiBot/2.1.7";

/** step_one.request_tg_code_get_random_hash：请求发送 Telegram 登录码，返回 random_hash */
export async function requestTgCodeGetRandomHash(inputPhone: string): Promise<string> {
  const response = await fetch(`${MY_TELEGRAM_ORG_ORIGIN}/auth/send_password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REQUEST_UA,
      Referer: `${MY_TELEGRAM_ORG_ORIGIN}/auth/login`,
    },
    body: new URLSearchParams({ phone: inputPhone }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`my.telegram.org send_password HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`my.telegram.org send_password 响应不是 JSON：${text.slice(0, 200)}`);
  }
  const randomHash =
    typeof payload === "object" && payload !== null
      ? (payload as { random_hash?: unknown }).random_hash
      : undefined;
  if (typeof randomHash !== "string" || !randomHash.trim()) {
    throw new Error(
      `my.telegram.org send_password 未返回 random_hash（响应：${text.slice(0, 200)}）`,
    );
  }
  return randomHash;
}

export interface TgOrgLoginResult {
  /** true = 登录成功（cookie 为 stel_token 值）；false = 登录失败（error 为接口原文） */
  ok: boolean;
  cookie: string;
  error: string;
}

/** step_two.login_step_get_stel_cookie：用登录码换取 stel_token 会话 Cookie */
export async function loginStepGetStelCookie(
  inputPhone: string,
  tgRandomHash: string,
  tgCloudPassword: string,
): Promise<TgOrgLoginResult> {
  const response = await fetch(`${MY_TELEGRAM_ORG_ORIGIN}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REQUEST_UA,
      Referer: `${MY_TELEGRAM_ORG_ORIGIN}/auth/login`,
    },
    body: new URLSearchParams({
      phone: inputPhone,
      random_hash: tgRandomHash,
      password: tgCloudPassword,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  // 原实现：响应文本 "true" 即成功，Cookie 取 Set-Cookie 响应头
  if (text.trim() === "true") {
    const cookie = collectStelTokenCookie(response);
    if (!cookie) {
      return { ok: false, cookie: "", error: "登录成功但响应缺少 stel_token Cookie" };
    }
    return { ok: true, cookie, error: "" };
  }
  return { ok: false, cookie: "", error: text.trim() || `HTTP ${response.status}` };
}

/** 从响应头收集 stel_token（原实现直接透传 Set-Cookie 值；这里只取 Cookie 名值对，兼容多 Set-Cookie） */
function collectStelTokenCookie(response: Response): string {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const line of raw) {
    const first = line.split(";")[0]?.trim() ?? "";
    if (first.toLowerCase().startsWith("stel_token=")) {
      return first;
    }
  }
  return raw.length > 0 ? (raw[0].split(";")[0]?.trim() ?? "") : "";
}

export interface TgAppInfo {
  appId: string;
  apiHash: string;
  testConfiguration: { ip: string; dc: string };
  productionConfiguration: { ip: string; dc: string };
}

export interface TgOrgScrapeResult {
  /** true = 用户已有 APP（info 有效）；false = 尚未创建 APP（appHash 为创建表单 hash） */
  ok: boolean;
  info: TgAppInfo | null;
  appHash: string;
}

const DISCLAIMER_TEXT = "It is forbidden to pass this value to third parties.";

/** 基础 HTML 实体解码（BeautifulSoup .string 会自动解码，这里等价处理常见命名实体） */
function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

/** 去掉节点内部的子标签并解码实体、修剪空白（等价 BeautifulSoup 的 .text.strip() / .string） */
function extractText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, "")).trim();
}

/** step_three.scarp_tg_existing_app：抓取 /apps 页面（已有 APP → 解析；否则 → 解析创建表单 hash） */
export async function scrapeTgExistingApp(stelToken: string): Promise<TgOrgScrapeResult> {
  const response = await fetch(`${MY_TELEGRAM_ORG_ORIGIN}/apps`, {
    method: "GET",
    headers: {
      Cookie: stelToken,
      "User-Agent": REQUEST_UA,
      Referer: `${MY_TELEGRAM_ORG_ORIGIN}/apps`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`my.telegram.org /apps HTTP ${response.status}: ${html.slice(0, 200)}`);
  }

  // 页面标题判定（原实现：title 含 "configuration" 即已有 APP）
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? extractText(titleMatch[1]) : "";

  if (title.includes("configuration")) {
    // span.input-xlarge 列表：[0]=app_id [1]=api_hash [4]=测试配置 IP [5]=生产配置 IP
    //（索引语义与原实现逐字一致 —— 页面中 App title/shortname/url 等输入框占据中间索引）
    const spans = extractTaggedFragments(html, "span", "input-xlarge");
    const helpBlocks = extractTaggedFragments(html, "p", "help-block");
    if (spans.length < 6) {
      throw new Error(
        `my.telegram.org /apps 页面结构变化（span.input-xlarge 仅 ${spans.length} 个，需要 6 个）`,
      );
    }
    if (helpBlocks.length < 2) {
      throw new Error(
        `my.telegram.org /apps 页面结构变化（p.help-block 仅 ${helpBlocks.length} 个，需要 2 个）`,
      );
    }
    return {
      ok: true,
      info: {
        appId: spans[0],
        apiHash: spans[1],
        testConfiguration: { ip: spans[4], dc: helpBlocks[helpBlocks.length - 2] },
        productionConfiguration: { ip: spans[5], dc: helpBlocks[helpBlocks.length - 1] },
      },
      appHash: "",
    };
  }

  // 未创建 APP：解析创建表单 input[name=hash] 的 value
  const hashMatch =
    /<input[^>]*name=["']hash["'][^>]*value=["']([^"']*)["']/i.exec(html) ??
    /<input[^>]*value=["']([^"']*)["'][^>]*name=["']hash["']/i.exec(html);
  if (!hashMatch) {
    throw new Error("my.telegram.org /apps 页面未找到创建表单 hash 输入框");
  }
  return { ok: false, info: null, appHash: decodeHtmlEntities(hashMatch[1]) };
}

/**
 * 提取指定标签 + class 的全部节点文本（等价 BeautifulSoup find_all(tag, {"class": name})）：
 * class 匹配按完整 class token 匹配（input-xlarge 不误伤 input-xlarge-uneditable 之外的嵌套写法），
 * 与原实现 find_all("span", {"class": "input-xlarge"}) 的单 class 完整匹配语义一致。
 */
function extractTaggedFragments(html: string, tag: string, className: string): string[] {
  const results: string[] = [];
  const pattern = new RegExp(
    `<${tag}\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    results.push(extractText(match[1]));
    if (results.length > 64) break;
  }
  return results;
}

/**
 * step_four.create_new_tg_app：创建 APP（平台随机选一，与原实现 random.choice 一致）。
 * 返回响应原文（原实现调用方忽略响应内容，靠重新抓取 /apps 验证结果）。
 */
export async function createNewTgApp(input: {
  stelToken: string;
  tgAppHash: string;
  appTitle: string;
  appShortName: string;
  appUrl: string;
  appPlatforms: string[];
  appDescription: string;
}): Promise<string> {
  const platform =
    input.appPlatforms[Math.floor(Math.random() * input.appPlatforms.length)] ?? "android";
  const response = await fetch(`${MY_TELEGRAM_ORG_ORIGIN}/apps/create`, {
    method: "POST",
    headers: {
      Cookie: input.stelToken,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REQUEST_UA,
      Referer: `${MY_TELEGRAM_ORG_ORIGIN}/apps`,
    },
    body: new URLSearchParams({
      hash: input.tgAppHash,
      app_title: input.appTitle,
      app_shortname: input.appShortName,
      app_url: input.appUrl,
      app_platform: platform,
      app_desc: input.appDescription,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`my.telegram.org /apps/create HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
}
