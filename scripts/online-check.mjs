import { ProxyAgent, fetch as undiciFetch } from "undici";

const BASE = "https://tgbots.ccwu.cc";
const agent = new ProxyAgent("http://127.0.0.1:59752");
const jar = new Map();

function cookieHeader() {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function req(pathname, options = {}) {
  const resp = await undiciFetch(`${BASE}${pathname}`, {
    ...options,
    headers: { cookie: cookieHeader(), ...(options.headers ?? {}) },
    dispatcher: agent,
    redirect: "manual",
  });
  storeCookies(resp);
  return resp;
}

async function main() {
  // 1. 登录页拿 action id
  const loginPage = await req("/login");
  const html = await loginPage.text();
  const actionId = /\$ACTION_ID_([a-f0-9]+)/.exec(html)?.[1];
  console.log("login page:", loginPage.status, "action:", actionId ? "found" : "MISSING");
  if (!actionId) process.exit(1);

  // 2. 无 JS fallback 表单 POST 登录
  const form = new URLSearchParams();
  form.set("username", "admin");
  form.set("password", "asd..123");
  form.set(`$ACTION_ID_${actionId}`, "");
  const loginResp = await req("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  console.log("login POST:", loginResp.status, "→", loginResp.headers.get("location") ?? "(no redirect)");
  console.log("cookies:", jar.has("bg_admin_session") ? "session OK" : "NO SESSION");

  // 3. 抓取关键页面数据
  const mode = process.argv[2] ?? "all";
  if (mode === "all" || mode === "bots") {
    const botsPage = await req("/admin/bots");
    const botsHtml = await botsPage.text();
    console.log("\n=== /admin/bots", botsPage.status, "=== ");
    const names = [...botsHtml.matchAll(/font-medium">([^<]{1,60})<\/td>/g)].map((m) => m[1]);
    console.log("机器人行:", names.slice(0, 10));
    console.log("启用徽章:", (botsHtml.match(/(启用|停用)<\/span>/g) ?? []).join(","));
  }
  if (mode === "all" || mode === "groups") {
    const groupsPage = await req("/admin/groups");
    const groupsHtml = await groupsPage.text();
    console.log("\n=== /admin/groups", groupsPage.status, "=== ");
    const rows = (groupsHtml.match(/-100\d+/g) ?? []).slice(0, 10);
    console.log("群组 chat_id 出现:", rows);
    const empty = /暂无群组|empty/.test(groupsHtml);
    console.log("空态提示:", empty);
  }
  if (mode === "all" || mode === "join") {
    const joinPage = await req("/admin/join-requests");
    const joinHtml = await joinPage.text();
    console.log("\n=== /admin/join-requests", joinPage.status, "=== ");
    console.log("含 '暂无' 空态:", /暂无|没有/.test(joinHtml));
    const tokens = (joinHtml.match(/AJK[a-zA-Z0-9]{6,}/g) ?? []).length;
    console.log("申请记录样本数:", tokens);
    const total = /共\s*(\d+)\s*条|total[^0-9]*(\d+)/.exec(joinHtml);
    console.log("total 片段:", total ? total[0] : "(未见)");
  }
}

main().catch((error) => {
  console.error("执行失败:", error.message ?? error);
  process.exit(1);
});
