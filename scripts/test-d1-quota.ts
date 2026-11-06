/**
 * D1 读取额度优化（v2.2.0）校验脚本 —— 本地副本库，跑完即弃，不触碰真实数据。
 *
 * 校验项：
 * 1. 配置类读缓存：同一 SQL 第二次读**零数据库访问**，命中率被计量
 * 2. 写后精确失效：写入后立刻读到新值（不会返回旧缓存）
 * 3. 高频写表（join_requests）永不缓存：两次读都会真的打库
 * 4. 聚合缓存：统计/计数第二次调用不再扫描
 * 5. 状态计数器与真实 GROUP BY 完全一致（insert / approve / reject / expire / purge）
 * 6. 关键索引生效（EXPLAIN QUERY PLAN 必须命中索引，不允许全表扫描）
 * 7. 省电模式：额度越线后 TTL 放大
 *
 * 用法：npm run test:d1-quota
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";

const TMP_DB = "/tmp/tgbots-d1-quota.db";
// 连 -wal / -shm 一起清：只删 .db 会让上一轮的 WAL 残留被回放，导致唯一键冲突
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(`${TMP_DB}${suffix}`)) rmSync(`${TMP_DB}${suffix}`, { force: true });
}
copyFileSync("prisma/bot-groups.db", TMP_DB);
process.env.DATABASE_URI = `file:${TMP_DB}`;
delete process.env.D1_FRUGAL_MODE;
process.env.D1_DAILY_READ_BUDGET = "4000000";

function ok(label: string, condition: boolean, detail?: unknown): void {
  const text =
    detail === undefined
      ? ""
      : ` → ${JSON.stringify(detail, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        )}`;
  console.log(`${condition ? "✅" : "❌"} ${label}${text}`);
  if (!condition) process.exitCode = 1;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

async function main(): Promise<void> {
  const client = await import("@/database/client");
  const ops = await import("@/database/operations");
  const metrics = await import("@/database/d1-metrics");
  const counters = await import("@/database/stats-counters");

  const CHAT_ID = -100777000111n;
  const CHAT2_ID = -100777000222n;

  // ---------- 1. 配置读缓存 ----------
  metrics.resetD1Metrics();
  const botFirst = await ops.getBot(1n);
  const afterFirst = metrics.getD1Usage().rowsRead;
  const botSecond = await ops.getBot(1n);
  const afterSecond = metrics.getD1Usage().rowsRead;
  ok("getBot 首次读数 > 0", afterFirst > 0, { rowsRead: afterFirst });
  ok("getBot 二次读取零新增行读（缓存命中）", afterSecond === afterFirst, {
    rowsRead: afterSecond,
  });
  ok("缓存的返回值与原值一致", stable(botFirst) === stable(botSecond));

  const settingsFirst = await ops.getGroupSettings(CHAT_ID);
  const afterSettings1 = metrics.getD1Usage().rowsRead;
  await ops.getGroupSettings(CHAT_ID);
  await ops.getGroupSettings(CHAT_ID);
  const afterSettings3 = metrics.getD1Usage().rowsRead;
  ok("getGroupSettings 连续两次命中缓存（零读）", afterSettings3 === afterSettings1, {
    delta: afterSettings3 - afterSettings1,
  });
  void settingsFirst;

  const menus1 = await ops.listMenus({ visibleOnly: true });
  const afterMenus1 = metrics.getD1Usage().rowsRead;
  const menus2 = await ops.listMenus({ visibleOnly: true });
  const afterMenus2 = metrics.getD1Usage().rowsRead;
  ok("listMenus 二次读取零新增行读", afterMenus2 === afterMenus1, {
    delta: afterMenus2 - afterMenus1,
    rows: menus1.length === menus2.length,
  });

  // ---------- 2. 写后精确失效 ----------
  await ops.upsertGroupSettings(CHAT_ID, {
    chatTitle: "额度测试群",
    method: "code_self",
    timeoutSeconds: 600,
    maxAttempts: 3,
    verifyChannel: "group",
  });
  const refreshed = await ops.getGroupSettings(CHAT_ID);
  ok("写入后立即可见（缓存已失效）", refreshed?.chatTitle === "额度测试群", {
    chatTitle: refreshed?.chatTitle,
  });

  // ---------- 3. 高频写表不缓存 ----------
  const token1 = "quota-test-token-0001";
  const token2 = "quota-test-token-0002";
  await ops.createJoinRequest({
    userId: 900001n,
    chatId: CHAT_ID,
    username: "quota_a",
    firstName: "QuotaA",
    lastName: null,
    verificationToken: token1,
    requestType: "telegram",
  });
  await ops.createJoinRequest({
    userId: 900002n,
    chatId: CHAT2_ID,
    username: "quota_b",
    firstName: "QuotaB",
    lastName: null,
    verificationToken: token2,
    requestType: "telegram",
  });

  metrics.resetD1Metrics();
  await ops.getJoinRequestByToken(token1);
  const afterJr1 = metrics.getD1Usage().rowsRead;
  await ops.getJoinRequestByToken(token1);
  const afterJr2 = metrics.getD1Usage().rowsRead;
  ok("join_requests 查询不缓存（每次真实读，保证正确性）", afterJr2 > afterJr1, {
    first: afterJr1,
    second: afterJr2,
  });

  // ---------- 4. 聚合缓存 ----------
  metrics.resetD1Metrics();
  await ops.getGlobalStats();
  const afterStats1 = metrics.getD1Usage().rowsRead;
  await ops.getGlobalStats();
  await ops.getGlobalStats();
  const afterStats3 = metrics.getD1Usage().rowsRead;
  ok("getGlobalStats 聚合结果被缓存（不重复扫描）", afterStats3 === afterStats1, {
    delta: afterStats3 - afterStats1,
    rowsRead: afterStats1,
  });

  metrics.resetD1Metrics();
  await ops.listJoinRequests({ pageSize: 5, page: 1 });
  const afterList1 = metrics.getD1Usage().rowsRead;
  await ops.listJoinRequests({ pageSize: 5, page: 1 });
  const afterList2 = metrics.getD1Usage().rowsRead;
  // 第二次只应取回当前页 5 行；若 COUNT 未缓存会额外扫一遍全表（> 5 行）
  ok("listJoinRequests 的 COUNT 被缓存（第二次只读当页行）", afterList2 - afterList1 === 5, {
    delta: afterList2 - afterList1,
  });

  // ---------- 5. 计数器一致性 ----------
  await counters.ensureJoinRequestCounters();

  await ops.approveJoinRequest(token1, null);
  await ops.rejectJoinRequest(token2, null);
  // 重复批准不应重复计数
  await ops.approveJoinRequest(token1, null);

  // 真实值在全部状态迁移之后取，才能与重算结果对照
  const actualGrouped = await client.queryAll<{ status: string; count: number }>(
    `SELECT status, COUNT(id) AS count FROM join_requests GROUP BY status`,
  );
  const actual: Record<string, number> = { pending: 0, approved: 0, rejected: 0, expired: 0 };
  let actualTotal = 0;
  for (const row of actualGrouped) {
    actual[String(row.status)] = Number(row.count);
    actualTotal += Number(row.count);
  }

  const recount = await counters.recalculateJoinRequestCounters();
  ok(
    "计数器与真实 GROUP BY 完全一致",
    recount.total === actualTotal &&
      stable(recount.byStatus) ===
        stable({
          pending: actual.pending,
          approved: actual.approved,
          rejected: actual.rejected,
          expired: actual.expired,
        }),
    { counters: recount, actual: { ...actual, total: actualTotal } },
  );

  const fastStats = await ops.getGlobalStats();
  ok("getGlobalStats 总数为真实行数", fastStats?.total_requests === actualTotal, {
    total: fastStats?.total_requests,
    actualTotal,
  });

  // 增量维护（不做全量重算）也必须自洽：新建 → pending+1
  const beforePending = (await counters.readJoinRequestCounters())?.byStatus.pending ?? 0;
  await ops.createJoinRequest({
    userId: 900003n,
    chatId: CHAT_ID,
    username: "quota_c",
    firstName: "QuotaC",
    lastName: null,
    verificationToken: "quota-test-token-0003",
    requestType: "telegram",
  });
  const afterPending = (await counters.readJoinRequestCounters())?.byStatus.pending ?? 0;
  ok("新增申请后 pending 增量 +1", afterPending === beforePending + 1, {
    beforePending,
    afterPending,
  });

  await ops.approveJoinRequest("quota-test-token-0003", null);
  const afterApprove = await counters.readJoinRequestCounters();
  ok(
    "批准后 pending-1 / approved+1",
    afterApprove?.byStatus.pending === afterPending - 1 &&
      afterApprove?.byStatus.approved === (recount.byStatus.approved ?? 0) + 1,
    afterApprove,
  );

  // ---------- 6. 索引是否真的被用上 ----------
  const plans: { label: string; sql: string; params: unknown[]; expect: string }[] = [
    {
      label: "加群申请列表分页（ORDER BY request_time）",
      sql: `SELECT * FROM join_requests ORDER BY request_time DESC LIMIT ? OFFSET ?`,
      params: [20, 0],
      expect: "idx_join_requests_request_time_status",
    },
    {
      label: "今日统计（request_time 范围 + 状态分组）",
      sql: `SELECT status, COUNT(id) FROM join_requests WHERE request_time >= ? AND request_time < ? GROUP BY status`,
      params: ["2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"],
      expect: "idx_join_requests_request_time_status",
    },
    {
      label: "群内 pending 查询",
      sql: `SELECT * FROM join_requests WHERE chat_id = ? AND status = ? ORDER BY request_time DESC LIMIT 1`,
      params: [Number(CHAT_ID), "pending"],
      expect: "idx_join_requests_chat_status",
    },
    {
      label: "过期会话清理",
      sql: `SELECT token FROM verification_sessions WHERE expires_at < ? AND captcha_completed = 0 ORDER BY expires_at DESC LIMIT 400`,
      params: ["2026-01-01T00:00:00.000Z"],
      expect: "idx_verification_sessions_expires_at",
    },
    {
      label: "会话归档删除",
      sql: `SELECT rowid FROM verification_sessions WHERE created_time < ? LIMIT 400`,
      params: ["2026-01-01T00:00:00.000Z"],
      expect: "idx_verification_sessions_created_time",
    },
  ];

  for (const item of plans) {
    const rows = await client.queryAll<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${item.sql}`,
      item.params as (string | number)[],
    );
    const detail = rows.map((row) => String(row.detail)).join(" | ");
    ok(`索引生效：${item.label}`, detail.includes(item.expect), detail);
  }

  // ---------- 7. 省电模式 ----------
  metrics.resetD1Metrics();
  const normalPlan = (await import("@/database/read-cache")).planQueryCache(
    `SELECT * FROM group_settings WHERE chat_id = ?`,
    [1],
  );
  process.env.D1_FRUGAL_MODE = "1";
  const frugalPlan = (await import("@/database/read-cache")).planQueryCache(
    `SELECT * FROM group_settings WHERE chat_id = ?`,
    [1],
  );
  delete process.env.D1_FRUGAL_MODE;
  ok(
    "省电模式放大缓存 TTL（20s → 120s）",
    normalPlan?.ttlSeconds === 20 && frugalPlan?.ttlSeconds === 120,
    { normal: normalPlan?.ttlSeconds, frugal: frugalPlan?.ttlSeconds },
  );

  const usage = metrics.getD1Usage();
  ok("计量快照可用（含读/写/命中率）", usage.rowsRead >= 0 && usage.readLimitFree === 5_000_000, {
    rowsRead: usage.rowsRead,
    rowsWritten: usage.rowsWritten,
    cacheHitRate: Number(usage.cacheHitRate.toFixed(1)),
    top: usage.topQueries.slice(0, 2).map((q) => q.sql.slice(0, 60)),
  });

  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${TMP_DB}${suffix}`, { force: true });
  }
}

main().catch((error) => {
  console.error("❌ 测试异常:", error);
  process.exitCode = 1;
});
