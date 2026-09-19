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

/* ── the Docs annotation requester ────────────────────────────────────────
 * extension/docs-hook.js sets window._docs_annotate_canvas_by_ext, which
 * Google Docs gates its SVG annotation layer on. The value is NOT validated
 * against any allowlist (verified against the live kix bundle, 2026-09-13 —
 * the gate is `sQf() != ""`), but it IS reported to Google: kix writes it into
 * the Docs error reporter's context under "kixAnnotatedCanvasRequester" and
 * into a client telemetry proto.
 *
 * So a third party's id here is not a clever unlock, it is a misattribution —
 * every Docs error a Tracely install provokes would be filed under that
 * vendor's name. This file shipped Grammarly's id for months on the mistaken
 * belief that an allowlist existed. These tests make putting one back a build
 * failure rather than a plausible-looking line nobody re-examines.
 */
const FOREIGN_IDS = {
  kbfnbcaeplbcioakkpcpgfkobkghlhen: "Grammarly",
  hokifickgkhplphjiodbggjmoafhignh: "Microsoft Editor",
  ghbmnnjooekpmoecnnnilnnbdlolhkhi: "Google Docs Offline",
  gmbmikajjgmnabiglmofipeabaddhgne: "Google Translate",
};

test("the Docs annotation requester is set, and is not empty", () => {
  const src = read("docs-hook.js");
  const m = src.match(/const ANNOTATION_REQUESTER = "([^"]*)"/);
  assert.ok(m, "ANNOTATION_REQUESTER not found in docs-hook.js");
  assert.notEqual(m[1], "", "an empty string disables the annotation layer — the gate is a string-emptiness test");
});

test("the Docs annotation requester is not another vendor's extension id", () => {
  const src = read("docs-hook.js");
  for (const [id, owner] of Object.entries(FOREIGN_IDS)) {
    // Allowed in the explanatory comment; never as the assigned value.
    const assigned = new RegExp(`_docs_annotate_canvas_by_ext\\s*=\\s*["']${id}["']`);
    assert.ok(!assigned.test(src), `docs-hook.js assigns ${owner}'s extension id to _docs_annotate_canvas_by_ext`);
    const constant = new RegExp(`const ANNOTATION_REQUESTER = ["']${id}["']`);
    assert.ok(!constant.test(src), `ANNOTATION_REQUESTER is ${owner}'s extension id`);
  }
});

test("the Docs hook is scoped to documents, not to all of /document/*", () => {
  // /document/* also matches the docs LIST page, where the flag can do nothing
  // and only widens the surface we touch.
  const manifest = JSON.parse(read("manifest.json"));
  const hook = manifest.content_scripts.find((c) => (c.js ?? []).includes("docs-hook.js"));
  assert.ok(hook, "docs-hook.js is not registered as a content script");
  assert.deepEqual(hook.matches, ["https://docs.google.com/document/d/*"]);
  // It must still run before kix bootstraps, in the page world, or the global
  // is set too late to be read.
  assert.equal(hook.world, "MAIN");
  assert.equal(hook.run_at, "document_start");
});

/* ── what the options page SAYS ───────────────────────────────────────────
 * Two bugs shipped together in 2.19.1 and were reported as one: "Merrick is
 * seeing an outdated version with a terrible reasoning model". Neither was an
 * outdated version. The build was current; two pieces of its UI were not.
 */

test("the model slider names tiers, never models", () => {
  // The ticks read Haiku / Sonnet / Opus for a fortnight after the move to
  // OpenAI. The MODELS array in options.js was migrated and the labels under
  // the slider were not, so the only screen that tells a user what they are
  // buying named three Anthropic models the extension could no longer call.
  // Nothing in the code has to touch those labels, which is exactly why a
  // provider swap does not reach them — so this test does instead.
  const ticks = [...read("options.html").matchAll(/<span class="tick" data-i="\d+">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.equal(ticks.length, Object.keys(MODEL_TIERS).length, "one tick per tier");
  for (const tick of ticks) {
    for (const model of Object.values(MODEL_TIERS)) {
      assert.ok(!tick.toLowerCase().includes(model.toLowerCase()), `tick "${tick}" names a model id`);
    }
    for (const vendor of ["haiku", "sonnet", "opus", "gpt", "claude", "gemini"]) {
      assert.ok(!tick.toLowerCase().includes(vendor), `tick "${tick}" names a vendor's model`);
    }
  }
});

test("the options page probes the hosted server, not just localhost", () => {
  // It probed localhost and nothing else while the background worker had been
  // falling back to api.jointracely.com for weeks — so on any machine without
  // a local server the page reported the extension offline and told the reader
  // to go and buy an OpenAI key, over an extension that was working.
  const src = read("options.js");
  assert.ok(src.includes("https://api.jointracely.com"), "options.js never probes the hosted server");
  assert.ok(!/const SERVER = "http:\/\/localhost:4477";/.test(src), "options.js still pins a single localhost server");
});

test("the extension cannot call OpenAI directly", () => {
  // The bring-your-own-key standalone engine is removed. It opened every model
  // stop to anyone who pasted a key, which against a product whose plans ARE
  // the model ceiling is the pricing page with an opt-out. The host permission
  // goes with it: leaving it declared would keep asking users for access to a
  // service the extension no longer talks to.
  for (const f of ["background.js", "content.js", "options.js"]) {
    const src = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "") // comments may still explain why it went
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!src.includes("api.openai.com"), `${f} still reaches api.openai.com`);
  }
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(
    !manifest.host_permissions.some((h) => h.includes("openai.com")),
    "manifest still requests access to OpenAI"
  );
  // An options page with no key field must not still tell people to set one.
  assert.ok(!/add (an|your) API key/i.test(read("options.html")), "options.html still points at a key field it no longer has");
});
