/* Guard for the failure that already bit once: content.js calls an endpoint,
   background.js's API_PATHS allowlist does not list it, the message handler
   returns false, and the feature is silently dead — no error, no log, just a
   button that does nothing.

   Every "/api/..." literal reachable from content.js must be in that Set.
   Run with: node extension/check-api-paths.js */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lives in scripts/ rather than extension/ on purpose: anything inside
// extension/ is packaged into the store zip, and a dev guard is not something
// to ship to users or hand a store reviewer.
const dir = path.dirname(fileURLToPath(import.meta.url));
// The extension sits beside this tree in the dev checkout and one level
// further up in the app repo (where the server lives under server/). Neither
// existing is a hard failure, not a silent skip — a guard that quietly stops
// running is worse than no guard.
const ext = [path.join(dir, "..", "extension"), path.join(dir, "..", "..", "extension")]
  .find((d) => fs.existsSync(path.join(d, "background.js")));
if (!ext) {
  console.error(`FAIL: could not locate extension/ from ${dir}`);
  process.exit(1);
}
const background = fs.readFileSync(path.join(ext, "background.js"), "utf8");
const content = fs.readFileSync(path.join(ext, "content.js"), "utf8");

// The allowlist as background.js actually declares it.
const setLine = background.match(/const API_PATHS = new Set\(\[([\s\S]*?)\]\);/);
if (!setLine) {
  console.error("FAIL: could not find API_PATHS in background.js");
  process.exit(1);
}
const allowed = new Set([...setLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

// Every string literal that looks like an endpoint, wherever content.js uses
// it — api("/api/x"), a fetch template, a path variable. Over-collecting is
// the safe direction here: a false positive is a one-line fix, a false
// negative is the bug this script exists to catch.
const called = new Set([...content.matchAll(/["'`](\/api\/[a-z0-9/_-]+)["'`]/gi)].map((m) => m[1]));

const missing = [...called].filter((p) => !allowed.has(p)).sort();
const unused = [...allowed].filter((p) => !called.has(p)).sort();

console.log(`API_PATHS allows: ${[...allowed].sort().join(", ")}`);
console.log(`content.js calls: ${[...called].sort().join(", ")}`);
if (unused.length) console.log(`note: allowed but not called from content.js (reached elsewhere or reserved): ${unused.join(", ")}`);

if (missing.length) {
  console.error(`FAIL: content.js calls endpoints missing from background.js API_PATHS: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("PASS: every endpoint content.js calls is in background.js API_PATHS");
