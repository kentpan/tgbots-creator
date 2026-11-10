/**
 * POST /api/admin/backup/cron — 定时备份回调（Cloudflare Cron Triggers / 外部定时器调用）。
 *
 * 鉴权: header x-backup-token 或 query token 必须等于 app_settings.backup_cron_token
 * (备份页可生成令牌; 令牌为空 = 回调通道未启用, 一律拒绝)。
 *
 * 到点判定: enabled 且 isBackupDue (每 X 天 X时X分X秒, 见 backup-runner.ts) 才真正执行;
 * 未到点/未启用如实返回 skipped, 绝不重复备份。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getDatabase } from "@/database/client";
import { isBackupDue, loadBackupSettings, parseBackupConfig, runBackup, markBackupRan } from "@/lib/backup/backup-runner";
import { getBackupStore } from "@/lib/backup/backup-store";

export async function POST(request: Request): Promise<NextResponse> {
  // 令牌校验（非空常量比对; 回调方为定时器而非用户会话, 不走管理员会话鉴权）
  const db = await getDatabase();
  const url = new URL(request.url);
  const token = String(request.headers.get("x-backup-token") || url.searchParams.get("token") || "");
  const cfg = parseBackupConfig(await loadBackupSettings(db));
  if (!cfg.cron_token) {
    return NextResponse.json({ ok: false, error: "备份回调未启用: 请先在备份管理页生成回调令牌" }, { status: 200 });
  }
  if (token !== cfg.cron_token) {
    return NextResponse.json({ ok: false, error: "备份回调令牌无效" }, { status: 200 });
  }

  const due = isBackupDue(cfg);
  if (!due.due) {
    return NextResponse.json({ ok: true, data: { skipped: true, reason: due.reason } });
  }

  const store = await getBackupStore();
  const result = await runBackup(db, store, cfg.tables);
  await markBackupRan(db);
  return NextResponse.json({
    ok: true,
    data: {
      backup: result,
      message: `定时备份完成: ${result.key} (${result.tables.length} 表 / ${result.rows} 行 → ${result.storage})`,
    },
  });
}
