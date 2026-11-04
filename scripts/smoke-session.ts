import { createHash } from "node:crypto";
import { executeRun, queryOne } from "@/database/client";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

const token = process.argv[2] ?? "smoketest-token-12345";
const hash = createHash("sha256").update(token).digest("hex");

async function main(): Promise<void> {
  const user = await queryOne<{ id: number }>(
    "SELECT id FROM admin_users WHERE username = ?",
    ["admin"],
  );
  if (!user) throw new Error("admin user not found");
  await executeRun("DELETE FROM admin_sessions WHERE token_hash = ?", [hash]);
  await executeRun(
    "INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [Number(user.id), hash, new Date(Date.now() + 3600_000).toISOString()],
  );
  console.log(`session injected for user ${user.id}, token: ${token}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
