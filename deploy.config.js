import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
);

// 全局唯一版本号：动态取 package.json 的 version 字段，禁止硬编码
const deployConfig = {
  version: pkg.version,

  // Cloudflare Pages 项目名：自动取 package.json 的 name 字段
  projectName: pkg.name,

  // D1 数据库名（留空 = 不创建 / 不绑定 D1）
  d1Name: `${pkg.name}-db`,

  // KV 命名空间名（留空 = 不创建 / 不绑定 KV，缓存自动降级为内存实现）
  kvName: `${pkg.name}-kv`,

  // R2 存储桶名（留空 = 不创建 / 不绑定 R2，资源上传功能不可用）
  r2Name: `${pkg.name}-store`,

  // 账号 ID（留空自动探测）
  accountId: '',
};

export default deployConfig;
