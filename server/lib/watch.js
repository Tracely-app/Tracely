/**
 * macOS Screen Watch — the spec's Screen Watch adapted to macOS accessibility
 * (AX) via /usr/bin/osascript. Ships with the OS: no dependencies, no
 * compilation, no daemons — just System Events UI scripting under the user's
 * existing Accessibility grant.
 *
 * COST DOCTRINE (held here, hard): this is a passive/ambient surface, so it
 * may run claim DETECTION automatically (cheap model via pickModel("detect"),
 * floored at DETECT_FLOOR_MS, text-hash cached) and FREE evidence retrieval
 * automatically — but a paid critique NEVER runs unprompted. critiqueFinding()
 * only fires from the button-backed route. Counters stamp BEFORE calls.
 *
 * Exports:
 *   init({ pickModel })        wire the server's model tiering in
 *   readFocused()              → { app, role, text } | { app, role: null } | { error }
 *   writeFocused({ app, find, replacement }) → { ok } | { error }
 *   setEnabled(bool)           start/stop the 2.5s poll loop
 *   getState()                 the in-memory watch state
 *   critiqueFinding(key)       paid, on-demand — merges verdict/revision
 *   applyFix(key)              writeFocused sentence → revision
 *
 * MOCK MODE (TRACELY_MOCK=1): readFocused returns a canned TextEdit state
 * carrying the Great-Wall text so the UI is testable keylessly; writeFocused
 * mutates the canned text instead of touching the real screen.
 */
import { execFile } from "node:child_process";
import * as reasoning from "./reasoning.js";
import * as evidence from "./evidence.js";
import * as store from "./store.js";
import { hashKey } from "./db.js";
import { rollingCounter } from "../shared/guards.js";
import { problemsFor, markFor } from "../shared/marks.js";
import { CheckError } from "./factcheck.js";
import { MODEL_TIERS } from "./llm.js";
import { THOROUGH_MAX_TOKENS } from "../shared/plan.js";

const POLL_MS = 2500;             // ambient cadence — reads are free (local AX)
const STABLE_POLLS = 2;           // the spec's stable-ms: same text on 2 consecutive polls
const MIN_TEXT_CHARS = 80;        // below this there is nothing worth detecting
const DETECT_FLOOR_MS = 30_000;   // hard floor between paid-ish detection calls
const MAX_EVIDENCE_CLAIMS = 5;    // free retrieval, but still bounded (sequential)
const MAX_CACHE_ENTRIES = 40;
const TEXTY_ROLES = new Set(["AXTextArea", "AXTextField", "AXComboBox", "AXWebArea"]);

const isMock = () => process.env.TRACELY_MOCK === "1";

// ── osascript plumbing ─────────────────────────────────────────────────
// SEP is ASCII unit separator — it cannot appear in normal document text, so
// app/role/text survive multi-line values.
const SEP = String.fromCharCode(31);

// Static script, NOTHING interpolated — reads never carry user text into
// AppleScript source.
const READ_SCRIPT = `
on run
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    set roleName to ""
    set theText to missing value
    try
      set focusedEl to value of attribute "AXFocusedUIElement" of frontApp
      try
        set roleName to value of attribute "AXRole" of focusedEl
      end try
      if roleName is in {"AXTextArea", "AXTextField", "AXComboBox", "AXWebArea"} then
        try
          set theText to value of attribute "AXValue" of focusedEl
        end try
      end if
    end try
    set sep to character id 31
    if theText is missing value then
      return appName & sep & roleName
    else
      return appName & sep & roleName & sep & theText
    end if
  end tell
end run`;

// The new value arrives argv-style (item 1 of argv) — user text is NEVER
// string-interpolated into AppleScript source.
const WRITE_SCRIPT = `
on run argv
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set focusedEl to value of attribute "AXFocusedUIElement" of frontApp
    set value of attribute "AXValue" of focusedEl to (item 1 of argv)
  end tell
  return "ok"
end run`;

function runOsascript(script, extraArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script, ...extraArgs],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr ?? "");
          reject(err);
          return;
        }
        resolve(String(stdout ?? ""));
      }
    );
  });
}

// Two distinct failure classes: accessibility not granted (-25211 / "not
// allowed assistive access", or Automation consent -1743) vs everything else.
function isNoAccess(err) {
  const s = `${err?.message ?? ""} ${err?.stderr ?? ""}`;
  return /-25211|assistive access|-1743|not authorized to send apple events/i.test(s);
}

// ── mock surface ───────────────────────────────────────────────────────
const MOCK_APP = "TextEdit";
const MOCK_ROLE = "AXTextArea";
let mockText =
  "The Great Wall of China is the only man-made structure visible from space with the naked eye. " +
  "Every ancient civilization knew this, which is why the wall was built so wide.";

// ── read / write ───────────────────────────────────────────────────────
export async function readFocused() {
  if (isMock()) return { app: MOCK_APP, role: MOCK_ROLE, text: mockText };
  let out;
  try {
    out = await runOsascript(READ_SCRIPT, [], 3000);
  } catch (err) {
    if (isNoAccess(err)) return { error: "no-access" };
    return { error: "read-failed" };
  }
  const parts = out.replace(/\n$/, "").split(SEP);
  const app = parts[0] ?? "";
  const role = parts[1] || null;
  if (parts.length < 3 || !role) return { app, role: null };
  return { app, role, text: parts.slice(2).join(SEP) };
}

/**
 * Never blind-write: re-read the CURRENT focused value, verify the frontmost
 * app is still `app` and the text still contains `find` (the doc may have
 * changed), then set AXValue to the first-occurrence replacement.
 */
export async function writeFocused({ app, find, replacement } = {}) {
  if (typeof find !== "string" || !find || typeof replacement !== "string") {
    return { error: "bad-args" };
  }
  const cur = await readFocused();
  if (cur.error) return { error: cur.error };
  if (cur.app !== app) return { error: "app-changed" };
  if (typeof cur.text !== "string" || !cur.text.includes(find)) return { error: "text-changed" };
  // Function replacer so "$&" etc. in the revision are inert.
  const newText = cur.text.replace(find, () => replacement);
  if (isMock()) {
    mockText = newText;
    return { ok: true };
  }
  try {
    await runOsascript(WRITE_SCRIPT, [newText], 5000);
    return { ok: true };
  } catch (err) {
    if (isNoAccess(err)) return { error: "no-access" };
    return { error: "write-failed" };
  }
}

// ── watch state + loop ─────────────────────────────────────────────────
let deps = { pickModel: () => MODEL_TIERS.fast };
export function init(d = {}) {
  deps = { ...deps, ...d };
}

const state = {
  enabled: false,
  hasAccess: null,     // null = never read yet
  app: null,
  role: null,
  textPreview: "",
  updatedAt: null,
  findings: [],
};

const internals = new Map();    // finding key → { app, claim, sentence, state, kinds, sources, finding }
const detectCache = new Map();  // text hash → { findings, inner } — same text never re-detected
const watchCritiqueCounter = rollingCounter(60);

let timer = null;
let busy = false;
let pendingText = null;
let stablePolls = 0;
let processedHash = null;  // hash currently reflected in state.findings
let lastDetectAt = 0;      // the 30s floor — stamped BEFORE the call

function resetStability() {
  pendingText = null;
  stablePolls = 0;
}

function trimCache() {
  while (detectCache.size > MAX_CACHE_ENTRIES) {
    detectCache.delete(detectCache.keys().next().value);
  }
}

function adoptFindings(hash, built) {
  processedHash = hash;
  state.findings = built.findings;
  internals.clear();
  for (const [k, v] of built.inner) internals.set(k, v);
  state.updatedAt = Date.now();
}

async function buildFindings(claims, app) {
  const findings = [];
  const inner = new Map();
  // Sequential on purpose — ambient retrieval must not burst the free providers.
  for (const c of (Array.isArray(claims) ? claims : []).slice(0, MAX_EVIDENCE_CLAIMS)) {
    let ev;
    try {
      ev = await evidence.gatherEvidence({ claim: c.text, query: c.query, claimType: c.claimType });
    } catch {
      // A failed sweep is "could not search", never "no evidence".
      ev = { sources: [], strength: null, searched: { providers: [], failed: ["sweep"], aboveFloor: 0, citableAboveFloor: 0, outsideIndex: false } };
    }
    const searched = ev.searched ?? {};
    const claimState = {
      status: "checked",
      claimType: c.claimType,
      confidence: c.confidence,
      hasOwnCitation: false, // the AX surface carries raw text; citation parsing belongs to the app surfaces
      citationDefects: [],
      searched: (searched.providers ?? []).length > 0,
      sources: {
        count: (ev.sources ?? []).length,
        aboveFloor: searched.aboveFloor ?? 0,
        citableAboveFloor: searched.citableAboveFloor ?? 0,
        providers: searched.providers ?? [],
      },
      outsideIndex: Boolean(searched.outsideIndex),
      strength: ev.strength ?? null,
      critique: null, // NO automatic critique — ever (cost doctrine)
    };
    const kinds = problemsFor(claimState);
    const mark = markFor(claimState);
    if (!mark) continue; // clean claim — nothing to surface
    const key = hashKey(`watchfind|${c.text}|${c.start ?? ""}`).slice(0, 16);
    const finding = {
      key,
      claimText: c.text,
      sentence: c.sentence || c.text,
      kind: mark.kind,
      label: mark.label,
      color: mark.color,
      revision: null,
      sources: (ev.sources ?? []).slice(0, 3).map((s) => ({
        title: String(s.title ?? "").slice(0, 200),
        venue: String(s.venue ?? "").slice(0, 100),
        year: s.year ?? null,
        url: String(s.url ?? "").slice(0, 300),
      })),
    };
    findings.push(finding);
    inner.set(key, {
      app,
      claim: c.text,
      sentence: finding.sentence,
      state: claimState,
      kinds,
      sources: (ev.sources ?? []).slice(0, 4),
      finding,
    });
  }
  return { findings, inner };
}

async function pollOnce() {
  if (busy) return;
  busy = true;
  try {
    const r = await readFocused();
    state.updatedAt = Date.now();
    if (r.error === "no-access") {
      state.hasAccess = false;
      state.app = null;
      state.role = null;
      state.textPreview = "";
      resetStability();
      return;
    }
    if (r.error) return; // transient read failure — try again next poll
    state.hasAccess = true;
    state.app = r.app ?? null;
    state.role = r.role ?? null;
    const text = typeof r.text === "string" ? r.text : "";
    state.textPreview = text.slice(0, 200);

    // Gates: allow-list (empty list = nothing watched), texty role, floor length.
    const apps = store.prefs.get().watchApps;
    if (!Array.isArray(apps) || !apps.includes(state.app)) { resetStability(); return; }
    if (!r.role || !TEXTY_ROLES.has(r.role)) { resetStability(); return; }
    if (text.length < MIN_TEXT_CHARS) { resetStability(); return; }

    // Stability: identical text on STABLE_POLLS consecutive polls.
    if (text !== pendingText) {
      pendingText = text;
      stablePolls = 1;
      return;
    }
    stablePolls += 1;
    if (stablePolls < STABLE_POLLS) return;

    const hash = hashKey(`watch|${text}`);
    if (hash === processedHash) return;       // already reflected in state
    const cached = detectCache.get(hash);
    if (cached) { adoptFindings(hash, cached); return; } // same text never re-detected

    if (Date.now() - lastDetectAt < DETECT_FLOOR_MS) return; // floor holds; retry next poll
    lastDetectAt = Date.now(); // stamped BEFORE the call

    // The desktop's detector, over the watched text as a raw draft: claims come
    // back as whole sentences with their offsets, the same unit the desktop's
    // Screen Watch reads.
    const det = await reasoning.detectClaimsInDraft({ draft: text, model: deps.pickModel("detect") });
    const built = await buildFindings(det.claims ?? [], state.app);
    detectCache.set(hash, built);
    trimCache();
    adoptFindings(hash, built);
  } catch (err) {
    // The loop must never die to one bad cycle.
    console.error("[tracely] watch poll error:", err?.message ?? err);
  } finally {
    busy = false;
  }
}

export function setEnabled(enabled) {
  state.enabled = Boolean(enabled);
  if (state.enabled && !timer) {
    timer = setInterval(pollOnce, POLL_MS);
    timer.unref?.(); // never hold the process open
    pollOnce();      // populate state immediately instead of waiting a beat
  } else if (!state.enabled && timer) {
    clearInterval(timer);
    timer = null;
    resetStability();
  }
}

export function getState() {
  return { ...state };
}

// ── on-demand (button-only) paid critique ──────────────────────────────
export async function critiqueFinding(key) {
  const it = internals.get(key);
  if (!it) {
    throw new CheckError("not_found", "Unknown finding — the watched text may have changed", { status: 404 });
  }
  if (!watchCritiqueCounter.ok()) {
    throw new CheckError("rate_limit", "Critique hourly cap reached — try again later.", { status: 429, retryAfter: 600 });
  }
  watchCritiqueCounter.stamp(); // before the call
  // The desktop's five-pass critique. No reference lookup runs here, so the
  // "Reference lookup" section is absent and "fabricated" is unreachable —
  // which is right for text read off someone else's screen.
  // On the thorough model, the hosted critique's output ceiling
  // (THOROUGH_MAX_TOKENS), not the route's 16,000 — as server.js appCall.
  const model = deps.pickModel("critique");
  const result = await reasoning.critique({
    ...reasoning.critiqueInputFromSources({ claim: it.claim, sentence: it.sentence, sources: it.sources }),
    model, maxTokens: model === MODEL_TIERS.thorough ? THOROUGH_MAX_TOKENS.critique : undefined,
  });
  it.state.critique = { verdict: result.verdict, citationFix: result.citationFix ?? null };
  const f = it.finding;
  f.verdict = result.verdict;
  f.explanation = result.critique;
  f.revision = result.suggestedRevision || null;
  const mark = markFor(it.state);
  if (mark) {
    f.kind = mark.kind;
    f.label = mark.label;
    f.color = mark.color;
  } else {
    f.kind = "sound";
    f.label = "Looks sound";
    f.color = "grey";
  }
  state.updatedAt = Date.now();
  return f;
}

// ── fix: sentence → revision, through the guarded writer ───────────────
export async function applyFix(key) {
  const it = internals.get(key);
  if (!it) {
    throw new CheckError("not_found", "Unknown finding — the watched text may have changed", { status: 404 });
  }
  const f = it.finding;
  if (!f.revision) throw new CheckError("bad_request", "run the check first");
  const r = await writeFocused({ app: it.app, find: f.sentence, replacement: f.revision });
  if (!r.ok) {
    const messages = {
      "no-access": "Accessibility access is not granted",
      "app-changed": "The focused app changed — fix not applied",
      "text-changed": "The text changed since the check — fix not applied",
    };
    throw new CheckError("conflict", messages[r.error] ?? "Could not write the fix", {
      status: r.error === "no-access" ? 503 : 409,
    });
  }
  f.fixed = true;
  state.updatedAt = Date.now();
  return f;
}
