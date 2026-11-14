-- ============================================================================
-- TGuard v3.0.1 版本化增量（合并 v3.0.0 + v3.0.1，SQLite / Cloudflare D1 共用）
-- ----------------------------------------------------------------------------
-- 合并原因（2026-11-14）：package.json 版本为 3.0.1，部署工作流固定只检测
-- sql-upgrade-v3.0.1.sql；v3.0.1 的「机器人工厂」菜单插入依赖 v3.0.0 创建的
-- menus id=900000001，若线上 D1 从未成功应用 v3.0.0 会静默丢失数据。
-- 合并后本文件可从任意 ≥v2.3.5 的旧库一步无损升到 3.0.1，且整文件幂等可重跑
-- （CREATE 全部 IF NOT EXISTS；字典数据全部守卫式 INSERT OR IGNORE + WHERE EXISTS）。
-- 结构定义与 prisma/schema.sql 目标结构逐列一致。
--
-- == v3.0.0 部分：独立通用机器人模型配置模块 ================================

CREATE TABLE IF NOT EXISTS model_event_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER, name TEXT NOT NULL, source_type TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'private', chat_id TEXT, config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_triggers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER, event_entry_id INTEGER, name TEXT NOT NULL,
 trigger_type TEXT NOT NULL, match_json TEXT NOT NULL DEFAULT '{}', workflow_id INTEGER,
 permission_ids_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_workflows (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER, name TEXT NOT NULL, description TEXT,
 nodes_json TEXT NOT NULL DEFAULT '[]', entry_node_id TEXT, permission_ids_json TEXT NOT NULL DEFAULT '[]',
 enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_permissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER, name TEXT NOT NULL, permission_type TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'private', config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_execution_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER, event_entry_id INTEGER, trigger_id INTEGER, workflow_id INTEGER,
 scope TEXT NOT NULL DEFAULT 'private', chat_id TEXT, user_id TEXT, status TEXT NOT NULL,
 current_node_id TEXT, input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT NOT NULL DEFAULT '{}',
 error_text TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_model_events_bot ON model_event_entries(bot_id, enabled);
CREATE INDEX IF NOT EXISTS idx_model_triggers_event ON model_triggers(event_entry_id, enabled);
CREATE INDEX IF NOT EXISTS idx_model_triggers_type ON model_triggers(trigger_type, enabled);
CREATE INDEX IF NOT EXISTS idx_model_workflows_bot ON model_workflows(bot_id, enabled);
CREATE INDEX IF NOT EXISTS idx_model_permissions_bot ON model_permissions(bot_id, enabled);
CREATE INDEX IF NOT EXISTS idx_model_logs_created ON model_execution_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_logs_workflow ON model_execution_logs(workflow_id, created_at DESC);

-- 使用保留的高位 ID，避免首次部署时 D1 先执行迁移、后导入本地数据库种子数据造成主键冲突。
INSERT OR IGNORE INTO permissions(id,code,name,description,sort_order)
 SELECT 900000001,'model-config:view','查看模型配置','查看事件入口、触发器、工作流、权限和运行日志',60
 WHERE EXISTS (SELECT 1 FROM permissions WHERE code='bots:view');
INSERT OR IGNORE INTO permissions(id,code,name,description,sort_order)
 SELECT 900000002,'model-config:manage','管理模型配置','创建、编辑、删除通用机器人模型配置',61
 WHERE EXISTS (SELECT 1 FROM permissions WHERE code='bots:manage');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000001,0,'模型配置','','🧩',5,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE parent_id=0 AND title='机器人');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000002,900000001,'事件入口配置','/admin/model-config/events','📥',1,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001) AND NOT EXISTS (SELECT 1 FROM menus WHERE path='/admin/model-config/events');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000003,900000001,'触发器配置','/admin/model-config/triggers','⚡',2,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001) AND NOT EXISTS (SELECT 1 FROM menus WHERE path='/admin/model-config/triggers');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000004,900000001,'工作流配置','/admin/model-config/workflows','🔀',3,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001) AND NOT EXISTS (SELECT 1 FROM menus WHERE path='/admin/model-config/workflows');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000005,900000001,'权限配置','/admin/model-config/permissions','🔐',4,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001) AND NOT EXISTS (SELECT 1 FROM menus WHERE path='/admin/model-config/permissions');
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000006,900000001,'运行日志','/admin/model-config/logs','📜',5,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001) AND NOT EXISTS (SELECT 1 FROM menus WHERE path='/admin/model-config/logs');
INSERT OR IGNORE INTO role_permissions(role_id,permission_id) SELECT rp.role_id,p.id FROM role_permissions rp JOIN permissions oldp ON oldp.id=rp.permission_id JOIN permissions p ON p.code='model-config:view' WHERE oldp.code='bots:view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_id) SELECT rp.role_id,p.id FROM role_permissions rp JOIN permissions oldp ON oldp.id=rp.permission_id JOIN permissions p ON p.code='model-config:manage' WHERE oldp.code='bots:manage';

-- == v3.0.1 部分：机器人工厂独立装配配置表，不影响现有 bots 与机器人运行链路 ==

CREATE TABLE IF NOT EXISTS bots_factory (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 bot_id INTEGER,
 config_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'draft',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bots_factory_updated ON bots_factory(updated_at DESC,id DESC);

-- 机器人工厂位于「模型配置」下，并排在原有第一个二级菜单之前。
INSERT OR IGNORE INTO menus(id,parent_id,title,path,icon,sort_order,visible,permission_code,status,created_time,updated_time)
 SELECT 900000007,900000001,'机器人工厂','/admin/bots-factory','🏭',0,1,'model-config:view',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
 WHERE EXISTS (SELECT 1 FROM menus WHERE id=900000001);
