import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";

export type PlaneKind = "edge" | "node";

const globalForPlane = globalThis as unknown as { tguardMirrorPlane?: PlaneKind };

/**
 * 平面探测：与项目既有 isEdgeRuntime() 同源判定（workerd UA / NEXT_RUNTIME），
 * 不引入新判定来源。结果缓存到 globalThis，进程生命周期内只算一次。
 */
export function detectPlane(): PlaneKind {
  if (globalForPlane.tguardMirrorPlane) return globalForPlane.tguardMirrorPlane;
  const plane: PlaneKind = isEdgeRuntime() ? "edge" : "node";
  globalForPlane.tguardMirrorPlane = plane;
  return plane;
}
