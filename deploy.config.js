// deploy.config.js — Cloudflare Pages/Workers 部署配置(通用)
//
// GitHub Actions 工作流(.github/workflows/pages-deploy.yml)会读取此文件,
// 自动设置部署参数并动态生成 wrangler.toml。只需修改此文件, 无需改动工作流。
// 本文件是项目名/数据库等部署配置的**唯一来源** —— wrangler.toml 完全由 CI
// 按本文件动态生成(填入实际 D1 database_id 等), 项目**无需携带**静态
// wrangler.toml; 本地手动部署如需要, 参考文末说明现场生成即可。
//
// 规则(与生产验证工作流 upload/next-deploy.zip 同源同语义):
//   - projectName: 必填, 为空则工作流报错退出(wrangler.toml 的 name 也取自这里)
//   - deployType: 'pages' | 'workers'
//       pages   → OpenNext + 自研适配层(pages-adapter/worker.ts) → dist-pages/
//                 (高级模式 _worker.js + 静态资源) → wrangler pages deploy(*.pages.dev)
//       workers → OpenNext 产物直出(以 pages-adapter/worker.ts 为 main, 注入
//                 D1/KV/R2 绑定) → wrangler deploy(*.workers.dev)
//       可用仓库 Variable DEPLOYTYPE 覆盖
//   - database: 布尔开关, 门控是否执行 D1 数据库操作(建库/建表/推送 schema/绑定注入)。
//       true  → 启用 D1 全链; false / 省略该字段 → 跳过全部 D1 步骤, 仅部署站点代码。
//       注意: 本地 SQLite 数据库文件的路径/名称**不在这里配置**, 唯一真源 = .env
//       的 DATABASE_URI(file:./prisma/bot-groups.db), 本地运行/CI 构建期均从 .env 统一读取
//       (TGuard 数据层双形态: Node 形态用 node:sqlite 读该文件, Cloudflare 形态用 D1 绑定)。
//   - d1Name / kvName / r2Name: 可选, 云端资源名称; 留空自动使用 projectName。
//     启用 database 后 CI 自动: ① 创建/复用 D1 ② 应用幂等 schema(prisma/schema.sql
//     经 IF NOT EXISTS 归一, 对已有库零副作用) ③ 绑定注入。
//     kvName/r2Name 与 database 开关相互独立(留空 = 不创建不绑定,
//     KV 缓存自动降级内存实现, R2 资源存储降级本地 .data/storage)。
//   - d1Id / kvId: 可选; 留空则工作流自动查找同名资源/创建并解析 ID,
//     解析结果自动用于后续步骤, 无需手动回填。
//   - accountId: 可选; 探测优先级 CLOUDFLARE_ACCOUNT_ID secret > 此处 > API Token 自动探测
//
// 读取方式(工作流内联, 以 data:URL 强制 ESM 语义解析本文件 —— 项目有无
// "type":"module" 均可, 无需任何配套脚本)。两件套部署 = 本文件 +
// .github/workflows/pages-deploy.yml。
//
// ⚠ data:URL 兼容约束: 本文件被工作流以 data:text/javascript;base64 形式
// import(), 此时 import.meta.url 是不透明的 data: URL —— **禁止**使用
// import.meta.url / new URL(相对路径, import.meta.url) 等基于模块自身
// URL 的表达式(会抛 "Invalid URL" 炸掉配置读取)。相对路径一律基于
// process.cwd()(GitHub Actions 与本地手动执行时均为项目根目录)。

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// 全局唯一版本号: 动态取 package.json 的 version 字段, 禁止硬编码
const version = pkg.version;

const deployConfig = {
  version,

  // Cloudflare Pages/Workers 项目名称(必填; 动态生成的 wrangler.toml name 也取自这里)
  projectName: pkg.name,

  // 部署类型: 'pages' | 'workers'(可用 repo Variable DEPLOYTYPE 覆盖)
  deployType: 'pages',

  // 是否执行 D1 数据库操作(布尔开关):
  //   true  = 启用 D1: 建库 + schema 建表 + 绑定注入
  //   false / 省略该字段 = 跳过全部 D1 数据库步骤, 仅部署站点代码
  // 本地 SQLite 数据库文件的路径/名称唯一真源 = .env 的 DATABASE_URI(不在这里配置)
  database: true,

  // D1 数据库云端名称(可选, 留空自动使用 projectName; 与既有线上库同名以复用数据)
  d1Name: `${pkg.name}-db`,

  // KV 命名空间名称(可选, 留空则不绑定 KV; 未使用 KV 的项目留空即可)
  kvName: `${pkg.name}-kv`,

  // R2 存储桶名称(TGuard 扩展字段; 留空 = 不创建 / 不绑定 R2,
  // 媒体存储自动降级本地 .data/storage; 首次开通 R2 需在 Cloudflare
  // Dashboard 绑定支付方式, 否则 API 返回 [code: 10042])
  r2Name: `${pkg.name}-store`,

  // D1 数据库 ID(可选; 留空则工作流自动查找同名库/创建并解析 ID,
  // 解析结果自动用于 schema 推送, 无需手动回填)
  d1Id: '',

  // KV 命名空间 ID(可选, 留空则工作流会尝试通过 wrangler kv namespace create 创建)
  kvId: '',

  // Cloudflare 账号 ID(可选)
  // 探测优先级: CLOUDFLARE_ACCOUNT_ID secret > 此 accountId > 自动用 API Token 探测
  accountId: '',
};

export default deployConfig;

// GitHub Actions 所需 secrets(在仓库 Settings → Secrets and variables → Actions 配置):
//   CLOUDFLARE_API_TOKEN     — 必填, 部署权限(需 Pages:Edit + D1:Edit + Workers KV Storage:Edit
//                              + Workers R2 Storage:Edit + Account Settings:Read)
//   CLOUDFLARE_ACCOUNT_ID    — 可选, 账号 ID(单账号 Token 可留空自动探测)
//   TELEGRAM_WEBHOOK_SECRET  — 可选, /api/telegram/webhook 校验密钥(与本地 .env 一致)
//   ADMIN_SECRET / JWT_SECRET — 可选(历史遗留; TGuard 登录鉴权存于数据库, 不依赖这两个 secret,
//                              已配置的项目会原样保留注入, 不配置也不报错)
//
// 本地手动部署(可选, CI 部署无需此步):
//   npx wrangler pages project create <projectName> --production-branch main
//   npx opennextjs-cloudflare build && node scripts/build-pages-adapter.mjs
//   npx wrangler pages deploy dist-pages --project-name <projectName>
//   (如需 wrangler.toml, 按 CI 生成结构手写: name/pages_build_output_dir=
//    dist-pages/compatibility_date>=2025-05-01/compatibility_flags=["nodejs_compat"])
