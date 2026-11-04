import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target) {
    process.env.DATABASE_URI = target;
  }
  const { queryAll } = await import("@/database/client");
  const sessions = await queryAll<{ c: number }>(
    "SELECT count(*) AS c FROM admin_sessions",
  );
  const admins = await queryAll<{ username: string }>(
    "SELECT username FROM admin_users",
  );
  const joins = await queryAll<{ c: number }>(
    "SELECT count(*) AS c FROM join_requests",
  );
  const logs = await queryAll<{ c: number }>(
    "SELECT count(*) AS c FROM operation_logs",
  );
  const menus = await queryAll<{ c: number }>("SELECT count(*) AS c FROM menus");
  const methods = await queryAll<{ name: string }>(
    "SELECT name FROM verification_methods",
  );
  const roles = await queryAll<{ code: string }>("SELECT code FROM roles");
  console.log(
    `DB => admins: ${admins.map((a) => a.username).join(",")} | roles: ${roles
      .map((r) => r.code)
      .join(",")} | menus: ${menus[0].c} | methods: ${methods
      .map((m) => m.name)
      .join(",")} | sessions: ${sessions[0].c} | join_requests: ${joins[0].c} | logs: ${logs[0].c}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
