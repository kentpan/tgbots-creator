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
  const kv = getKv();
  const cached = await kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      await kv.delete(key);
    }
  }
  const fresh = await loader();
  await kv.set(key, JSON.stringify(fresh), ttlSeconds);
  return fresh;
}

export async function invalidateCache(key: string): Promise<void> {
  await getKv().delete(key);
}
