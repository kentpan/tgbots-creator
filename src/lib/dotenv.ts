/**
 * 运行时形态判断与 Node 内置模块同步加载。
 *
 * ⚠ 本文件位于 next.config.ts 的加载链上（next.config.ts 顶层调用 loadDotEnv），
 * 而 next.config 的转译加载器不支持 tsconfig 的 @/ 别名 —— 因此本文件
 * **不能 import 任何项目内模块**（含 src/lib/node-runtime），工具逻辑必须内联。
 * Edge bundle 的同名逻辑见 src/lib/node-runtime.ts。
 *
 * 背景（2026-11-04 GitHub Actions 实测）：Turbopack 把静态 import 的
 * "node:fs"/"node:path" 编译为 external require，本模块经 settings.ts 静态
 * 引用进入 Edge bundle，模块求值时 "Native module not found" 直接炸构建；
 * 运行时加载统一走 new Function + process.mainModule.require（同
 * src/lib/node-runtime.ts，eval 会被 Turbopack 的 DCE 静态检测直接报错），
 * bundle 中不含任何 node: 静态引用，Node 形态行为与静态 import 完全一致。
 * Edge 形态下所有 fs/path 调用点均被 isEdgeRuntime 分支保护。
 *
 * v1.1.5: 判定补充 Cloudflare Workers(workerd, OpenNext 部署)——workerd 下
 * NEXT_RUNTIME 恒为 "nodejs" 但依旧无文件系统（本文件不能 import 项目内模块,
 * 故内联与 src/lib/node-runtime.ts 同源的判定）: workerd 运行时将
 * navigator.userAgent 固定为 "Cloudflare-Workers", 命中即走 Edge 分支
 * (不查找 .env, 配置来自 Pages 环境变量与 D1)。
 */
const isEdgeRuntime =
  process.env.NEXT_RUNTIME === "edge" ||
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");

type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");

function requireNodeBuiltin<T>(id: string): T {
  const loader = new Function(
    "id",
    "if (typeof process !== 'undefined' && process.mainModule && " +
      "typeof process.mainModule.require === 'function') { " +
      "return process.mainModule.require(id); } " +
      "throw new Error('[dotenv] 无法同步加载 ' + id + " +
      "'：process.mainModule.require 不可用。Edge 形态不应触达此路径" +
      "（调用点必须用 isEdgeRuntime 分支保护），请检查对应模块。');",
  ) as (id: string) => T;
  return loader(id);
}

function fsModule(): FsModule {
  return requireNodeBuiltin<FsModule>("node:fs");
}

function pathModule(): PathModule {
  return requireNodeBuiltin<PathModule>("node:path");
}

let envBaseDir: string | null = null;

/**
 * Edge Runtime（Cloudflare Pages）没有文件系统，.env 也不是该形态的配置载体
 * （配置来自 Pages 环境变量与 D1）。因此 Edge 形态下不查找 .env 文件；
 * Node 形态行为不变（逐级向上查找，找不到才返回 null）。
 */
function findEnvFile(fileName: string): string | null {
  if (isEdgeRuntime) return null;
  const path = pathModule();
  const fs = fsModule();
  let current = path.resolve(process.cwd());
  for (;;) {
    const candidate = path.join(current, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function toAbsoluteFileUri(value: string, baseDir: string): string {
  if (!value.startsWith("file:")) return value;
  const path = pathModule();
  let target = value.slice("file:".length);
  let suffix = "";
  const queryIndex = target.indexOf("?");
  if (queryIndex >= 0) {
    suffix = target.slice(queryIndex);
    target = target.slice(0, queryIndex);
  }
  if (!target || path.isAbsolute(target)) return value;
  return `file:${path.resolve(baseDir, target)}${suffix}`;
}

export function loadDotEnv(fileName = ".env"): Record<string, string> {
  const envFile = findEnvFile(fileName);
  if (!envFile) return {};
  const baseDir = pathModule().dirname(envFile);
  envBaseDir = baseDir;
  let raw: string;
  try {
    raw = fsModule().readFileSync(envFile, "utf-8");
  } catch {
    return {};
  }
  const loaded: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "DATABASE_URI") {
      value = toAbsoluteFileUri(value, baseDir);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
    loaded[key] = process.env[key] ?? value;
  }
  return loaded;
}

export function getEnvBaseDir(): string {
  if (envBaseDir) return envBaseDir;
  const envFile = findEnvFile(".env");
  envBaseDir = envFile ? pathModule().dirname(envFile) : process.cwd();
  return envBaseDir;
}
