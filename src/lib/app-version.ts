// 全局唯一版本源：package.json 的 version 字段。
// next.config.ts 构建时将其注入 NEXT_PUBLIC_APP_VERSION（前后端通用）；
// 环境变量缺失时回退为直接内联的 package.json。任何地方都不允许硬编码版本号。
import pkg from "../../package.json";

const injected = process.env.NEXT_PUBLIC_APP_VERSION;

export const APP_VERSION: string =
  injected && injected.length > 0 ? injected : (pkg.version ?? "0.0.0");
