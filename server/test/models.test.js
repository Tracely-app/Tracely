/**
 * The model ids live in two places on purpose: lib/llm.js owns them, and
 * shared/plan.js mirrors them because it must stay a leaf module the browser
 * and the tests can load without pulling in the API client.
 *
 * A mirror that drifts is silent and expensive: clampModel would stop
 * recognising the id the server actually sends, fall through its "unknown
 * model" branch, and quietly serve every paying account the cheap model. This
 * file is the only thing holding the two halves together.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_TIERS, ALLOWED_MODELS, DEFAULT_MODEL } from "../lib/llm.js";
import { MODEL_FOR_TIER, TIER_FOR_MODEL, MODEL_TIERS as TIER_NAMES, PLAN_MODEL_CEILING, PLANS } from "../shared/plan.js";

test("shared/plan.js mirrors lib/llm.js exactly", () => {
  assert.deepEqual(MODEL_FOR_TIER, MODEL_TIERS);
});

test("every tier name is spelled the same on both sides", () => {
  assert.deepEqual([...TIER_NAMES].sort(), Object.keys(MODEL_TIERS).sort());
});

test("TIER_FOR_MODEL is the exact inverse of MODEL_FOR_TIER", () => {
  const inverted = Object.fromEntries(Object.entries(MODEL_FOR_TIER).map(([tier, model]) => [model, tier]));
  assert.deepEqual(TIER_FOR_MODEL, inverted);
});

test("every plan ceiling names a real tier", () => {
  for (const plan of PLANS) {
    assert.ok(TIER_NAMES.includes(PLAN_MODEL_CEILING[plan]), `${plan} ceiling is not a tier`);
  }
});

test("the default model is the cheapest tier, and is allowed", () => {
  assert.equal(DEFAULT_MODEL, MODEL_TIERS.fast);
  assert.ok(ALLOWED_MODELS.has(DEFAULT_MODEL));
});

/* ── the extension's hand copies ──────────────────────────────────────────
 * The extension ships without a build step and an MV3 worker cannot import
 * from the server tree, so three files under extension/ each spell the model
 * ids out again. A drifted copy fails in the worst possible way: the request
 * still succeeds, the server clamps the unrecognised id down to the cheap
 * model, and a Pro subscriber silently gets the free tier with no error
 * anywhere. Parsing the source is ugly, but it is the only thing standing
 * between that and a support ticket nobody can reproduce.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* The extension sits beside this tree in the dev checkout and one level
   further up in the app repo (where the server lives under server/). Both are
   tried, and NEITHER existing is a failure rather than a skip — a guard that
   quietly stops running is worse than no guard. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = [path.join(HERE, "..", "extension"), path.join(HERE, "..", "..", "extension")]
  .find((dir) => existsSync(path.join(dir, "background.js")));
const read = (f) => {
  assert.ok(EXT, "could not locate extension/ from " + HERE);
  return readFileSync(path.join(EXT, f), "utf8");
};
const ORDERED = [MODEL_TIERS.fast, MODEL_TIERS.balanced, MODEL_TIERS.thorough];

test("background.js ALLOWED_MODELS matches the server's tiers", () => {
  const src = read("background.js");
  const fast = src.match(/const FAST_MODEL = "([^"]+)"/);
  assert.ok(fast, "FAST_MODEL not found in background.js");
  assert.equal(fast[1], MODEL_TIERS.fast);

  const set = src.match(/const ALLOWED_MODELS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "ALLOWED_MODELS not found in background.js");
  const ids = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // FAST_MODEL is referenced by name in that literal, so it is one short.
  assert.deepEqual(new Set([MODEL_TIERS.fast, ...ids]), ALLOWED_MODELS);
});

test("content.js SPEED_STOPS is the tier ladder, cheapest first", () => {
  const src = read("content.js");
  const block = src.match(/const SPEED_STOPS = \[([\s\S]*?)\];/);
  assert.ok(block, "SPEED_STOPS not found in content.js");
  const ids = [...block[1].matchAll(/model: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ORDERED);
});

test("options.js MODELS is the tier ladder, cheapest first", () => {
  const src = read("options.js");
  const block = src.match(/const MODELS = \[([\s\S]*?)\];/);
  assert.ok(block, "MODELS not found in options.js");
  const ids = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ORDERED);
});

test("the slider ladder and the plan ceilings are the same length", () => {
  // options.js indexes PLAN_MAX_STOP into MODELS positionally; a fourth tier
  // added to one and not the other would open or hide a stop silently.
  const stops = [...read("options.js").matchAll(/const PLAN_MAX_STOP = \{([^}]*)\}/g)];
  assert.equal(stops.length, 1);
  const maxStop = Math.max(...[...stops[0][1].matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(maxStop, ORDERED.length - 1);
});
