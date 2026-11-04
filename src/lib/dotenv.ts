import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let envBaseDir: string | null = null;

function findEnvFile(fileName: string): string | null {
  let current = path.resolve(process.cwd());
  for (;;) {
    const candidate = path.join(current, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function toAbsoluteFileUri(value: string, baseDir: string): string {
  if (!value.startsWith("file:")) return value;
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
  const baseDir = path.dirname(envFile);
  envBaseDir = baseDir;
  let raw: string;
  try {
    raw = readFileSync(envFile, "utf-8");
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
  envBaseDir = envFile ? path.dirname(envFile) : process.cwd();
  return envBaseDir;
}
