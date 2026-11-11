#!/usr/bin/env python3
"""三方 schema 审查：v2.2.5.zip 库 / 本地 v2.2.7 库 / 线上 D1 导出 .sql 影子 + prisma/schema.sql
产出：每张表的列集合对比，找出线上 D1 缺失的列/表（D1_ERROR: no such column 根因清单）"""
import re, sqlite3, json, sys

ONLINE_SQL = "/home/z/my-project/upload/tgbots-creator-2026-11-10-17-27-53.sql"
V225_DB = "/tmp/audit/v225/prisma/bot-groups.db"
V227_DB = "/home/z/my-project/prisma/bot-groups.db"
SCHEMA_SQL = "/home/z/my-project/prisma/schema.sql"

def db_schema(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = con.cursor()
    names = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
    ).fetchall()]
    tables = {}
    for name in names:
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info('{name}')").fetchall()]
        tables[name] = cols
    con.close()
    return tables

def online_sql_shadow(path):
    """从导出 .sql 的 INSERT INTO t (cols) 提取线上表/列影子（驱动 d1 导出带列名）"""
    tables = {}
    pat = re.compile(r"^INSERT INTO (\w+) \(([^)]+)\) VALUES", re.M)
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = pat.match(line)
            if m:
                t, cols = m.group(1), [c.strip() for c in m.group(2).split(",")]
                if t in tables:
                    tables[t] = [c for c in tables[t] if c in cols]  # 交集（同表多行取公共列）
                else:
                    tables[t] = cols
    return tables

def schema_sql_tables(path):
    """prisma/schema.sql 的 CREATE TABLE 列集合"""
    tables = {}
    cur = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"CREATE TABLE (?:IF NOT EXISTS )?['\"]?(\w+)", line.strip())
            if m:
                cur = m.group(1); tables[cur] = []
            elif cur and line.strip().startswith(("`", '"', "'")) is False:
                m2 = re.match(r"['\"`]?(\w+)['\"`]?\s+\w", line.strip())
                if m2 and not line.strip().upper().startswith(("CREATE", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", ")", "CONSTRAINT")):
                    tables[cur].append(m2.group(1))
    return tables

v225 = db_schema(V225_DB)
v227 = db_schema(V227_DB)
online = online_sql_shadow(ONLINE_SQL)
sch = schema_sql_tables(SCHEMA_SQL)

print("=" * 70)
print("【A】线上 D1 导出影子 vs 本地 v2.2.7 库 —— 找线上缺失的表/列")
print("=" * 70)
missing_tables = [t for t in v227 if t not in online]
print("\n■ 线上完全缺失的表（本地有、线上导出中无）:")
for t in sorted(missing_tables):
    print(f"  - {t}  (列: {', '.join(v227[t])})")
if not missing_tables:
    print("  (无)")

print("\n■ 线上缺失的列（同名表逐列对比）:")
any_missing_col = False
for t in sorted(set(v227) & set(online)):
    miss = [c for c in v227[t] if c not in online[t]]
    if miss:
        any_missing_col = True
        print(f"  - {t}: 缺 {', '.join(miss)}")
if not any_missing_col:
    print("  (无)")

print("\n■ 线上多出的列（线上有、本地无 —— 仅提示）:")
for t in sorted(set(v227) & set(online)):
    extra = [c for c in online[t] if c not in v227[t]]
    if extra:
        print(f"  - {t}: 多 {', '.join(extra)}")

print("\n" + "=" * 70)
print("【B】v2.2.5.zip 库 vs 本地 v2.2.7 库 —— 版本间 schema 演进")
print("=" * 70)
diff_tables = [t for t in v227 if t not in v225] + [t for t in v225 if t not in v227]
print("\n■ 表差异:", sorted(diff_tables) if diff_tables else "无")
for t in sorted(set(v225) & set(v227)):
    miss = [c for c in v227[t] if c not in v225[t]]
    extra = [c for c in v225[t] if c not in v227[t]]
    if miss or extra:
        print(f"  - {t}: v2.2.5缺 {miss} 多 {extra}")

print("\n" + "=" * 70)
print("【C】prisma/schema.sql vs 本地 v2.2.7 库 —— schema.sql 是否落后")
print("=" * 70)
print("\n■ schema.sql 缺失的表:", sorted([t for t in v227 if t not in sch]) or "无")
for t in sorted(set(v227) & set(sch)):
    miss = [c for c in v227[t] if c not in sch[t]]
    if miss:
        print(f"  - {t}: schema.sql 缺 {', '.join(miss)}")

print("\n■ 本地 v2.2.7 库全部表:", len(v227), "张 | 线上影子表:", len(online), "张 | v2.2.5库表:", len(v225), "张 | schema.sql表:", len(sch), "张")
