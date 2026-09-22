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
import { MODEL_FOR_TIER, TIER_FOR_MODEL, MODEL_TIERS as TIER_NAMES, PLAN_MODEL_CEILING, PLANS, LEGACY_MODEL_TIER, currentModelId } from "../shared/plan.js";

test("shared/plan.js mirrors lib/llm.js exactly", () => {
  assert.deepEqual(MODEL_FOR_TIER, MODEL_TIERS);
});

test("every tier name is spelled the same on both sides", () => {
  assert.deepEqual([...TIER_NAMES].sort(), Object.keys(MODEL_TIERS).sort());
  // Two tiers since the 2026-09-21 plan policy: balanced (terra) is retired.
  assert.deepEqual([...TIER_NAMES], ["fast", "thorough"]);
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
/* The extension still ships the THREE-stop ladder (Fast / Balanced /
 * Thorough, with gpt-5.6-terra on the middle stop) until 2.20.0 replaces the
 * slider. Since the 2026-09-21 plan policy the server has two tiers and
 * ignores the client's model on every volume route, so these tests no longer
 * pin the extension's ids to the server's tier list one for one. They pin
 * what still matters for builds in people's hands: every id the extension can
 * send is one the server MAPS to a tier (a current id via TIER_FOR_MODEL, or a
 * retired one via LEGACY_MODEL_TIER), in the right order, and nothing the
 * server serves is dropped by the extension first. 2.20.0 realigns them. */
const serverTierOf = (id) => (Object.hasOwn(TIER_FOR_MODEL, id) ? TIER_FOR_MODEL[id]
  : Object.hasOwn(LEGACY_MODEL_TIER, id) ? LEGACY_MODEL_TIER[id] : null);
const EXT_LADDER = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra"];

function assertMapsSensibly(ids, where) {
  for (const id of ids) assert.ok(serverTierOf(id), `${where}: ${id} is neither a tier nor a retired id the server maps`);
  const ranks = ids.map((id) => TIER_NAMES.indexOf(serverTierOf(id)));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${where}: the ladder is no longer cheapest first`);
  assert.equal(serverTierOf(ids[0]), "fast", `${where}: the first stop must be the fast tier`);
  assert.equal(serverTierOf(ids.at(-1)), "thorough", `${where}: the last stop must be the thorough tier`);
}

test("background.js ALLOWED_MODELS: every id maps to a server tier, and every served model passes", () => {
  const src = read("background.js");
  const fast = src.match(/const FAST_MODEL = "([^"]+)"/);
  assert.ok(fast, "FAST_MODEL not found in background.js");
  assert.equal(fast[1], MODEL_TIERS.fast);

  const set = src.match(/const ALLOWED_MODELS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(set, "ALLOWED_MODELS not found in background.js");
  const ids = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // FAST_MODEL is referenced by name in that literal, so it is one short.
  const ext = new Set([MODEL_TIERS.fast, ...ids]);
  assertMapsSensibly([...ext].sort((a, b) => TIER_NAMES.indexOf(serverTierOf(a)) - TIER_NAMES.indexOf(serverTierOf(b))), "background.js");
  for (const model of ALLOWED_MODELS) assert.ok(ext.has(model), `background.js would drop ${model}, which the server serves`);
});

test("content.js SPEED_STOPS: every stop maps to a server tier, cheapest first", () => {
  const src = read("content.js");
  const block = src.match(/const SPEED_STOPS = \[([\s\S]*?)\];/);
  assert.ok(block, "SPEED_STOPS not found in content.js");
  const ids = [...block[1].matchAll(/model: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, EXT_LADDER, "2.20.0 replaces the slider; until then it is the three-stop ladder");
  assertMapsSensibly(ids, "content.js SPEED_STOPS");
});

test("options.js MODELS: every stop maps to a server tier, cheapest first", () => {
  const src = read("options.js");
  const block = src.match(/const MODELS = \[([\s\S]*?)\];/);
  assert.ok(block, "MODELS not found in options.js");
  const ids = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, EXT_LADDER, "2.20.0 replaces the slider; until then it is the three-stop ladder");
  assertMapsSensibly(ids, "options.js MODELS");
});

test("content.js SPEED_STOPS carry the efforts the model eval measured", () => {
  // eval/models/FINDINGS.md: the fast model checks at 100% at medium and 90%
  // at low; balanced and thorough were only measured at low (the old
  // thorough stop sent medium, which was never measured).
  const block = read("content.js").match(/const SPEED_STOPS = \[([\s\S]*?)\];/);
  const efforts = [...block[1].matchAll(/effort: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(efforts, ["medium", "low", "low"]);
});

/* Retired ids earlier extension builds saved (a site's stop, the options
 * default) are read back as a stop by content.js and options.js, and sent
 * ones are translated by the server's LEGACY_MODEL_TIER. A third copy, so it
 * is pinned like the others: each retired id must name the same stop as the
 * tier the server maps it to. */
test("the extension's retired-id maps agree with the server's LEGACY_MODEL_TIER", () => {
  const parse = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = \\{([^}]*)\\}`));
    assert.ok(m, `${name} not found`);
    return Object.fromEntries([...m[1].matchAll(/"([^"]+)":\s*(\d+)/g)].map((x) => [x[1], Number(x[2])]));
  };
  // The extension maps a retired id to a STOP on its three-stop ladder; the
  // server maps the same id to a TIER. They agree when the stop's model is one
  // the server maps to that same tier (gpt-5.4 -> the Balanced stop, whose
  // terra id the server now also reads as fast). 2.20.0 realigns the maps.
  for (const [file, name] of [["content.js", "RETIRED_STOP"], ["options.js", "RETIRED_MODELS"]]) {
    for (const [id, stop] of Object.entries(parse(read(file), name))) {
      assert.ok(Object.hasOwn(LEGACY_MODEL_TIER, id), `${file} ${name}: ${id} is not a retired id the server maps`);
      assert.equal(serverTierOf(EXT_LADDER[stop]), LEGACY_MODEL_TIER[id], `${file} ${name}: ${id} -> stop ${stop}`);
    }
  }
  for (const id of Object.keys(LEGACY_MODEL_TIER)) {
    assert.ok(!ALLOWED_MODELS.has(id), `${id} is retired but still a tier`);
    assert.ok(ALLOWED_MODELS.has(currentModelId(id)), `${id} must translate to a model the server serves`);
  }
});

test("the slider ladder and the plan ceilings are the same length", () => {
  // options.js indexes PLAN_MAX_STOP into MODELS positionally; a fourth tier
  // added to one and not the other would open or hide a stop silently.
  const stops = [...read("options.js").matchAll(/const PLAN_MAX_STOP = \{([^}]*)\}/g)];
  assert.equal(stops.length, 1);
  const maxStop = Math.max(...[...stops[0][1].matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(maxStop, EXT_LADDER.length - 1);
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

/* Chrome match-pattern semantics, enough to ask the manifest a behavioural
 * question instead of pinning its array: `<scheme>://<host><path>`, where a
 * `*` in the path matches any run of characters (slashes included) and the
 * path is tested against the URL's path + query, never its fragment. */
function matchesPattern(pattern, url) {
  if (pattern === "<all_urls>") return /^(https?|wss?|ftp|file):/.test(url);
  const m = pattern.match(/^(\*|https?|wss?|ftp|file):\/\/([^/]*)(\/.*)$/);
  assert.ok(m, `not a Chrome match pattern: ${pattern}`);
  const [, scheme, host, pathPart] = m;
  const u = new URL(url);
  const proto = u.protocol.slice(0, -1);
  if (scheme === "*" ? !["http", "https"].includes(proto) : scheme !== proto) return false;
  if (host !== "*") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
    } else if (u.hostname !== host) return false;
  }
  const body = pathPart.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`).test(u.pathname + u.search);
}

// A Doc opened from a second signed-in Google account lives at
// /document/u/<n>/d/<id>/... — every student with a school and a personal
// account. 2.19.3 matched /document/d/* only, so on those URLs the hook never
// ran, Docs never built its annotation layer, and the widget listed issues
// with not one underline under them.
const DOC_URLS = [
  "https://docs.google.com/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
  "https://docs.google.com/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit?tab=t.0",
  "https://docs.google.com/document/u/0/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
  "https://docs.google.com/document/u/1/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit?usp=sharing",
  "https://docs.google.com/document/u/12/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit#heading=h.abc",
];
// /document/* also matches the docs LIST page, where the flag can do nothing
// and only widens the surface we touch.
const NOT_DOC_URLS = [
  "https://docs.google.com/document/",
  "https://docs.google.com/document/u/0/",
  "https://docs.google.com/document/u/1/?tgif=d",
  "https://docs.google.com/spreadsheets/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
  "https://docs.google.com/spreadsheets/u/1/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
  "https://docs.google.com.evil.test/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
  "http://docs.google.com/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit",
];

test("the Docs hook runs on every Doc URL, signed-in account prefix or not", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const hook = manifest.content_scripts.find((c) => (c.js ?? []).includes("docs-hook.js"));
  assert.ok(hook, "docs-hook.js is not registered as a content script");
  const runs = (url) => hook.matches.some((p) => matchesPattern(p, url));
  for (const url of DOC_URLS) assert.ok(runs(url), `docs-hook.js does not run on ${url}`);
  // It must still run before kix bootstraps, in the page world, or the global
  // is set too late to be read.
  assert.equal(hook.world, "MAIN");
  assert.equal(hook.run_at, "document_start");
});

test("the Docs hook is scoped to documents, not to all of /document/*", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const hook = manifest.content_scripts.find((c) => (c.js ?? []).includes("docs-hook.js"));
  for (const url of NOT_DOC_URLS) {
    assert.ok(!hook.matches.some((p) => matchesPattern(p, url)), `docs-hook.js runs on ${url}`);
  }
});

test("wherever the hook runs, content.js finds the document id — and nowhere else", () => {
  // The two halves must agree: a hook with no widget reading the doc paints
  // nothing, and a widget without the hook lists issues with no underlines.
  const m = read("content.js").match(/const DOC_ID = harness \? "harness" : \(location\.pathname\.match\((\/.+?\/)\)\?\.\[1\]/);
  assert.ok(m, "docsMode's DOC_ID expression not found in content.js");
  const docIdRe = new RegExp(m[1].slice(1, -1));
  for (const url of DOC_URLS) assert.equal(new URL(url).pathname.match(docIdRe)?.[1], "1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo", url);
  for (const url of NOT_DOC_URLS.filter((u) => u.startsWith("https://docs.google.com/document/"))) {
    assert.equal(new URL(url).pathname.match(docIdRe), null, url);
  }
});

test("the match-pattern helper agrees with Chrome on the edge cases the hook depends on", () => {
  assert.ok(matchesPattern("https://docs.google.com/document/u/*/d/*", "https://docs.google.com/document/u/0/d/x"));
  assert.ok(!matchesPattern("https://docs.google.com/document/u/*/d/*", "https://docs.google.com/document/u/0/"));
  assert.ok(matchesPattern("https://*.google.com/*", "https://docs.google.com/a"));
  assert.ok(!matchesPattern("https://*.google.com/*", "https://google.com.evil.test/a"));
  assert.ok(matchesPattern("<all_urls>", "https://example.test/"));
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
  // One tick per stop of the extension's own ladder (three until 2.20.0
  // replaces the slider, though the server now has two tiers).
  assert.equal(ticks.length, EXT_LADDER.length, "one tick per stop");
  for (const tick of ticks) {
    for (const model of new Set([...Object.values(MODEL_TIERS), ...EXT_LADDER])) {
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

/* ── the web app, and the one price table ─────────────────────────────────
 * The web app under public/ migrated off Anthropic in name only: its model
 * picker offered three claude-* ids none of which the server accepts, its
 * spend meter priced calls by Anthropic family name and so read $0.00 for any
 * OpenAI session, and its first-run banner asked for ANTHROPIC_API_KEY.
 */
import { MODEL_PRICES as SHARED_PRICES, priceFor } from "../shared/prices.js";
import { MODEL_PRICES as LLM_PRICES } from "../lib/llm.js";

const PUBLIC = path.join(HERE, "..", "public");
const readPublic = (f) => readFileSync(path.join(PUBLIC, f), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");

test("there is exactly one price table, and it prices every tier", () => {
  assert.equal(LLM_PRICES, SHARED_PRICES, "lib/llm.js must re-export shared/prices.js, not keep its own copy");
  // A superset of the tiers: a retired model keeps its row (gpt-5.6-terra, the
  // old balanced) so usage recorded before the 2026-09-21 plan policy still
  // prices. Any row beyond the tiers must be such a retired id, never a model
  // the server could be talked into running.
  for (const id of Object.values(MODEL_TIERS)) assert.ok(Object.hasOwn(SHARED_PRICES, id), `${id} is unpriced`);
  for (const id of Object.keys(SHARED_PRICES)) {
    assert.ok(ALLOWED_MODELS.has(id) || Object.hasOwn(LEGACY_MODEL_TIER, id), `${id} is priced but is neither a tier nor retired`);
  }
  assert.ok(Object.hasOwn(SHARED_PRICES, "gpt-5.6-terra"), "terra's row stays so historical usage prices");
  assert.ok(!ALLOWED_MODELS.has("gpt-5.6-terra"), "terra is retired: priced, never served");
  // The API echoes dated snapshots back as `model`; the meter must still price them.
  assert.ok(priceFor(`${MODEL_TIERS.fast}-2025-08-07`), "a dated snapshot id must resolve to its family's price");
  assert.equal(priceFor("claude-opus-5"), null, "an unknown model is unpriced, never priced as something else");
});

test("every tier is priced with its cache-write rate", () => {
  // All three bill a first-seen prompt prefix at 1.25x input
  // (usage.input_tokens_details.cache_write_tokens). A tier without a
  // cacheWrite price is billed at its input rate — an under-count on every
  // cold call — so adding one without it must be a decision, not an omission.
  for (const id of Object.values(MODEL_TIERS)) {
    const p = SHARED_PRICES[id];
    assert.ok(Number.isFinite(p.cacheWrite) && p.cacheWrite >= p.input, `${id} has no cacheWrite price`);
  }
});

test("the web app's model picker is the server's tier map, not a copy", () => {
  const src = readPublic("app/settings.js");
  assert.ok(src.includes('from "/shared/plan.js"'), "settings.js must import MODEL_FOR_TIER from /shared/plan.js");
  const code = stripComments(src);
  for (const id of Object.values(MODEL_TIERS)) {
    assert.ok(!code.includes(`"${id}"`), `settings.js hard-codes ${id} — import it instead`);
  }
});

test("the web app's spend meter reads the shared price table", () => {
  const src = readPublic("app/api.js");
  assert.ok(src.includes('from "/shared/prices.js"'), "api.js must price usage from /shared/prices.js");
  assert.ok(!/opus:\s*\[|sonnet:\s*\[|haiku:\s*\[/.test(stripComments(src)), "api.js still carries its own per-family price table");
});

test("nothing the web app renders names a model vendor we do not use", () => {
  for (const f of ["index.html", "app/settings.js", "app/home.js", "app/api.js"]) {
    const code = stripComments(readPublic(f));
    for (const s of ["anthropic", "claude-", "sk-ant", "haiku", "sonnet", "opus"]) {
      assert.ok(!code.toLowerCase().includes(s), `${f} still says "${s}" outside a comment`);
    }
  }
});

// "/api/grade honours a pasted rubric" moved to test/boundary.test.js, where it
// drives the real route over HTTP instead of pattern-matching its source.
