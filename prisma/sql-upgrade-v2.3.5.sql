-- v2.3.5：群组私有审核策略（SQLite / Cloudflare D1）
-- NULL 表示历史群组尚未显式选择策略，可兼容回退旧机器人默认值。
ALTER TABLE group_settings ADD COLUMN join_verify_mode TEXT;
ALTER TABLE group_settings ADD COLUMN join_verify_method_id INTEGER;
