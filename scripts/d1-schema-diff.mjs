// 两侧 sqlite_master 清单 → 纯增量 DDL(新表/新列/索引/触发器/视图), 永不 DROP/DELETE/INSERT 数据
// 退出码: 0=已一致 3=D1 空(首次安装) 4=计划已生成 1=硬限制需人工迁移
import { readFileSync, writeFileSync } from 'node:fs'

const [localPath, remotePath, outPath] = process.argv.slice(2)
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

// CREATE TABLE 括号体按顶层逗号切段(引号/嵌套括号感知)
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
  return { name: m[1] ?? m[2] ?? m[3] ?? m[4], rest: def.slice(m[0].length).trim() }
}

function ifNotExists(sql) {
  return sql
    .replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/^CREATE\s+INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ')
    .replace(/^CREATE\s+TRIGGER\s+/i, 'CREATE TRIGGER IF NOT EXISTS ')
    .replace(/^CREATE\s+VIEW\s+/i, 'CREATE VIEW IF NOT EXISTS ')
    .replace(/^CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
}

const local = load(localPath)
const remote = load(remotePath)
const rTables = new Map(), rOther = new Set()
for (const r of remote) {
  if (r.type === 'table') rTables.set(r.name, r)
  else rOther.add(r.name)
}
if (!rTables.size && !rOther.size) {
  console.error('D1 无任何用户对象 → 首次安装(交回调用方全量导入)')
  process.exit(3)
}

const stmts = []
const warns = []
for (const t of local.filter((r) => r.type === 'table')) {
  if (!rTables.has(t.name)) {
    stmts.push(ifNotExists(t.sql) + ';')
    continue
  }
  const rCols = new Set(topLevelParts(rTables.get(t.name).sql || '').map((d) => colInfo(d)?.name).filter(Boolean))
  const lCols = []
  for (const def of topLevelParts(t.sql || '')) {
    const info = colInfo(def)
    if (!info) continue
    lCols.push(info.name)
    if (rCols.has(info.name)) continue
    const bare = info.rest.replace(/'(?:[^']|'')*'/g, "''")
    if (/\b(PRIMARY\s+KEY|UNIQUE)\b/i.test(bare))
      fatal(`表 ${t.name} 新增列 ${info.name} 含主键/唯一约束 — SQLite ALTER 无法直接添加, 请人工迁移(建新表搬数据)后重试`)
    stmts.push(`ALTER TABLE "${t.name}" ADD COLUMN ${def};`)
  }
  for (const c of rCols) if (!lCols.includes(c)) warns.push(`D1 表 ${t.name} 有本地 schema 没有的列 ${c} → 保留不动`)
}
for (const o of local.filter((r) => r.type !== 'table' && r.sql)) {
  if (!rOther.has(o.name) && !rTables.has(o.name)) stmts.push(ifNotExists(o.sql) + ';')
}

const lNames = new Set(local.filter((r) => r.type === 'table' || r.sql).map((r) => r.name))
for (const name of rTables.keys()) if (!lNames.has(name)) warns.push(`D1 多出本地没有的表 ${name} → 数据保留不动`)
for (const n of rOther) if (!lNames.has(n)) warns.push(`D1 多出本地没有的 ${n} → 保留不动`)

for (const w of warns) console.error('  ⚠ ' + w)
if (!stmts.length) {
  console.error('✓ 本地 schema 与 D1 完全一致 → 零写入')
  process.exit(0)
}
writeFileSync(outPath, stmts.join('\n') + '\n')
console.error(`生成增量 DDL ${stmts.length} 条 → ${outPath}`)
process.exit(4)
