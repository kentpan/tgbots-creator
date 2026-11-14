// 版本化 SQL 升级幂等过滤器（scripts/d1-upgrade-filter.mjs）
// 用法: node scripts/d1-upgrade-filter.mjs <sql-file> <remote-inv.json> <out-file>
//   sql-file       prisma/sql-upgrade-v<version>.sql 原始增量
//   remote-inv.json wrangler d1 execute --json 的 sqlite_master 清单
//                   (SELECT type, name, sql FROM sqlite_master WHERE ...)
//   out-file       过滤后仍需执行的语句(空文件 = D1 已全部就位, 零写入)
//
// 背景(2026-11-14 CI 事故): SQLite 无 ADD COLUMN IF NOT EXISTS, 版本化增量里的
// 裸 ALTER TABLE ADD COLUMN 在"列已被运行时 ensureAppSchema 补齐 / 上次部署已
// 应用"的库上重复执行必报 duplicate column name, 炸掉整个部署。本脚本把版本化
// 增量归一为幂等形式后再执行:
//   ① CREATE TABLE/INDEX/TRIGGER/VIEW → IF NOT EXISTS(缺则补)
//   ② ALTER TABLE x ADD COLUMN c → 远端表存在且列已存在 → 剔除; 表不存在或列
//      缺失 → 保留
//   ③ 剥离 PRAGMA/BEGIN/COMMIT(与 "Apply D1 schema" 步骤同口径)
//   ④ 其余语句原样保留(迁移作者负责其幂等性)
// 退出码: 0=过滤完成(输出可能为空) 1=输入/解析异常
import { readFileSync, writeFileSync } from 'node:fs'

const [sqlFile, remotePath, outPath] = process.argv.slice(2)
if (!sqlFile || !remotePath || !outPath) {
  console.error('::error::用法: node scripts/d1-upgrade-filter.mjs <sql-file> <remote-inv.json> <out-file>')
  process.exit(1)
}

const fatal = (msg) => { console.error('::error::' + msg); process.exit(1) }

// 兼容三形态: sqlite3 -json 行数组 / wrangler 块数组 / wrangler {result:{results}}
function load(p) {
  const j = JSON.parse(readFileSync(p, 'utf8'))
  const blocks = Array.isArray(j) ? j : (Array.isArray(j?.result) ? j.result : j?.result ? [j.result] : [])
  return blocks.flatMap((b) => {
    if (Array.isArray(b?.results)) return b.results
    return Array.isArray(b) ? b : [b]
  })
}

// CREATE TABLE 括号体按顶层逗号切段(引号/嵌套括号感知) —— 与 d1-schema-diff.mjs 同源
function topLevelParts(sql) {
  const parts = []
  let depth = 0, cur = '', str = null
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (str) { cur += c; if (c === str) { if (sql[i + 1] === str) cur += sql[++i]; else str = null } continue }
    if (c === "'" || c === '"' || c === '`') { str = c; cur += c; continue }
    if (c === '[') { const j = sql.indexOf(']', i); cur += sql.slice(i, j === -1 ? sql.length : j + 1); if (j !== -1) i = j; continue }
    if (c === '(') { depth++; if (depth === 1) { cur = ''; continue } }
    if (c === ')') { depth--; if (depth === 0) { if (cur.trim()) parts.push(cur.trim()); return parts } }
    if (c === ',' && depth === 1) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue }
    if (depth >= 1) cur += c
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i
function colInfo(def) {
  if (TABLE_CONSTRAINT.test(def)) return null
  const m = def.match(/^"((?:[^"]|"")+)"/) || def.match(/^\[([^\]]+)\]/) || def.match(/^`([^`]+)`/) || def.match(/^([A-Za-z_][A-Za-z0-9_$]*)/)
  if (!m) return null
  return { name: m[1] ?? m[2] ?? m[3] ?? m[4] }
}

function ifNotExists(sql) {
  // (IF NOT EXISTS )? 可选拍获: 语句已带 IF NOT EXISTS 时原样保留, 防止双插
  // ("CREATE TABLE IF NOT EXISTS IF NOT EXISTS ..." 是 CI 实录过的语法错误)
  return sql
    .replace(/^CREATE\s+UNIQUE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/^CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE INDEX IF NOT EXISTS ')
    .replace(/^CREATE\s+TRIGGER\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TRIGGER IF NOT EXISTS ')
    .replace(/^CREATE\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE VIEW IF NOT EXISTS ')
    .replace(/^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS ')
}

// 远端对象索引: 表名 → 列名集合; 其余对象名集合
const remote = load(remotePath)
const rTableCols = new Map(), rOther = new Set()
for (const r of remote) {
  if (r.type === 'table') {
    const cols = new Set(topLevelParts(r.sql || '').map((d) => colInfo(d)?.name).filter(Boolean))
    rTableCols.set(r.name, cols)
  } else if (r.sql) {
    rOther.add(r.name)
  }
}

// 剥离整行注释后按引号感知切分语句(分号在单引号外才算语句结束; '' 为转义)
const raw = readFileSync(sqlFile, 'utf8')
const noComments = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
const stmts = []
let cur = '', str = null
for (let i = 0; i < noComments.length; i++) {
  const c = noComments[i]
  if (str) {
    cur += c
    if (c === str) { if (noComments[i + 1] === str) cur += noComments[++i]; else str = null }
    continue
  }
  if (c === "'" || c === '"' || c === '`') { str = c; cur += c; continue }
  if (c === ';') { if (cur.trim()) stmts.push(cur.trim()); cur = ''; continue }
  cur += c
}
if (cur.trim()) stmts.push(cur.trim())

const kept = [], skipped = []
for (let s of stmts) {
  // ① 剥离 PRAGMA/事务包裹
  if (/^(PRAGMA|BEGIN|COMMIT)\b/i.test(s)) { skipped.push(s.replace(/\s+/g, ' ').slice(0, 80) + '  → 事务/PRAGMA 语句剥离'); continue }
  // ② CREATE 归一 IF NOT EXISTS
  if (/^CREATE\b/i.test(s)) s = ifNotExists(s)
  // ③ ALTER TABLE x ADD COLUMN c → 远端列已存在则剔除
  const m = s.match(/^ALTER\s+TABLE\s+(?:"((?:[^"]|"")+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\s+ADD\s+COLUMN\s+/i)
  if (m) {
    const table = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (rTableCols.has(table)) {
      // 列名 = ADD COLUMN 之后的第一个标识符(引号感知)
      const rest = s.slice(m[0].length)
      const cm = rest.match(/^"((?:[^"]|"")+)"|^\[([^\]]+)\]|^`([^`]+)`|^([A-Za-z_][A-Za-z0-9_$]*)/)
      const col = cm && (cm[1] ?? cm[2] ?? cm[3] ?? cm[4])
      if (col && rTableCols.get(table).has(col)) {
        skipped.push(`ALTER TABLE ${table} ADD COLUMN ${col}  → 远端列已存在, 跳过`)
        continue
      }
    }
    // 表不存在或列缺失 → 保留(加引号归一表名, 防保留字)
    kept.push(`ALTER TABLE "${table}" ADD COLUMN ` + s.slice(m[0].length) + ';')
    continue
  }
  // ④ 其余语句原样保留
  kept.push(s.endsWith(';') ? s : s + ';')
}

writeFileSync(outPath, kept.length ? kept.join('\n') + '\n' : '')
for (const k of skipped) console.error('  ⏭ ' + k)
if (!kept.length) {
  console.error('✓ 版本化增量内容远端已全部就位 → 零写入')
} else {
  console.error(`过滤完成: 保留 ${kept.length} 条待执行, 跳过 ${skipped.length} 条 → ${outPath}`)
}
process.exit(0)
