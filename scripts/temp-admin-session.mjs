// 临时管理员账号 + 会话（验证用，用完即删）
// 用法：node scripts/temp-admin-session.mjs  → 输出 token（cookie 值）
import { DatabaseSync } from "node:sqlite";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

const DB = "prisma/bot-groups.db";
const USERNAME = "temp-verify-227";

// 与 src/lib/password.ts 同构：pbkdf2$100000$salt_b64$hash_b64（SHA-256，64 字节）
const PBKDF2_ITERATIONS = 100000;
function hashPassword(password, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  const derived = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, "sha256");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltB64}$${derived.toString("base64")}`;
}

const db = new DatabaseSync(DB);
const existing = db.prepare("SELECT id FROM admin_users WHERE username = ?").get(USERNAME);
if (existing) {
  db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(existing.id);
  db.prepare("DELETE FROM admin_users WHERE id = ?").run(existing.id);
}
const role = db.prepare("SELECT id FROM roles ORDER BY id LIMIT 1").get();
if (!role) { console.error("no role found"); process.exit(1); }
const password = randomBytes(12).toString("base64url");
const saltB64 = randomBytes(16).toString("base64");
const hash = hashPassword(password, saltB64);
const res = db.prepare(
  "INSERT INTO admin_users (username, password_hash, display_name, role_id, status) VALUES (?, ?, 'temp verify', ?, 'active')",
).run(USERNAME, hash, role.id);
const userId = Number(res.lastInsertRowid);
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const expires = new Date(Date.now() + 3600_000).toISOString();
db.prepare(
  "INSERT INTO admin_sessions (user_id, token_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, '127.0.0.1', 'temp-verify')",
).run(userId, tokenHash, expires);
console.log(token);
db.close();
