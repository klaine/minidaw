// node scripts/gen_precache.mjs: app/precache.json (every file the app may need offline) and app/sw.js's VERSION (a
// hash of them all, so a changed file means a new service worker and fresh caches). Run it after changing anything in
// app/ (scripts/build_instruments.sh does).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const skip = (rel) => rel === "sw.js" || rel === "precache.json" || /(^|\/)\./.test(rel) || /LICENSE$/.test(rel);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(APP).map((p) => relative(APP, p).split("\\").join("/")).filter((rel) => !skip(rel));
const hash = createHash("sha256");
for (const rel of files) { hash.update(rel); hash.update(readFileSync(join(APP, rel))); }
const version = hash.digest("hex").slice(0, 12);
writeFileSync(join(APP, "precache.json"), JSON.stringify({ version, files }, null, 0) + "\n");
const swPath = join(APP, "sw.js");
const sw = readFileSync(swPath, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`);
writeFileSync(swPath, sw);
console.log(`precache.json: ${files.length} files, version ${version}`);
