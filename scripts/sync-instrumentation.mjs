import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dotNext = path.join(root, ".next");
const serverDir = path.join(dotNext, "server");
const standaloneServer = path.join(dotNext, "standalone", ".next", "server");
const manifestPath = path.join(serverDir, "instrumentation.js.nft.json");

if (!existsSync(manifestPath)) {
  console.warn("instrumentation.js.nft.json not found; skip sync");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
let copied = 0;
for (const rel of manifest.files) {
  const source = path.resolve(serverDir, rel);
  if (!source.startsWith(dotNext + path.sep)) continue;
  if (!existsSync(source)) continue;
  const relative = path.relative(serverDir, source);
  const dest = path.join(standaloneServer, relative);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  copied += 1;
}

const instrumentationEntry = path.join(serverDir, "instrumentation.js");
if (existsSync(instrumentationEntry)) {
  copyFileSync(instrumentationEntry, path.join(standaloneServer, "instrumentation.js"));
  const mapFile = path.join(serverDir, "instrumentation.js.map");
  if (existsSync(mapFile)) {
    copyFileSync(mapFile, path.join(standaloneServer, "instrumentation.js.map"));
  }
}

console.log(`Instrumentation synced into standalone: ${copied} files`);
