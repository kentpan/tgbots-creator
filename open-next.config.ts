// OpenNext → Cloudflare 适配配置(@opennextjs/cloudflare)。
// 直接采用生产环境验证过的默认配置(upload/next-deploy.zip 同源同值):
// 空配置 = 不启用 R2 增量缓存/DO 队列等可选组件, 产物为
// .open-next/worker.js(worker 入口) + .open-next/assets/(静态资源)。
// CI 由 .github/workflows/pages-deploy.yml 调用 opennextjs-cloudflare build 消费本文件。
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
