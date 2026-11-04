import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

interface ScriptRow {
  id: number;
  name: string;
  filename: string;
  type: string;
  delivery_style: string;
  status: string;
}

interface CardRow {
  id: number;
  card_key: string;
  script_id: number;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  note: string;
  status: string;
  created_at: number;
  first_used_at: number | null;
  last_used_at: number | null;
}

interface OrderRow {
  id: number;
  card_key: string;
  title: string;
  price: number;
  status: string;
  source: string;
  apikey_id: number;
  apikey_name: string;
  created_at: number;
}

interface ApikeyRow {
  id: number;
  name: string;
  key: string;
  status: string;
  expires_at: number | null;
  rate_limit: number;
  rate_window: number;
  calls: number;
}

const scripts: ScriptRow[] = [
  { id: 1, name: "演示脚本", filename: "setup.ps1", type: "ps1", delivery_style: "script", status: "active" },
  { id: 2, name: "演示安装脚本", filename: "demo-tool.ps1", type: "ps1", delivery_style: "auto", status: "active" },
  { id: 3, name: "工具包", filename: "tool-pack.zip", type: "zip", delivery_style: "file", status: "active" },
];

const apikeys: ApikeyRow[] = [
  { id: 1, name: "闲鱼主号", key: "ak-86f5b3bc34c3ed383035e40603e159", status: "active", expires_at: null, rate_limit: 50, rate_window: 60, calls: 0 },
];

const legacyApikey = "2216c77984a2a0ac58976685ac20197c5b72de10ffe2824b";

const cards: CardRow[] = [];
const orders: OrderRow[] = [];
let cardSeq = 1;
let orderSeq = 1;

const BASE = "http://127.0.0.1:3001";

function ok(data: unknown, status = 200): string {
  return JSON.stringify({ ok: true, data }, null, 2);
}

function fail(error: string, status: number): { body: string; status: number } {
  return { body: JSON.stringify({ ok: false, error }), status };
}

function send(res: import("node:http").ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function newCardKey(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let key = "";
  for (const byte of bytes) key += alphabet[byte % alphabet.length];
  return key;
}

function normalizeCardKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9]{8}$/.test(trimmed) ? trimmed : null;
}

function decodeShareToken(token: string): string | null {
  try {
    const payload = Buffer.from(token.replace(/^sim-/, ""), "base64url").toString("utf-8");
    const parsed = JSON.parse(payload) as { t?: string; k?: string };
    return parsed.t === "p" && parsed.k ? parsed.k : null;
  } catch {
    return null;
  }
}

function authenticateIssueKey(header: string | undefined): { ok: true; row: ApikeyRow | null } | { ok: false; error: string; status: number } {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: false, error: "缺少 Authorization: Bearer <apikey>", status: 401 };
  const row = apikeys.find((k) => k.key === token);
  if (row) {
    if (row.status !== "active") return { ok: false, error: "APIKEY 已停用", status: 403 };
    if (row.expires_at && row.expires_at < Date.now()) return { ok: false, error: "APIKEY 已过期", status: 403 };
    row.calls += 1;
    return { ok: true, row };
  }
  if (token === legacyApikey) return { ok: true, row: null };
  return { ok: false, error: "APIKEY 无效", status: 401 };
}

async function handleIssue(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const auth = authenticateIssueKey(req.headers.authorization);
  if (!auth.ok) {
    const f = fail(auth.error, auth.status);
    send(res, f.body, f.status);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    const f = fail("请求体必须是 JSON", 400);
    send(res, f.body, f.status);
    return;
  }

  const title = String(body.title ?? "").trim();
  const price = Number(body.price);
  if (!title) {
    const f = fail("缺少参数: title（商品名称）", 400);
    send(res, f.body, f.status);
    return;
  }
  if (!Number.isFinite(price) || price < 0) {
    const f = fail("缺少参数: price（交易金额，数字）", 400);
    send(res, f.body, f.status);
    return;
  }

  const scriptId = parseInt(String(body.script_id ?? "0"), 10) || 0;
  const script = scripts.find((s) => s.id === scriptId && s.status === "active");
  if (!script) {
    const f = fail("未找到可用资源：请携带有效的 script_id（卖家后台 → 资源管理查看）", 404);
    send(res, f.body, f.status);
    return;
  }

  const maxUses = Math.max(1, Math.min(999, parseInt(String(body.max_uses ?? "1"), 10) || 1));
  const expiresHours = Math.max(0, Math.min(8760, parseFloat(String(body.expires_hours ?? "0")) || 0));
  const now = Date.now();
  const expiresAt = expiresHours > 0 ? now + expiresHours * 3600 * 1000 : null;

  const card: CardRow = {
    id: cardSeq++,
    card_key: newCardKey(),
    script_id: scriptId,
    max_uses: maxUses,
    used_count: 0,
    expires_at: expiresAt,
    note: `API发卡: ${title}`.slice(0, 200),
    status: "active",
    created_at: now,
    first_used_at: null,
    last_used_at: null,
  };
  cards.push(card);
  orders.push({
    id: orderSeq++,
    card_key: card.card_key,
    title,
    price,
    status: "paid",
    source: "api",
    apikey_id: auth.row?.id ?? 0,
    apikey_name: auth.row?.name ?? "",
    created_at: now,
  });

  const token = `sim-${Buffer.from(JSON.stringify({ t: "p", k: card.card_key })).toString("base64url")}`;
  send(res, ok({
    key: card.card_key,
    title,
    price,
    url: `${BASE}/s/${token}`,
    expires_at: expiresAt,
    max_uses: maxUses,
    script: script.name,
    delivery_style: script.delivery_style,
  }));
}

async function handleRedeem(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    body = {};
  }

  let cardKey = normalizeCardKey(body.key);
  let viaToken = false;
  if (!cardKey && typeof body.s === "string" && body.s) {
    cardKey = normalizeCardKey(decodeShareToken(body.s));
    viaToken = true;
    if (!cardKey) {
      const f = fail("分享链接无效或已过期", 404);
      send(res, f.body, f.status);
      return;
    }
  }
  if (!cardKey) {
    const f = fail("卡密格式错误（8 位英文数字）", 400);
    send(res, f.body, f.status);
    return;
  }

  const card = cards.find((c) => c.card_key === cardKey);
  if (!card) {
    const f = fail("卡密不存在", 404);
    send(res, f.body, f.status);
    return;
  }
  if (card.status === "revoked") {
    const f = fail("卡密已被作废", 403);
    send(res, f.body, f.status);
    return;
  }
  if (card.expires_at && card.expires_at < Date.now()) {
    const f = fail("卡密已过期", 403);
    send(res, f.body, f.status);
    return;
  }
  if (card.used_count >= card.max_uses) {
    const f = fail("卡密使用次数已用完", 403);
    send(res, f.body, f.status);
    return;
  }

  const script = scripts.find((s) => s.id === card.script_id);
  if (!script || script.status !== "active") {
    const f = fail("资源已下架，请联系卖家", 410);
    send(res, f.body, f.status);
    return;
  }

  const firstUse = card.used_count === 0;
  const now = Date.now();
  card.used_count += 1;
  card.last_used_at = now;
  if (firstUse) card.first_used_at = now;
  if (firstUse) {
    const order = orders.find((o) => o.card_key === card.card_key && o.status === "paid");
    if (order) order.status = "used";
  }

  send(res, ok({
    name: script.name,
    type: script.type,
    filename: script.filename,
    command: script.delivery_style === "file" ? "" : `irm ${BASE}/api/file/${script.filename} | iex`,
    download_url: `${BASE}/api/file/${script.filename}`,
    used_count: card.used_count,
    max_uses: card.max_uses,
    remaining: Math.max(0, card.max_uses - card.used_count),
    expires_at: card.expires_at,
    via: viaToken ? "s_token" : "key",
  }));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (req.method === "OPTIONS") {
    send(res, "", 204);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, ok({ version: "2.0.0-simulator", db: "up", time: Date.now() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/issue") {
    void handleIssue(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/redeem") {
    void handleRedeem(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/s/")) {
    const key = decodeShareToken(url.pathname.slice(3));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>卡密提取</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>资源交付中心</h1><p>您的卡密（验证码）：</p><p style="font-size:1.5rem;font-family:monospace">${key ?? "无效链接"}</p><p>请复制卡密，点击入群邀请链接加入群组，并在群内输入卡密完成验证。</p></body></html>`,
    );
    return;
  }
  const f = fail("接口不存在", 404);
  send(res, f.body, f.status);
});

server.listen(3001, "0.0.0.0", () => {
  console.log("RADS simulator (v2.0.0 protocol) listening on http://127.0.0.1:3001");
});
