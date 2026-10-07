/* The failure that bit once: content.js calls an endpoint, background.js's
 * API_PATHS allowlist does not list it, the message handler returns false,
 * and the feature is silently dead — no error, no log, a button that does
 * nothing. And the server-side half: a path the extension sends that is not
 * in server.js's EXTENSION_API is refused by origin on the hosted server.
 * Both chains are checked here (this replaced server/scripts/check-api-paths.js,
 * which nothing ran). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
const setOf = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(m, `${name} not found`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
};

test("every /api path content.js sends through the background is allowed there, and every allowed path is one the server lets the extension call", () => {
  const content = read("extension/content.js");
  const background = read("extension/background.js");
  const server = read("server/server.js");
  const called = new Set([...content.matchAll(/["'`](\/api\/[a-z0-9/_-]+)["'`]/gi)].map((m) => m[1]));
  const allowed = setOf(background, "API_PATHS");
  const extensionApi = setOf(server, "EXTENSION_API");
  assert.ok(called.size >= 6, `content.js names ${called.size} api paths; expected at least 6`);
  const missing = [...called].filter((p) => !allowed.has(p)).sort();
  assert.deepEqual(missing, [], `content.js calls paths background.js API_PATHS does not allow (the feature is silently dead): ${missing.join(", ")}`);
  const refused = [...allowed].filter((p) => !extensionApi.has(p)).sort();
  assert.deepEqual(refused, [], `background.js allows paths the hosted server refuses to the extension (add to EXTENSION_API in server.js — that is an extension release): ${refused.join(", ")}`);
  // /api/account is called by background.js itself (account deletion), never
  // from content.js, which is why it is in EXTENSION_API but not API_PATHS.
  assert.ok(extensionApi.has("/api/account"), "the one asymmetry: /api/account is background.js's own call");
});
