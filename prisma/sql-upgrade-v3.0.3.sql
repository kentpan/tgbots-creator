-- ============================================================================
-- TGuard v3.0.4 版本化增量（SQLite / Cloudflare D1 共用）
-- ----------------------------------------------------------------------------
-- CI（pages-deploy.yml）与打包脚本（scripts/package.mjs）按
-- prisma/sql-upgrade-v${package.json.version}.sql 精确匹配本文件，
-- 因此升级 SQL 必须放在与本版本号同名的文件中。
-- 整文件幂等：裸 ALTER 的幂等由 scripts/d1-upgrade-filter.mjs 保证
-- （远端列已存在时自动剔除），本地 SQLite 由 ensureAppSchema 列探测保证。
-- 结构定义与 prisma/schema.sql 目标结构逐列一致。
--
-- == v3.0.4 部分：邀请链接分享时长/次数 + 创建时群组私密/公开快照 ==========
-- expire_date（ISO 文本，NULL=不限时长）、member_limit（NULL=不限次数）、
-- chat_is_private（1=私密群 0=公开群，创建/编辑时快照，NULL=旧数据未知）。
ALTER TABLE invite_links ADD COLUMN expire_date TEXT;
ALTER TABLE invite_links ADD COLUMN member_limit INTEGER;
ALTER TABLE invite_links ADD COLUMN chat_is_private INTEGER;
