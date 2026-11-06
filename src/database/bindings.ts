export interface KvDriver {
  readonly kind: "cloudflare" | "memory";
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareKvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

function resolveCloudflareKv(): CloudflareKvLike | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["KV", "CACHE", "__KV"]) {
    const candidate = globals[key] as CloudflareKvLike | undefined;
    if (
      candidate &&
      typeof candidate.get === "function" &&
      typeof candidate.put === "function" &&
      typeof candidate.delete === "function"
    ) {
      return candidate;
    }
  }
  return null;
}

function createMemoryKv(): KvDriver & { clearExpired(): void } {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    kind: "memory",
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
    },
    async delete(key) {
      store.delete(key);
    },
    clearExpired() {
      const now = Date.now();
      for (const [key, entry] of store) {
        if (entry.expiresAt !== null && now > entry.expiresAt) store.delete(key);
      }
    },
  };
}

const globalForKv = globalThis as unknown as { botGroupsKv?: KvDriver };

export function getKv(): KvDriver {
  if (globalForKv.botGroupsKv) return globalForKv.botGroupsKv;
  const cloudflareKv = resolveCloudflareKv();
  const driver: KvDriver = cloudflareKv
    ? {
        kind: "cloudflare",
        async get(key) {
          return cloudflareKv.get(key);
        },
        async set(key, value, ttlSeconds) {
          await cloudflareKv.put(
            key,
            value,
            ttlSeconds ? { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) } : undefined,
          );
        },
        async delete(key) {
          await cloudflareKv.delete(key);
        },
      }
    : createMemoryKv();
  globalForKv.botGroupsKv = driver;
  return driver;
}

export interface StorageDriver {
  readonly kind: "cloudflare-r2" | "local";
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

interface CloudflareR2Like {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects?: { key: string }[] }>;
}

function resolveCloudflareR2(): CloudflareR2Like | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["BUCKET", "R2", "__R2_BUCKET"]) {
    const candidate = globals[key] as CloudflareR2Like | undefined;
    if (
      candidate &&
      typeof candidate.put === "function" &&
      typeof candidate.get === "function" &&
      typeof candidate.delete === "function"
    ) {
      return candidate;
    }
  }
  return null;
}

function createLocalR2(): StorageDriver {
  const root = ".data/storage";
  const resolveKey = (key: string): string => {
    const safe = key.replace(/\.\.+/g, ".").replace(/^\/+/, "");
    return `${root}/${safe}`;
  };
  return {
    kind: "local",
    async put(key, data, contentType) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const target = resolveKey(key);
      mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      writeFileSync(target, data);
      if (contentType) {
        writeFileSync(`${target}.meta`, contentType);
      }
    },
    async get(key) {
      const { readFileSync, existsSync } = await import("node:fs");
      const target = resolveKey(key);
      if (!existsSync(target)) return null;
      return new Uint8Array(readFileSync(target));
    },
    async delete(key) {
      const { rmSync, existsSync } = await import("node:fs");
      const target = resolveKey(key);
      if (existsSync(target)) rmSync(target);
    },
    async list(prefix = "") {
      const { readdirSync, existsSync } = await import("node:fs");
      const dir = `${root}/${prefix}`.replace(/\/+$/, "");
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.endsWith(".meta"))
        .map((entry) => (prefix ? `${prefix}/${entry.name}` : entry.name));
    },
  };
}

const globalForR2 = globalThis as unknown as { botGroupsR2?: StorageDriver };

export function getStorage(): StorageDriver {
  if (globalForR2.botGroupsR2) return globalForR2.botGroupsR2;
  const r2 = resolveCloudflareR2();
  const driver: StorageDriver = r2
    ? {
        kind: "cloudflare-r2",
        async put(key, data, contentType) {
          await r2.put(key, data, {
            httpMetadata: contentType ? { contentType } : undefined,
          });
        },
        async get(key) {
          const object = await r2.get(key);
          if (!object) return null;
          return new Uint8Array(await object.arrayBuffer());
        },
        async delete(key) {
          await r2.delete(key);
        },
        async list(prefix = "") {
          const result = await r2.list(prefix ? { prefix } : undefined);
          return (result.objects ?? []).map((object) => object.key);
        },
      }
    : createLocalR2();
  globalForR2.botGroupsR2 = driver;
  return driver;
}

export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  // v2.0.6 D1 读行额度优化：内存 memo 前置 —— 同一 isolate 存活期内重复调用
  // 不再逐次打 KV（KV 免费层 100,000 读/天，同样有额度），miss 才走 KV/DB。
  const memoTtlMs = Math.max(1, ttlSeconds) * 1000;
  const memoHit = readMemo<T>(`cached-json:${key}`, memoTtlMs);
  if (memoHit.hit) {
    return memoHit.value as T;
  }
  const kv = getKv();
  const cached = await kv.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as T;
      writeMemo(`cached-json:${key}`, parsed, memoTtlMs);
      return parsed;
    } catch {
      await kv.delete(key);
    }
  }
  const fresh = await loader();
  await kv.set(key, JSON.stringify(fresh), ttlSeconds);
  writeMemo(`cached-json:${key}`, fresh, memoTtlMs);
  return fresh;
}

export async function invalidateCache(key: string): Promise<void> {
  deleteMemo(`cached-json:${key}`);
  await getKv().delete(key);
}

// ---------------------------------------------------------------------------
// 进程内 TTL memo（v2.0.6 D1 读行额度优化核心）
//
// Workers isolate 空闲 ~30s 即回收：回收后首条 webhook 会把实例级注册表清空，
// 若每次冷启动都直读 D1（getBot + 运行时设置 + 指令库 ≈ 60-80 行读），
// 消息间隔大于 isolate 存活期的群组会「每条消息都冷启动」，读行成倍放大。
// 本 memo 把热配置读取收敛为「每 isolate 每 TTL 一次」。
// Node 形态（沙盒/自托管常驻进程）同样受益：缓存命中期间读行为 0。
// ---------------------------------------------------------------------------

interface MemoEntry {
  value: unknown;
  expiresAt: number;
}

const globalForMemo = globalThis as unknown as {
  tguardMemoStore?: Map<string, MemoEntry>;
};

function memoStore(): Map<string, MemoEntry> {
  if (!globalForMemo.tguardMemoStore) {
    globalForMemo.tguardMemoStore = new Map();
  }
  return globalForMemo.tguardMemoStore;
}

function readMemo<T>(key: string, ttlMs: number): { hit: boolean; value?: T } {
  const entry = memoStore().get(key);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expiresAt) {
    memoStore().delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value as T };
}

function writeMemo(key: string, value: unknown, ttlMs: number): void {
  const store = memoStore();
  // 简单容量护栏：memo 只放热配置（bots/指令库/设置缓存），512 条远超实际用量
  if (store.size > 512) {
    const now = Date.now();
    for (const [k, entry] of store) {
      if (now > entry.expiresAt) store.delete(k);
    }
    if (store.size > 512) {
      const first = store.keys().next();
      if (!first.done) store.delete(first.value);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function deleteMemo(key: string): void {
  memoStore().delete(key);
}

function deleteMemoByPrefix(prefix: string): void {
  const store = memoStore();
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * 进程内 TTL 缓存读取（v2.0.6）：
 * - 命中 → 直接返回缓存值（0 次 D1 读）
 * - 未命中 → loader() 加载并写入 memo
 * - 缓存 null 结果（防不存在对象反复打库），ttlMs 可为 0 关闭缓存
 */
export async function memoTtl<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (ttlMs <= 0) return loader();
  const hit = readMemo<T>(key, ttlMs);
  if (hit.hit) return hit.value as T;
  const fresh = await loader();
  writeMemo(key, fresh, ttlMs);
  return fresh;
}

export function invalidateMemo(key: string): void {
  deleteMemo(key);
}

export function invalidateMemoByPrefix(prefix: string): void {
  deleteMemoByPrefix(prefix);
}
