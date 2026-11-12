/**
 * my.telegram.org 抓取解析器自检工具（v2.1.6）——
 * 用仿真的 /apps 页面 HTML（已有 APP / 未创建 APP 两种形态）验证
 * scrapeTgExistingApp 的解析行为与原 MyTelegramOrgRoBot step_three.py 的
 * BeautifulSoup 索引语义一致：span.input-xlarge[0]=app_id、[1]=api_hash、
 * [4]=测试配置 IP、[5]=生产配置 IP，p.help-block 末两项为 DC 描述，
 * 创建表单分支解析 input[name=hash]。
 *
 * 运行：npm run tsx scripts/test-my-telegram-org.ts
 */
import {
  createNewTgApp,
  loginStepGetStelCookie,
  requestTgCodeGetRandomHash,
  scrapeTgExistingApp,
} from "@/services/my-telegram-org";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

const EXISTING_APP_HTML = `<!DOCTYPE html>
<html><head><title>Telegram configuration</title></head>
<body>
<div class="well">
  <span class="input-xlarge uneditable-input">1893071</span>
  <span class="input-xlarge uneditable-input">0da2b5c1e2f3a4b5c6d7e8f9a0b1c2d3</span>
  <span class="input-xlarge uneditable-input">usetgxbot &amp; friends</span>
  <span class="input-xlarge uneditable-input">usetgxbot</span>
  <span class="input-xlarge uneditable-input">149.154.167.40</span>
  <span class="input-xlarge uneditable-input">149.154.175.50</span>
</div>
<p class="help-block">Endpoint for testers: 149.154.167.40:443 (DC 2)</p>
<p class="help-block">Endpoint: 149.154.175.50:443 (DC 2)</p>
</body></html>`;

const CREATE_FORM_HTML = `<!DOCTYPE html>
<html><head><title>Telegram applications</title></head>
<body>
<form action="/apps/create" method="post">
  <input type="hidden" name="hash" value="9f8e7d6c5b4a3210fedcba9876543210">
  <input class="input-xlarge" type="text" name="title" value="">
  <input class="input-xlarge" type="text" name="shortname" value="">
</form>
</body></html>`;

async function main(): Promise<void> {
  console.log("=== 分支 1：已有 APP 页面（title 含 configuration）===");
  const existing = await scrapeTgExistingAppWrap(EXISTING_APP_HTML);
  if (!existing.ok || !existing.info) {
    throw new Error("已有 APP 页面解析失败");
  }
  console.log("app_id =", existing.info.appId);
  console.log("api_hash =", existing.info.apiHash);
  console.log("test =", JSON.stringify(existing.info.testConfiguration));
  console.log("production =", JSON.stringify(existing.info.productionConfiguration));
  if (existing.info.appId !== "1893071") throw new Error("app_id 解析不正确");
  if (existing.info.apiHash !== "0da2b5c1e2f3a4b5c6d7e8f9a0b1c2d3") throw new Error("api_hash 解析不正确");
  if (existing.info.testConfiguration.ip !== "149.154.167.40") throw new Error("测试配置 IP 解析不正确");
  if (existing.info.productionConfiguration.ip !== "149.154.175.50") throw new Error("生产配置 IP 解析不正确");
  if (existing.info.testConfiguration.dc !== "Endpoint for testers: 149.154.167.40:443 (DC 2)")
    throw new Error("测试配置 DC 解析不正确");
  if (existing.info.productionConfiguration.dc !== "Endpoint: 149.154.175.50:443 (DC 2)")
    throw new Error("生产配置 DC 解析不正确");

  console.log("=== 分支 2：未创建 APP 页面（解析创建表单 hash）===");
  const fresh = await scrapeTgExistingAppWrap(CREATE_FORM_HTML);
  if (fresh.ok || fresh.appHash !== "9f8e7d6c5b4a3210fedcba9876543210") {
    throw new Error(`创建表单 hash 解析不正确：${JSON.stringify(fresh)}`);
  }
  console.log("app_hash =", fresh.appHash);

  console.log("=== 分支 3：value 在 name 之前的 input 写法 ====");
  const altHtml = CREATE_FORM_HTML.replace(
    '<input type="hidden" name="hash" value="9f8e7d6c5b4a3210fedcba9876543210">',
    '<input value="9f8e7d6c5b4a3210fedcba9876543210" type="hidden" name="hash">',
  );
  const alt = await scrapeTgExistingAppWrap(altHtml);
  if (alt.appHash !== "9f8e7d6c5b4a3210fedcba9876543210") throw new Error("value 前置写法解析失败");

  console.log("=== 分支 4：网络层函数（沙盒直连超时=预期，仅验证错误路径不静默）===");
  try {
    await requestTgCodeGetRandomHash("+99990000000");
    console.log("send_password 可达（沙盒网络已开放）");
  } catch (error) {
    console.log(
      "send_password 不可达（沙盒网络受限为预期，生产环境直连）:",
      error instanceof Error ? error.message.slice(0, 120) : error,
    );
  }
  try {
    const login = await loginStepGetStelCookie("+99990000000", "demo", "123456");
    console.log("login 返回 ok =", login.ok);
  } catch (error) {
    console.log(
      "login 网络不可达（预期）:",
      error instanceof Error ? error.message.slice(0, 120) : error,
    );
  }
  try {
    await createNewTgApp({
      stelToken: "stel_token=demo",
      tgAppHash: "demo",
      appTitle: "t",
      appShortName: "t",
      appUrl: "https://example.com",
      appPlatform: "android",
      appDescription: "t",
    });
  } catch (error) {
    console.log(
      "create 网络不可达（预期）:",
      error instanceof Error ? error.message.slice(0, 120) : error,
    );
  }

  console.log("=== 全部断言通过 ===");
}

async function scrapeTgExistingAppWrap(html: string) {
  // 分支 3 通过临时 mock fetch 验证（value 前置写法）
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  try {
    return await scrapeTgExistingApp("stel_token=demo");
  } finally {
    globalThis.fetch = original;
  }
}

main().catch((error) => {
  console.error("自检失败:", error);
  process.exit(1);
});
