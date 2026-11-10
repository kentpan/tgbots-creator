/**
 * GET /api/admin/backup/export — 导出白名单表数据为 sql / db / json 下载。
 *
 * Query: tables=admin_users,bots (缺省=全部白名单表) & format=sql|db|json
 *   - sql  : 每表 DELETE + INSERT 语句 (逐行 VALUES, 单引号转义), 可用 sqlite3/mysql 直接执行;
 *   - db   : SQLite 快照文件 (VACUUM INTO 产出一致性强快照); 仅本地 SQLite 驱动支持,
 *            D1 如实报错并提示改用 sql/json;
 *   - json : { exported_at, driver, tables } envelope (与导入格式同源)。
 *
 * 不走 JSON 信封: 让客户端拿到原始下载流。
 * 自 xianyu-admin v2.3.10 原样复刻（v2.2.3）。
 */
import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getDatabase } from "@/database/client";
import { DATA_TABLE_WHITELIST, isWhitelistedTable } from "@/lib/backup/whitelist";
import { driverOf } from "@/lib/backup/backup-runner";

export async function GET(request: Request): Promise<Response> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const db = await getDatabase();
  const url = new URL(request.url);
  const format = String(url.searchParams.get("format") || "json").toLowerCase();
  const tablesParam = String(url.searchParams.get("tables") || "").trim();

  const wanted =
    tablesParam && tablesParam !== "all"
      ? tablesParam.split(",").map((s) => s.trim()).filter((s) => s && isWhitelistedTable(s))
      : [...DATA_TABLE_WHITELIST];
  if (!wanted.length) {
    return NextResponse.json({ ok: false, error: "未选择任何可导出的表" }, { status: 200 });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  if (format === "db") {
    if (db.kind !== "node") {
      return NextResponse.json(
        { ok: false, error: `.db 快照仅支持本地 SQLite 驱动 (当前驱动: ${driverOf(db)}) — 请改用 sql 或 json 格式` },
        { status: 200 },
      );
    }
    const os = (await import("node:os")) as typeof import("node:os");
    const fs = (await import("node:fs")) as typeof import("node:fs");
    const path = (await import("node:path")) as typeof import("node:path");
    const tmp = path.join(os.tmpdir(), `tgbots-creator-backup-${Date.now()}.db`);
    try {
      // VACUUM INTO: 产出一致性强快照 (含 WAL 已合并数据), 不阻塞在线库。
      // node:sqlite 的 exec 不支持参数绑定, 路径由服务端自建 (单引号转义兜底)。
      await db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const buf = fs.readFileSync(tmp);
      return new Response(new Uint8Array(buf), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="tgbots-creator-${stamp}.db"`,
          "content-length": String(buf.length),
        },
      });
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  if (format === "sql") {
    const lines: string[] = [
      `-- tgbots-creator data export`,
      `-- exported_at: ${new Date().toISOString()}`,
      `-- driver: ${driverOf(db)}`,
      `-- 导入提示: 文本以单引号转义; 每表先 DELETE 再 INSERT (整表替换语义)`,
      ``,
    ];
    for (const table of wanted) {
      let rows: Record<string, unknown>[] = [];
      let cols: string[] = [];
      try {
        rows = await db.all(`SELECT * FROM ${table}`);
        if (rows.length) cols = Object.keys(rows[0]);
      } catch {
        rows = [];
      }
      lines.push(`-- ===== table: ${table} (${rows.length} rows) =====`);
      lines.push(`DELETE FROM ${table};`);
      for (const row of rows) {
        const vals = cols.map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number" && Number.isFinite(v)) return String(v);
          if (typeof v === "bigint") return String(v);
          if (v instanceof Uint8Array) return `'${Buffer.from(v).toString("base64")}'`;
          return `'${String(v).replace(/'/g, "''")}'`;
        });
        lines.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
      }
      lines.push("");
    }
    const sqlText = lines.join("\n");
    return new Response(sqlText, {
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="tgbots-creator-${stamp}.sql"`,
      },
    });
  }

  // json (默认): 与导入格式同源
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of wanted) {
    try {
      tables[name] = await db.all(`SELECT * FROM ${name}`);
    } catch {
      tables[name] = [];
    }
  }
  const json = JSON.stringify({ exported_at: new Date().toISOString(), driver: driverOf(db), tables });
  return new Response(json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="tgbots-creator-backup-${stamp}.json"`,
    },
  });
}
