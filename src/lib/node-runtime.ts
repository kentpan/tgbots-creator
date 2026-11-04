/**
 * Node / Edge 双形态运行时工具。
 *
 * 背景（2026-11-04 GitHub Actions 实测）：
 * Turbopack 把源码中静态 import 的 "node:fs"/"node:path"/"node:crypto" 编译为
 * external require；Edge bundle（Cloudflare Pages 产物，含构建期 collect page
 * data 的模块求值）一旦触达即 "Native module not found: node:<id>" 构建失败。
 *
 * 本模块提供两件事：
 *  1. isEdgeRuntime —— 显式运行时形态判断（Turbopack 按 bundle 内联
 *     NEXT_RUNTIME：Edge bundle 恒为 "edge"，Node bundle 恒为 "nodejs"），
 *     与 instrumentation.ts 既有防御范式一致。
 *     v1.1.5 起补充 Cloudflare Workers(workerd) 判定 —— 迁移到 OpenNext
 *     (@opennextjs/cloudflare) 部署后，全部服务端代码运行于 workerd 的
 *     nodejs_compat 环境，NEXT_RUNTIME 恒为 "nodejs"，但 workerd 依旧没有
 *     可用文件系统（config.toml/.env 均不可读）。workerd 运行时会将
 *     navigator.userAgent 固定为 "Cloudflare-Workers"（官方 Runtime API 文档），
 *     以此识别 OpenNext/workerd 形态并走与 Edge 完全相同的分支：
 *     无 FS 读取、bot 走 Webhook 传输、数据层走 D1/KV/R2 绑定。
 *     构建期（CI Node 22）navigator.userAgent 为 "Node.js/xx" 不会误判；
 *     本地 bun/node dev 同样不命中。
 *  2. requireNodeBuiltin —— 运行时同步获取 Node 内置模块（见下方函数注释）。
 */
export const isEdgeRuntime =
  process.env.NEXT_RUNTIME === "edge" ||
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");

/**
 * 运行时同步加载 Node 内置模块。
 *
 * 实现约束（2026-11-04 Turbopack 构建实测）：
 *  - 不能静态 import："node:fs" 等会被编译为 external require，Edge bundle
 *    模块求值时 "Native module not found" 直接炸构建；
 *  - 不能用 eval：Turbopack 对 Edge bundle 做静态 Dynamic Code Evaluation
 *    检测，源码中出现 eval() 调用即构建报错（不求值也报）；
 *  - new Function 的函数体在全局作用域执行，拿不到 CJS 模块包装内的局部
 *    require —— 借助 process.mainModule.require（CJS 入口模块的完整 require）
 *    实现同步加载。Node 形态（next dev / next build / standalone server 均为
 *    CJS 入口）下该路径稳定可用；Edge 形态无 process.mainModule，显式抛出
 *    详细错误（调用点已由 isEdgeRuntime 分支保护，正常路径不会触达）。
 */
export function requireNodeBuiltin<T = unknown>(id: string): T {
  const loader = new Function(
    "id",
    "if (typeof process !== 'undefined' && process.mainModule && " +
      "typeof process.mainModule.require === 'function') { " +
      "return process.mainModule.require(id); } " +
      "throw new Error('[node-runtime] 无法同步加载 ' + id + " +
      "'：process.mainModule.require 不可用。Edge 形态不应触达此路径" +
      "（调用点必须用 isEdgeRuntime 分支保护），请检查对应模块。');",
  ) as (id: string) => T;
  return loader(id);
}
