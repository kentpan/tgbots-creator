import { getKv } from "@/database/bindings";
import { detectPlane } from "./env";

export interface DedupeStore {
  /** 返回 true = 首次见到该 key（放行）；false = 重复（丢弃） */
  firstSeen(key: string): Promise<boolean>;
  readonly kind: "kv" | "memory";
}

const DEDUPE_TTL_SECONDS = 60;

function createKvDedupe(): DedupeStore {
  const kv = getKv();
  return {
    kind: "kv",
    async firstSeen(key) {
      const storageKey = `mirror:upd:${key}`;
      const existing = await kv.get(storageKey);
      if (existing) return false;
      await kv.set(storageKey, "1", DEDUPE_TTL_SECONDS);
      return true;
    },
  };
}

function createMemoryDedupe(): DedupeStore {
  const globalForDedupe = globalThis as unknown as {
    tguardMirrorDedupe?: Map<string, number>;
  };
  if (!globalForDedupe.tguardMirrorDedupe) {
    globalForDedupe.tguardMirrorDedupe = new Map();
  }
  const store = globalForDedupe.tguardMirrorDedupe;
  return {
    kind: "memory",
    async firstSeen(key) {
      const now = Date.now();
      for (const [k, expiresAt] of store) {
        if (expiresAt < now) store.delete(k);
      }
      if (store.has(key)) return false;
      store.set(key, now + DEDUPE_TTL_SECONDS * 1000);
      return true;
    },
  };
}

/** KV 绑定存在（edge）→ KV；否则进程内存 Map（Node 单实例足够） */
export function createDedupe(): DedupeStore {
  try {
    const kv = getKv();
    if (kv.kind === "cloudflare") return createKvDedupe();
  } catch (error) {
    console.warn("[mirror] KV 探测失败，update 幂等退化为进程内存:", error);
  }
  // edge 但无 KV 绑定时也必须用某种存储 —— getKv() 已自动回落内存，
  // 这里按平面标记便于日志排查
  if (detectPlane() === "edge") {
    const kv = getKv();
    if (kv.kind === "memory") return createMemoryDedupe();
  }
  return createMemoryDedupe();
}
