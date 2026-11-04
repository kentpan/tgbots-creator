/**
 * pages-adapter/worker.ts — TGuard 自研 Pages 高级模式适配层入口。
 *
 * 直接采用生产验证工作流(upload/next-deploy.yml, gem-td 同源)的适配层范式:
 *   ① 绑定同步注入 —— D1/KV/R2 绑定必须经入口 fetch(request, env, ctx) 注入
 *      globalThis(TGuard 约定通道: DATABASE / KV / BUCKET, 见
 *      src/database/client.ts resolveD1FromGlobals 与 bindings.ts),
 *      因为 OpenNext 产物直出时 instrumentation 阶段的
 *      getCloudflareContext 拿不到 ALS 上下文(gem-td v8.9.2 实测),
 *      不注入则服务端初始化期读库会降级到 node:sqlite 临时库。
 *      注入先于 OpenNext handler 首次调用 —— Next 服务端(含 instrumentation)
 *      在首次 fetch 内初始化, 届时 globalThis 已就绪。
 *   ② 其余请求原样转交 OpenNext handler(worker.js 内置路由:
 *      静态资源经 env.ASSETS 兜底, 动态路由走 Next 服务端)。
 *
 * 部署形态:
 *   - deployType=pages:  经 scripts/build-pages-adapter.mjs 以 esbuild 打包为
 *     dist-pages/_worker.js(Pages 高级模式入口, 相对导入 .open-next/worker.js
 *     全树进 bundle, .open-next 位于部署目录之外不泄漏为静态资源)。
 *   - deployType=workers: wrangler deploy 直接以本文件为 main
 *     (wrangler.toml 由 CI 动态生成), 行为与 Pages 形态完全同一管线。
 *
 * 本文件不参与 tsc/next 类型检查(导入对象为构建期生成 JS, 见 tsconfig exclude),
 * 由 wrangler/esbuild 管线编译。
 */

interface WorkerEnv {
  DATABASE?: unknown;
  KV?: unknown;
  BUCKET?: unknown;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  [key: string]: unknown;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface OpenNextWorker {
  fetch(
    request: Request,
    env: WorkerEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> | Response;
}

import opennextWorker from "../.open-next/worker.js";

const handler = opennextWorker as OpenNextWorker;

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    // 幂等注入(不覆盖既有值): workerd isolate 内 env 绑定对象稳定,
    // 首次注入后全局可用; isolate 重建时 globalThis 清空, 重新注入。
    const globals = globalThis as unknown as Record<string, unknown>;
    if (env.DATABASE && globals.DATABASE === undefined) globals.DATABASE = env.DATABASE;
    if (env.KV && globals.KV === undefined) globals.KV = env.KV;
    if (env.BUCKET && globals.BUCKET === undefined) globals.BUCKET = env.BUCKET;

    return handler.fetch(request, env, ctx);
  },
};
