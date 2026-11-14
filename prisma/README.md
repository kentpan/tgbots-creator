# SQLite / Cloudflare D1 数据库迁移规范

本项目使用 SQLite（Node/本地运行）与 Cloudflare D1（线上 Edge 运行）。两者共享
`prisma/schema.sql` 作为当前目标结构定义；`prisma/` 目录不代表项目使用 Prisma Client。

## 版本化迁移规则（强制）

1. **每次发版先比较 schema。** 对比上一发布版本与本次 `prisma/schema.sql`、实际 SQLite
   `sqlite_master` 和 D1 目标结构。只要表、列、索引、触发器或视图发生新增、修改、删除，
   必须创建 `prisma/sql-upgrade-v<版本号>.sql`，其中版本号必须与 `package.json` 完全一致。
2. **无结构变化不创建空文件。** 仅业务代码、配置 JSON 或查询逻辑变化，不属于 schema 迁移。
3. **迁移文件只写增量。** 不得用全量 dump 覆盖线上数据。新增对象优先使用
   `IF NOT EXISTS`；数据更新使用明确的 `WHERE` 条件；迁移可能重跑时必须幂等。
4. **SQLite 与 D1 兼容。** 迁移 SQL 应使用两端共同支持的 SQLite SQL 子集。若某项操作两端
   不兼容，必须拆分并在工作流/本地迁移器中明确区分执行，不得静默跳过。
5. **破坏性变更先迁数据。** 删除/重命名列或表前，先新增目标结构、复制并校验数据、更新
   读写代码，确认回滚/备份策略后再清理旧结构。禁止直接删除仍有业务数据的字段。
6. **部署固定检测。** `.github/workflows/pages-deploy.yml` 根据 `package.json.version` 检测
   `prisma/sql-upgrade-v<版本号>.sql`：存在则应用到线上 D1；不存在则跳过。迁移执行失败必须
   使部署失败，不得继续发布半迁移版本。
7. **本地 SQLite 同步执行。** 发布/升级到 Node SQLite 实例时，必须在应用新代码前应用同一
   版本迁移脚本；不得只更新 D1 而遗漏本地 SQLite。执行后核对 `sqlite_master` 和关键数据行数。
8. **发版记录。** 每次 schema 变更在本文件追加版本、变更摘要、数据迁移说明和验证结果；
   无 schema 变更时记录“无 schema 变更”。
9. **测试要求。** 至少在旧版 SQLite 数据副本上测试迁移、重复执行测试（如声明幂等）、
   `PRAGMA integrity_check`、关键表行数/约束校验；D1 部署后检查结构与关键查询。
10. **敏感数据保护。** `sql-upgrade-v*.sql` 只能包含结构/必要的非敏感字典数据迁移，
    严禁写入 Token、密码、API Key、用户会话或真实用户个人数据。通用公开源码包不得携带
    生产 SQLite/全量 SQL dump；只有明确交付给数据所有者的私有升级包才可包含其数据库，
    且必须限制分发范围并提醒收件人按敏感备份保管。

## v2.3.3

- Schema：无结构变更；仅增加机器人 `/start` 欢迎文案的 `bots.config` JSON 配置字段。
- 数据迁移：无需 SQL；历史机器人缺少 `welcomeText` 时继续使用默认文案。
- 验证：配置读取采用可选字段回退，不增加 D1 读写或新增列。

## v2.3.3（继续迭代记录）

- Schema：无结构变更；本轮仅调整管理端编辑器布局、键盘编辑器状态同步及仿真屏组件边界。
- 数据迁移：无；不创建 `sql-upgrade-v2.3.3.sql` 空文件。
- 验证：对本轮修改的 TSX 文件执行 TypeScript `transpileModule` 语法诊断；完整 `tsc --noEmit` 因当前工作目录 `node_modules/@types` 安装不完整而无法完成，`npm ci` 在依赖下载阶段超时。
- 代码清理：移除已无引用的旧版 `TgApiMenuSimulator` 重复仿真实现；统一使用管理弹窗共用的 `TgSimulator` 与 `useDesignerSimChat` 状态机，避免维护两套不一致的 TGAPI 仿真流程。


## v2.3.5

- Schema：`group_settings` 新增 `join_verify_mode` 与 `join_verify_method_id`，将申请处理方式和验证方式绑定到群组。
- 数据迁移：两列新增时保持 NULL；历史群组在显式保存群组策略前继续兼容读取旧机器人级策略。关闭「新成员审核」不会清空这两列。
- 迁移文件：`prisma/sql-upgrade-v2.3.5.sql`，SQLite 与 D1 共用。
- 验证：本地 SQLite 副本执行迁移、重复执行预期报 duplicate column（工作流只执行一次）；应用层运行时 `ensureAppSchema` 使用列探测确保幂等补齐。
