# TGuard (tgbots-creator)

Telegram 群组验证机器人 TGuard 的 Next.js 全栈复刻版：Web 验证页（Mini Web App）、外部验证 API、grammY Bot（含 `@grammyjs/menu` 菜单）、RBAC 管理后台，且同时适配 **Node（node:sqlite）** 与 **Cloudflare Pages/Workers（D1 + KV + R2）** 双运行时。

## ✨ 特性

- 🔐 加群验证：新成员申请 → Bot 发送验证入口 → 通过后自动批准入群
- 🌐 Mini Web App：`/verify?token=...` 人机验证页（hCaptcha / Cap.js / Cloudflare Turnstile）
- 🔧 自定义验证方式：用户回复验证码，Bot 以 `Authorization: Bearer <apikey>` 请求外部 API 核验
- 🛡️ RBAC 管理后台：SSR 登录态鉴权、角色/权限/菜单/用户管理、操作日志、数据库备份；菜单树状层级编辑（树状下拉选父级、读取/编辑两档权限、删除二次确认）
- 📤 媒体上传：设计器中图片/视频地址一键上传（原生本机存储 / Cloudflare R2 双模式），回填公网 URL 并经 `/api/media/*` 提供访问
- 🗄️ 双运行时数据层：`node:sqlite` ↔ Cloudflare D1 自动探测，KV 缓存与 R2 存储自动降级
- 🤖 grammY + `@grammyjs/menu`：`/start` 菜单、统计面板、动态管理按钮、webhook/长轮询双模式
- 🧪 机器人测试（v1.0.8）：仿真屏复用真实验证管道，模拟加群申请 → 回复卡密 → 外部 API 核验 → 自动批准全流程；「模拟加群申请」弹窗式配置验证 API（URL / Bearer Key / GET·POST / 卡密字段名 code·card·key / 响应判定），配置保存后仿真与真实验证共用；支持导入闲鱼商品（GET/POST + 自定义参数名）、模拟发货获取测试验证码（含完整请求/响应日志）
- 🎫 验证码发码/验码开放 API（v1.0.8）：`/api/verify-codes/issue` 与 `/api/verify-codes/verify`（`Authorization: Bearer <apikey>`），响应契约 `{success, msg, data}`，便于与发卡/交付系统对接
- 🔁 同 Token 多机器人条目（v1.0.8）：同一 Bot Token 可建「交付机器人」「加群验证机器人」等多个管理条目，轮询实例自动去重
- 🧠 AI 配置中心（v1.1.0）：多 AI 提供方 CRUD + 分页列表（OpenAI 兼容协议），配置 API 与 Token 后一键拉取支持的模型列表；模型选择第一项恒为 auto（自动选择），可指定具体模型并设置默认 AI 模型；接口限速（滑动窗口，如 60 次/60s）；AI 模型调用统计分析（chart.js：每日调用趋势、模型分布、场景分布、成功率与 Tokens 汇总）；AI 模型下拉浮层组件供所有 AI 功能（如客服机器人）统一选型
- 🤖 AI 客服机器人（v1.1.0）：任意机器人一键开启 AI 自动回复，支持触发范围（仅私聊 / 私聊+群内@ / 全部消息）与自定义系统提示词，多轮上下文存于 session
- 💾 BOT 数据存储一键切换（v1.1.0）：grammY session 外部存储适配器（官方外部存储解决方案），系统设置一键 switch 切换 内存 / SQLite / Cloudflare D1 / Cloudflare R2；D1/R2 在 Cloudflare Pages（edge）自动探测绑定，Node 走 REST API（D1 query API / R2 S3 兼容 API + SigV4），支持连通性往返测试；每个机器人可单项覆盖
- 🔌 grammY 插件开关（v1.1.0）：机器人表单内置 auto-retry（429/5xx 自动重试）与 transformer-throttler（发送限速排队）官方插件开关，会话存储单项覆盖（inherit/memory/sqlite/d1/r2）
- 🧩 统一真实群组获取（v1.1.1）：编辑机器人弹窗与机器人测试页共用 `useRealGroups` Hook + `/api/admin/telegram/real-groups`（getUpdates + 数据库关联 + getChat 三源合并）；打开页面/弹窗只读数据库已登记群组（零 Telegram 请求），点「同步真实群组」才实时校验；S3 兼容对象存储后端与 R2/S3 自定义 CDN 域名配置；打包脚本修复 WAL checkpoint（进程内执行 + 重试，杜绝包内数据库缺数据）
- 🎛️ 官方菜单插件（v1.1.1）：消息内嵌按钮 100% 基于 grammY 官方 `@grammyjs/menu`（回调路由/子菜单导航/过期键盘自动恢复/自动应答全由插件处理）；管理后台「同步到群组」走官方公开 API `menu.render(ctx)` 序列化；Telegram WebApp SDK 全站按需加载（仅 URL 带 `tgWebAppData` 的真实 Mini App 环境注入，浏览器访问不再出现假 WebApp 与版本警告）；修复加群仿真 `UNIQUE constraint failed: verification_methods.name`（按名称复用全局验证方式并绑定群组）；全链路静默错误清理：机器人启动/重启/资料同步/会话恢复失败全部带详细错误暴露到日志，不再静默吞错
- 🌐 网络波动零惩罚 + 失效自动恢复（v1.1.2）：验证接口连接级网络错误（fetch failed/DNS/连接被拒）服务端自动重试 3 次（间隔 1s），全部失败才回复「网络异常，请稍后重试」，bot 路径重试前先回复「🌐 网络波动，正在重试...」；网络/超时/验证接口 5xx 一律不计入用户尝试次数（不再因网络波动误踢用户，数据库实测 attempts 恒为 0）；验证失效（尝试次数用尽）后仿真屏输入框位置自动恢复「申请加入群组」按钮、真实群组自动回复 `createChatInviteLink(creates_join_request)` 入群申请链接按钮「🔄 申请加群」，点击即可重新走完整验证流程
- 🔒 验证隐私红线 + 直连入群防线（v1.1.3）：① 群组零验证消息——仿真屏「同步到群组」开关整体移除（仿真动作只停留在仿真屏），移除加群申请处理中私聊不可达时的群内兜底消息，验证提示/结果只通过机器人私聊发送；② 直连入群防线——普通邀请链接/被拉入群绕过审批直接进群的成员自动触发私聊补验证（`chat_member` handler + 轮询显式 `allowed_updates`），验证失败（尝试次数用尽）或超时未验证自动踢出群组（ban+unban，可重新申请），经机器人审批入群（`via_join_request`）与管理员不触发；③ `/start` 深链入口 `t.me/<bot>?start=join_<chatId>` 发送入群申请按钮 + 有未完成会话时重发验证提示（覆盖「先申请后点开始」的用户）；④ 验证接口响应无法识别时严格拒绝（绝不默认放行），一键部署指引加防呆警告（只准分享入群申请链接）
- 🧹 孤儿群组关联根治（v1.1.3）：删除群组时同步清理 `group_bot_admins` 关联行（此前只删 `group_settings`，关联残留导致测试页下拉反复出现已删除的裸 ID 群组）；「同步真实群组」实测确认机器人已不在群（left/kicked）或群不存在（400）时自动移除失效关联行，网络错误/超时一律不删防误删；修复测试页群组合并时空标题覆盖真实群名的问题
- 🎯 审批按群解析受理机器人（v1.1.3）：验证通过/拒绝/超时清理/私聊欢迎语不再固定使用主 bot token（主 bot 未配置或不在群时审批必失败、用户永远进不了群），改为按 `group_bot_admins × bots` 解析该群实际受理的启用 bot（取最新关联），找不到才回落主 bot；无可用 token 时抛出带场景/chatId/userId 的详细错误，绝不静默
- 📡 轮询自愈与短轮询（v1.1.3）：主 bot 与菜单 bot 长轮询统一接入 grammY 官方「错误自动重启」模式（`bot.start()` 的 rejection 官方文档要求调用方捕获，否则机器人永久停止无人恢复）——每次失败完整记录错误后按 3s 间隔自动重启，仅 401（token 永久无效）与实例被替换时不重启；getUpdates 轮询窗口取 0（短轮询，Telegram 官方合法参数），消除持连接长轮询在中转/受限网络下被随机掐断导致「bot 已启动却收不到任何更新」的问题
- 🪝 Webhook 全链路修复（v1.1.4）：①「Webhook Base URL 留空保存时自动取当前站点地址」真正生效——反代链路（TLS 在最外层入口终结 + Caddy `{scheme}` 覆盖 X-Forwarded-Proto）导致应用侧恒见 http，现按「非本地主机自动还原公网 https → 仍不可用则回退已保存公网地址」确定性推导，留空保存不再误报「必须是公网 https:// 地址」；② webhook 实例处理更新前先 `bot.init()`（grammY 官方要求，`handleUpdate` 依赖 botInfo），修复服务器以 webhook 模式直接拉起的全新实例首条更新必抛 "Bot not initialized"；③ 菜单 bot 私聊 `/start`、`/menu` 修复——全局 `mainMenu` 只安装在主 bot（@grammyjs/menu 官方约束：Menu 实例只能发给安装它的 bot），改为实例通过 `ctx.botMenu` 注入自己配置的菜单，主 bot 行为不变；④ 全链路实测：签名回调校验（错签名 401）、Telegram `getWebhookInfo` 注册/注销、模拟 update 端到端处理（中间件链 → 指令 → 菜单发送）全部通过
- 🐟 闲鱼发卡平台默认域名切换（v1.1.4）：外部验证/发货测试默认地址全部由 `xianyu-admin.pages.dev` 切换为 `https://xianyu.mfzl.cn`（模拟加群验证 API、模拟发货接口、测试页默认值与占位符、数据库验证方式配置），实测新域名直连 3s 内响应，验证通过 → 自动批准入群全流程 E2E 复测通过
- 🛠️ 验证交互三连修复（v1.1.4）：① 私聊第二次输码无响应根治——Telegram 隐私模式只作用于群聊，私聊「必须回复机器人消息」的门槛整体移除，验证会话存续期间私聊任何文本都会进入校验并必有回音；② 验证提示消息裸显 HTML 根治——stateless-question 隐形后缀（`<a href="http://t.me/#tgcode#">` 锚点）此前漏传 `parse_mode=HTML` 导致原样裸显，现按官方 `replyWithHTML` 同款以 HTML 模式发送并禁用 t.me 链接预览卡片，真实 Telegram API 实测可见文本干净、回复匹配实体完好；③ 超时不再静默——验证清理循环与主 bot 解耦（此前主 bot 未配置或全局 webhook 模式时清理循环永不启动，超时会话无人处理），过期会话处理时私聊发送「⏰ 验证超时…已拒绝申请/已移出群组」+「🔄 申请加群」按钮让用户一键重新发起，回复已失效的验证提示也会得到「已完成/已失效」明确反馈（无按钮不弹、绝不石沉大海）

## 🚀 快速开始

```bash
bun install
bun run db:init     # 建表 + 写入种子数据（超级管理员 admin / admin123）
bun run dev         # http://localhost:3000（端口取自 .env 的 PORT）
```

`.env`（全局唯一数据源与端口配置）：

```env
PORT=3000
DATABASE_URI=file:./prisma/tgbots-creator.db
```

- 管理后台：`/admin`（默认账号 `admin` / `admin123`）
- 验证首页：`/`；验证页：`/verify?token=...`
- 健康检查：`/health`、`/health/detailed`

Bot 配置沿用 TGuard 的 `config.toml`（token、验证码密钥、管理员 ID 等），运行期参数（超时、Base URL、验证码驱动、保留天数）可在后台「系统设置」覆盖。

## 🗄️ 双运行时自动适配

`src/database/client.ts` 按环境自动选择 SQL 数据层：

| 运行时 | SQL | 缓存 | 对象存储 |
| --- | --- | --- | --- |
| Node.js | `node:sqlite`（`DATABASE_URI`，默认 `file:./prisma/tgbots-creator.db`） | 内存 KV | 本地 `.data/storage` |
| Cloudflare | D1 绑定 `DATABASE` | KV 绑定 `KV` | R2 绑定 `BUCKET` |

D1/KV/R2 绑定自动从 `globalThis`、`process.env` 或 `@cloudflare/next-on-pages` 请求上下文探测，业务代码零改动。

## 🤖 Telegram Bot

- 传输模式（v1.1.4）：由「系统设置 → 传输模式」决定，`auto`（Node=轮询 / Edge=Webhook）、`轮询`、`Webhook` 三选一，保存后立即应用到全部机器人；**用户的全局配置永远优先，系统绝不擅自切换**
- Webhook 模式：`instrumentation.ts` 启动时仅调用 `setWebhook` 注册回调（经全局 Telegram 代理出站），本进程不轮询；Telegram 回调入口 `POST /api/telegram/webhook/<botId>`（`botId` 为机器人数字 id 或 `main`，`x-telegram-bot-api-secret-token` 签名头确定性派生强校验）；注册失败（如 Webhook Base URL 不可被 Telegram 公网可达）会在启动日志完整报错，绝不静默回退轮询
- Node 长轮询：`instrumentation.ts` 在服务启动时拉起（需配置 `config.toml` 的 token）
- 菜单：`@grammyjs/menu` 实现 `/start` 主菜单、📊 统计信息子菜单（动态刷新/返回/关闭）、管理员 API 信息按钮
- AI 客服（v1.1.0）：机器人表单开启后自动回复用户提问，模型从「AI 配置」下拉浮层选择（auto = 系统默认模型），历史上下文经 session 持久化到配置的存储后端
- 会话外部存储（v1.1.0）：`src/bot/session-storage.ts` 实现 grammY StorageAdapter（SQLite/D1/R2），系统设置一键切换，bot_sessions 表自动建表

### AI 配置（v1.1.0）

后台「AI 配置」菜单（位于操作日志之前）：

- 模型配置：多提供方 CRUD + 分页（名称 / Base URL / API Key / 指定模型 / 限速 / 默认 / 启用）
  - Base URL 填到 OpenAI 兼容版本根（如 `https://api.deepseek.com/v1`），支持「探测模型列表」一键拉取 `/models`
  - 指定模型第一项恒为 auto（自动选择探测列表第一个），可指定具体模型
  - 接口限速：滑动窗口（如 60 次/60s），超限快速失败并提示重试等待
  - 「设为默认」：客服机器人等未显式指定模型时使用
- 调用统计：chart.js 图表（每日成功/失败趋势 + Tokens 折线、模型分布环形图、场景分布、提供方调用量、最近失败明细）

### 自定义验证方式（验证码 + 外部 API）

1. 后台「验证方式」创建方法，配置 JSON：

```json
{
  "url": "https://api.example.com/members/verify",
  "api_key": "sk-your-apikey",
  "http_method": "POST",
  "body_template": "{\"user_id\":{{user_id}},\"code\":\"{{code}}\"}",
  "success_status": 200,
  "success_field": "valid",
  "success_value": "true",
  "timeout_seconds": 10
}
```

2. 后台「群组管理」为群组绑定该方法并启用（也可直接在「机器人测试 → 模拟加群申请」弹窗中配置，自动保存到群组绑定的验证方式）
3. 用户申请加群 → Bot 让其回复验证码 → Bot 携带 `Authorization: Bearer <api_key>` 调用外部 API → 按响应判定并自动批准/拒绝（可配置最大尝试次数）
4. 卡密字段兼容：请求体/查询参数中承载卡密的字段名支持 `code / card / key`（验证码 API 同样兼容）；验证失败时外部 API 返回的 `msg/error/message` 原因会透传给用户

## 🔌 API

- `POST /api/v1/verify` — 提交验证
- `GET /api/v1/verification-status/{token}` — 查询验证状态
- `GET /api/v1/captcha-config` — 获取验证码前端配置
- `POST /api/verification/create` — 外部创建验证请求（`X-API-Key`）
- `POST /api/telegram/webhook` — Telegram 更新入口
- `POST /api/verify-codes/issue` — 测试验证码发码（`Authorization: Bearer <apikey>`，v1.0.8；鉴权失败 401）
- `POST /api/verify-codes/verify` — 测试验证码验码（`Authorization: Bearer <apikey>`，v1.0.8；卡密字段兼容 code/card/key，鉴权失败 401，响应契约 `{success, msg, data}`）
- `GET|POST /api/xianyu/products` — 内置演示闲鱼商品接口（`Authorization: Bearer <apikey>`，v1.0.8）
- `GET|POST /api/admin/bots/testing/join-request` — 机器人测试：模拟加群申请（管理员会话；GET 预读群组当前验证 API 配置，POST 携带 `api_config` 保存并发起）
- `POST /api/admin/bots/testing/submit-code` — 机器人测试：提交验证码（与真实流程同一管道）
- `POST /api/admin/xianyu/import` — 导入闲鱼商品（管理员会话）
- `POST /api/admin/xianyu/deliver` — 模拟发货（管理员会话）

发码/验码 API Key 存于 `app_settings.verify_codes.api_keys`（JSON 数组，默认 `sk-tguard-v108`，可在数据库或后台设置中修改）。

## ☁️ Cloudflare Pages 部署

仓库内置 `.github/workflows/pages-deploy.yml`，全流程：确保 Pages 项目 / D1 / KV / R2 存在（不存在自动创建，KV 失败仅告警不影响部署）→ 动态生成 `wrangler.toml` 绑定 → `npm ci` → `@cloudflare/next-on-pages` 构建（`NEXT_ON_PAGES=1` 时 next.config 自动关闭 standalone 输出）→ 部署 `.vercel/output/static`。部署参数收敛于 `deploy.config.js`（项目名自动读取 `package.json` 的 `name`，D1/KV/R2 资源名自动派生）。在 GitHub Secrets 配置 `CLOUDFLARE_API_TOKEN`（Pages:Edit + D1:Edit + R2:Edit，KV 可选）与 `ADMIN_SECRET` 后，push main 即自动发布。

> 📡 Telegram Bot API 连接：Node 环境默认通过管理后台「系统设置 → Telegram API 代理」访问 api.telegram.org（内置前缀代理，可改可关，保存立即生效）；Cloudflare Pages 部署天然直连，无需代理。

## 📋 管理后台

| 页面 | 权限点 |
| --- | --- |
| /admin 控制台 | dashboard:view |
| /admin/join-requests 加群申请 | requests:view / requests:manage |
| /admin/groups 群组管理 | groups:view / groups:manage |
| /admin/verification-methods 验证方式 | methods:view / methods:manage |
| /admin/users 系统用户 | users:view / users:manage |
| /admin/roles 角色权限 | roles:view / roles:manage |
| /admin/menus 菜单管理 | menus:view / menus:manage |
| /admin/settings 系统设置 | settings:view / settings:manage |
| /admin/logs 操作日志 | logs:view |
| /admin/bots/testing 机器人测试（v1.0.8） | bots:view |

内置角色：`super_admin`（全部权限）、`operator`（运营子集）。会话为 HttpOnly Cookie + 服务端会话表（SHA-256 散列存储），所有页面在服务端（RSC）完成登录态与权限校验。

## 🧰 常用脚本

```bash
bun run db:init      # 应用 prisma/schema.sql + 种子数据（幂等）
bun run db:export    # 导出最新 schema 到 prisma/schema.sql
bun run build        # 生产构建（standalone）
bun run start        # 以 .env 的 PORT 启动
bun run typecheck    # tsc --noEmit
```
