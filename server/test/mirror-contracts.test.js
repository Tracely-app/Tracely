/**
 * The hand-copied CONTRACTS between the desktop, the server and the extension,
 * pinned so the two halves cannot quietly re-diverge.
 *
 * test/mirror.test.js covers the logic server/shared ported from the desktop.
 * This file covers the pairs the backend unification named as the ones that
 * had already drifted or would: the plan vocabulary and model map (copied into
 * three trees), the mark vocabulary (server/shared/marks.js vs the desktop's
 * problemKind.ts + problemCopy.ts), and the live-detect gate (guards.js vs
 * liveDetect.ts). Each was a real divergence or a near one:
 *   - the desktop sends tier NAMES and the server clamps model IDS, so
 *     clampModel('thorough', 'pro') is the free model — every paying desktop
 *     user would have been served nano had the route not translated first;
 *   - problemKind.ts left two kinds out of SEVERITY and sorted them first;
 *   - the two detect gates measured length differently.
 *
 * Desktop files are imported where they are leaves and read as text where
 * they are not (problemCopy.ts has @shared value imports). Skips, never
 * fails, when ../../src is absent — the ~/tracely dev copy has no desktop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as srvPlan from "../shared/plan.js";
import * as marks from "../shared/marks.js";
import { GUARDS, detectGate } from "../shared/guards.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = path.join(ROOT, "src");
const EXT = path.join(ROOT, "extension");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

let SKIP = false;
if (!existsSync(path.join(SRC, "shared", "plan.ts"))) SKIP = `no desktop tree at ${SRC}`;
else if (!process.features?.typescript) SKIP = `this Node (${process.version}) cannot strip TypeScript types`;

const load = async (rel) => (SKIP ? null : import(pathToFileURL(path.join(SRC, rel)).href));
const deskPlan = await load("shared/plan.ts");
const deskKind = await load("shared/problemKind.ts");
const deskLive = await load("shared/liveDetect.ts");

/* ── plan ────────────────────────────────────────────────────────────────── */

test("plan vocabulary and the model map are identical on desktop and server", { skip: SKIP }, () => {
  assert.deepEqual([...deskPlan.PLANS], srvPlan.PLANS);
  assert.equal(deskPlan.DEFAULT_PLAN, srvPlan.DEFAULT_PLAN);
  assert.deepEqual([...deskPlan.MODEL_TIERS], srvPlan.MODEL_TIERS);
  assert.deepEqual(deskPlan.PLAN_MODEL_CEILING, srvPlan.PLAN_MODEL_CEILING);
  assert.deepEqual({ ...deskPlan.MODEL_FOR_TIER }, srvPlan.MODEL_FOR_TIER);
});

test("desktop and server read a plan off the same inputs the same way", { skip: SKIP }, () => {
  const values = ["pro", " Pro ", "STUDENT", "free", "enterprise", "", null, undefined, 7, {}];
  for (const v of values) assert.equal(deskPlan.normalizePlan(v), srvPlan.normalizePlan(v), `normalizePlan(${JSON.stringify(v)})`);
  const metadata = [{ plan: "pro" }, { plan: " Student " }, {}, { plan: null }, { plan: 42 }, "pro", null, undefined, { user_metadata: { plan: "pro" } }];
  for (const m of metadata) assert.equal(deskPlan.planFromMetadata(m), srvPlan.planFromMetadata(m), `planFromMetadata(${JSON.stringify(m)})`);
});

test("the server never downgrades the model the desktop resolved", { skip: SKIP }, () => {
  for (const plan of srvPlan.PLANS) {
    for (const pref of [...srvPlan.MODEL_TIERS, "balanced", "junk", null, undefined]) {
      const model = deskPlan.MODEL_FOR_TIER[deskPlan.resolveModelTier(pref, plan)];
      assert.equal(srvPlan.clampModel(model, plan), model, `${plan} / ${pref}: desktop sent ${model}`);
    }
    // A settings row an older desktop wrote as 'balanced' (the retired tier)
    // sends the fast id, exactly as the server reads that build's terra id.
    assert.equal(deskPlan.MODEL_FOR_TIER[deskPlan.resolveModelTier("balanced", plan)], srvPlan.currentModelId("gpt-5.6-terra"), plan);
  }
});

test("a tier NAME is not a model id — the desktop must translate before it sends", () => {
  // Pins why MODEL_FOR_TIER exists on the desktop at all: clampModel knows ids.
  for (const plan of srvPlan.PLANS) {
    for (const tier of srvPlan.MODEL_TIERS) assert.equal(srvPlan.clampModel(tier, plan), srvPlan.MODEL_FOR_TIER.fast);
  }
});

test("desktop and server word a reset date the same way (the Thorough meter's resetsOn)", { skip: SKIP }, () => {
  for (const ymd of ["2026-10-01", "2027-01-01", "2026-02-28", "not-a-date", ""]) {
    assert.equal(deskPlan.monthDayLabel(ymd), srvPlan.monthDayLabel(ymd), ymd);
  }
  assert.equal(deskPlan.monthDayLabel("2026-10-01"), "Oct 1");
});

test("the extension's plan copies agree with the plan", () => {
  const bg = read("extension", "background.js");
  assert.match(bg, /const PLANS = \["free", "student", "pro"\];/);
  // content.js has no plan ladder since 2.20.0 (models.test.js pins its
  // CHECK_MODEL); the options page keeps its slider until the same release.
  for (const f of ["options.js"]) {
    const src = read("extension", f);
    const m = src.match(/const PLAN_MAX_STOP = \{\s*free:\s*(\d),\s*student:\s*(\d),\s*pro:\s*(\d)\s*\}/);
    assert.ok(m, `${f}: PLAN_MAX_STOP not found`);
    const stops = { free: +m[1], student: +m[2], pro: +m[3] };
    // The extension still has its THREE-stop ladder (terra on the middle stop)
    // until 2.20.0 replaces the slider, so a stop index no longer equals a
    // server tier index. What must hold: the model at each plan's top stop is
    // one the server maps to that plan's ceiling tier (Student's Balanced stop
    // sends terra, which the server now reads as fast). 2.20.0 realigns them.
    const src2 = read("extension", f);
    const ladder = f === "options.js"
      ? [...src2.match(/const MODELS = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
      : [...src2.match(/const SPEED_STOPS = \[([\s\S]*?)\];/)[1].matchAll(/model: "([^"]+)"/g)].map((x) => x[1]);
    const tierOf = (id) => srvPlan.TIER_FOR_MODEL[id] ?? srvPlan.LEGACY_MODEL_TIER[id] ?? null;
    for (const plan of srvPlan.PLANS) {
      assert.equal(tierOf(ladder[stops[plan]]), srvPlan.PLAN_MODEL_CEILING[plan], `${f}: ${plan}'s top stop maps to the wrong tier`);
    }
  }
});

test("the plans' advertised allowances are the ones the server meters", { skip: SKIP }, () => {
  // The section 7 copy of the 2026-09-21 plan policy: every number it states
  // is the one the server meters.
  const free = deskPlan.PLAN_INCLUDES.free.join(" | ");
  const searches = free.match(/(\d+) source searches a day \((\d+) a month\)/);
  assert.ok(searches, `free plan copy no longer states its source allowance: ${free}`);
  assert.equal(Number(searches[1]), srvPlan.FREE_DAILY_SOURCE_SEARCHES);
  assert.equal(Number(searches[2]), srvPlan.monthlySourceSearchLimit("free"));
  const daily = free.match(/(\d+) checks and (\d+) AI actions a day/);
  assert.ok(daily, `free plan copy no longer states its check and AI allowance: ${free}`);
  assert.equal(Number(daily[1]), srvPlan.dailyCheckLimit("free"));
  assert.equal(Number(daily[2]), srvPlan.dailyAiLimit("free"));
  for (const plan of ["student", "pro"]) {
    const copy = deskPlan.PLAN_INCLUDES[plan].join(" | ");
    const month = copy.match(/(\d+) source searches a month/);
    assert.ok(month, `${plan} plan copy no longer states its monthly searches: ${copy}`);
    assert.equal(Number(month[1]), srvPlan.monthlySourceSearchLimit(plan), plan);
    assert.ok(!/unlimited/i.test(copy), `${plan} is no longer sold as unlimited: ${copy}`);
    // "No daily check or AI-action limit (fair use)": unmetered per day, bounded by fair use.
    assert.equal(srvPlan.dailyCheckLimit(plan), null, plan);
    assert.equal(srvPlan.dailyAiLimit(plan), null, plan);
    assert.ok(srvPlan.fairUseLimits(plan), `${plan} has no fair-use limit behind "no daily limit"`);
  }
  assert.ok(deskPlan.PLAN_INCLUDES.student.some((s) => /no daily check or AI-action limit \(fair use\)/i.test(s)));
  assert.ok(deskPlan.PLAN_INCLUDES.pro.some((s) => /Thorough/.test(s) && /monthly allowance/.test(s)));
  assert.ok(srvPlan.thoroughMonthlyUsd("pro") > 0 && srvPlan.thoroughMonthlyUsd("student") === 0);
  const ext = read("extension", "options.js").match(/const PLAN_LABEL = (\{[^}]+\})/);
  assert.ok(ext);
  assert.deepEqual(JSON.parse(ext[1].replace(/(\w+):/g, '"$1":')), deskPlan.PLAN_LABEL);
});

/* ── marks ───────────────────────────────────────────────────────────────── */

function deskCopy() {
  const src = read("src", "renderer", "src", "components", "problemCopy.ts");
  const consts = Object.fromEntries([...src.matchAll(/export const (DESIGN_\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const block = (name) => src.slice(src.indexOf(`export const ${name}`), src.indexOf("\n}\n", src.indexOf(`export const ${name}`)));
  const labels = Object.fromEntries([...block("PROBLEM_LABEL").matchAll(/^\s*'?([a-z-]+)'?: '([^']+)'/gm)].map((m) => [m[1], m[2]]));
  const colorBlock = src.slice(src.indexOf("DESIGN_RED,") > 0 ? src.lastIndexOf("Record<ScreenWatchProblemKind, string> = {", src.indexOf("'fabricated-citation': DESIGN_")) : 0);
  const colors = Object.fromEntries([...colorBlock.matchAll(/^\s*'?([a-z-]+)'?: (DESIGN_\w+)/gm)].map((m) => [m[1], consts[m[2]]]));
  return { labels, colors };
}

test("every server mark exists on the desktop with the same label and colour", { skip: SKIP }, () => {
  const { labels, colors } = deskCopy();
  for (const k of marks.PROBLEM_KINDS) {
    assert.equal(labels[k.kind], k.label, `label of ${k.kind}`);
    if (k.kind !== "searching") assert.equal(colors[k.kind], marks.COLORS[k.color], `colour of ${k.kind}`);
  }
  const serverKinds = new Set(marks.PROBLEM_KINDS.map((k) => k.kind));
  assert.deepEqual(Object.keys(labels).filter((k) => !serverKinds.has(k)), ["off-topic"], "desktop-only kinds changed");
});

test("the server ranks its marks in the desktop's severity order", { skip: SKIP }, () => {
  const server = marks.PROBLEM_KINDS.map((k) => k.kind);
  for (const k of server) assert.ok(deskKind.problemSeverity(k) >= 0, `${k} is unranked on the desktop`);
  const desktopOrder = [...server].sort((a, b) => deskKind.problemSeverity(a) - deskKind.problemSeverity(b));
  assert.deepEqual(server, desktopOrder);
});

/* ── live detect ─────────────────────────────────────────────────────────── */

test("the live-detect thresholds are the same on both sides", { skip: SKIP }, () => {
  assert.equal(GUARDS.detect.idleMs, deskLive.DETECT_IDLE_MS);
  assert.equal(GUARDS.detect.minChars, deskLive.MIN_DETECT_CHARS);
  assert.equal(GUARDS.detect.minDelta, deskLive.MIN_DETECT_DELTA_CHARS);
  assert.equal(GUARDS.detect.minIntervalMs, deskLive.MIN_DETECT_INTERVAL_MS);
});

test("the two detect gates give the same answer on the same history", { skip: SKIP }, () => {
  const base = "x".repeat(120);
  const T = 1_000_000;
  const cases = [
    { text: "x".repeat(79), last: null, at: null, now: T },
    { text: base, last: null, at: null, now: T },
    { text: base, last: base, at: T - 60_000, now: T },
    { text: base + "y".repeat(79), last: base, at: T - 60_000, now: T },
    { text: base + "y".repeat(80), last: base, at: T - 60_000, now: T },
    { text: base, last: base + "y".repeat(90), at: T - 60_000, now: T },
    { text: base + "y".repeat(80), last: base, at: T - 14_999, now: T },
    { text: base + "y".repeat(80), last: base, at: T - 15_000, now: T },
    // Whitespace: both sides measure the TRIMMED draft.
    { text: "x".repeat(79) + "     ", last: null, at: null, now: T },
    { text: "  " + base + "  ", last: base, at: T - 60_000, now: T },
  ];
  for (const c of cases) {
    const gate = detectGate();
    if (c.last !== null) gate.stamp(c.last, c.at);
    const server = gate.shouldRun(c.text, c.now);
    const desktop = deskLive.shouldDetectNow({ text: c.text, lastDetectedText: c.last, lastDetectAt: c.at, now: c.now });
    assert.equal(server, desktop, `disagree on ${JSON.stringify({ len: c.text.length, last: c.last?.length ?? null, gap: c.at === null ? null : c.now - c.at })}`);
  }
});
