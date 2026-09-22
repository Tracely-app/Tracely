/**
 * Extension 2.20.0: the Faster↔Smarter slider is gone, "Explain in depth"
 * arrives, and the flow cadence matches the server's.
 *
 * The extension has no test runner and no build step, so — like the other
 * ext-*.test.js files — these load the real source into a vm context with
 * stubs and drive it. What is pinned:
 *   - neither widget renders a speed bar, and both render the deep button;
 *   - every request names the fast model and sends no effort, and the deep
 *     request is {text, sentences:[one], deep:true} and nothing else;
 *   - the locked state, the differing-verdict prefix, and one answer per
 *     sentence hash per session (the allowance is not spent twice on the
 *     same sentence);
 *   - each reason the server falls back to the standard model gets its own
 *     note — spent, paused for fair use, or too little left for this call —
 *     and a verdict contradicting the card's badge is shown only when the
 *     card can say which model reached it;
 *   - flowSignature ignores typing at the END of the document but not a
 *     paragraph added, cut, reordered, or grown by a block of prose, and the
 *     floor clears the server's 120 s;
 *   - the options page's section 7 copy in each of its states.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = [path.join(HERE, "..", "extension"), path.join(HERE, "..", "..", "extension")]
  .find((dir) => existsSync(path.join(dir, "background.js")));
const read = (f) => {
  assert.ok(EXT, "could not locate extension/ from " + HERE);
  return readFileSync(path.join(EXT, f), "utf8");
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 0));

function slice(file, from, to) {
  const src = read(file);
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${file}: could not find ${from} .. ${to}`);
  return src.slice(a, b);
}
const content = (from, to) => slice("content.js", from, to);

// The shared pieces every widget/deep test needs: esc, the deep module.
const SHARED = () => content("  function esc(s) {", "  // Carry [n] citation markers")
  + content('  /* ── "Explain in depth" (2.20.0)', "  /* ── shared helpers");

const VERDICT_LABEL = { false: "False", questionable: "Questionable", incoherent: "Doesn't make sense", needs_citation: "Citation needed" };
const VERDICT_WASH = { false: "#fdecec", questionable: "#fff4d6", incoherent: "#f1e6fb", needs_citation: "#e8f0fd" };
const VERDICT_TEXT = { false: "#d93636", questionable: "#a67500", incoherent: "#8e4ec6", needs_citation: "#2563eb" };
const FREE_TIER = { plan: "free", unenforced: false, beta: false, provisional: false };
const PRO_TIER = { plan: "pro", unenforced: false, beta: false, provisional: false };

/* ── "Explain in depth" ─────────────────────────────────────────────────── */

function loadDeep({ tier = PRO_TIER, answer = null, fail = null } = {}) {
  const calls = [];
  const opened = [];
  const ctx = vm.createContext({
    MAX_INPUT_CHARS: 30_000,
    ORDER_URL: "https://jointracely.com/order",
    openOrderPage: () => opened.push(1),
    VERDICT_LABEL,
    tier: { ...tier },
    api: async (path, body) => {
      calls.push({ path, body: plain(body) });
      if (fail) throw Object.assign(new Error(fail.message ?? "no"), { kind: fail.kind });
      return answer;
    },
  });
  const api = vm.runInContext(
    SHARED() + ";({ explainInDepth, deepView, deepHtml, canDeep, lockDeep, forgetDeepLocks, deepCache, DEEP_COPY, setTier(t) { tier = { ...tier, ...t }; } })",
    ctx,
  );
  return { api, calls, opened };
}

const ANSWER = (verdict, explanation, thorough) => ({
  findings: [{ id: "s1", verdict, explanation }],
  modelUsed: "gpt-6-astra",
  ...(thorough ? { thorough } : {}),
});

test("Explain in depth sends one sentence, deep:true, and no model or effort", async () => {
  const d = loadDeep({ answer: ANSWER("false", "A fuller explanation.", { used: true, remainingPct: 71, resetsOn: "2026-10-01" }) });
  await d.api.explainInDepth("s1", "The sky is green.", "the whole document", "false", () => {});
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].path, "/api/check");
  assert.deepEqual(d.calls[0].body, {
    text: "the whole document",
    sentences: [{ id: "s1", text: "The sky is green." }],
    deep: true,
  });
});

test("the deeper explanation replaces the button, and says nothing extra when the verdict holds", async () => {
  const d = loadDeep({ answer: ANSWER("false", "A fuller explanation.", { used: true, remainingPct: 71, resetsOn: "2026-10-01" }) });
  const seen = [];
  await d.api.explainInDepth("s1", "The sky is green.", "doc", "false", () => seen.push(d.api.deepView("s1", "false").kind));
  assert.deepEqual(seen, ["loading", "result"], "the loading state must show in place first");
  const v = d.api.deepView("s1", "false");
  assert.equal(v.text, "A fuller explanation.");
  assert.equal(v.prefix, "");
  assert.equal(v.verdictLabel, "");
  assert.equal(v.note, "");
  const html = d.api.deepHtml("s1", "false");
  assert.ok(html.includes("A fuller explanation.") && html.includes("In depth"), html);
  assert.ok(!html.includes("Explain in depth"), "the button is still offered beside its own answer");
});

test("a differing verdict is introduced as the largest model's reading", async () => {
  const d = loadDeep({ answer: ANSWER("questionable", "It is more complicated.", { used: true, remainingPct: 40, resetsOn: "2026-10-01" }) });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  const v = d.api.deepView("s1", "false");
  assert.equal(v.prefix, "Our largest model reads this differently:");
  assert.equal(v.verdictLabel, "Questionable");
  assert.equal(v.note, "");
  assert.ok(d.api.deepHtml("s1", "false").includes("badge-quest"), "the new verdict is shown as a badge");
});

test("a spent allowance is answered by the standard model, and says so", async () => {
  // thorough.used === false: the answer is the fast model's, so it must not
  // be introduced as the largest model's reading even when the verdict moves.
  const d = loadDeep({ answer: { findings: [{ id: "s1", verdict: "questionable", explanation: "Still worth a look." }], modelUsed: "gpt-5.6-luna", thorough: { used: false, remainingPct: 0, resetsOn: "2026-10-01" } } });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  const v = d.api.deepView("s1", "false");
  assert.equal(v.note, "This month's Thorough allowance is used up — this explanation is from the standard model.");
  assert.equal(v.prefix, "", "the standard model's verdict is not the largest model's reading");
  assert.equal(v.verdictLabel, "Questionable", "the verdict it did reach is still shown");
  assert.ok(d.api.deepHtml("s1", "false").includes("allowance is used up"), "the note reaches the card");
});

test("a fair-use pause is not reported as a spent allowance", async () => {
  // suspended: the allowance is OFF for the month, not used up — the meter
  // still shows most of it, and §7 promises the plan is unchanged.
  const thorough = { used: false, remainingPct: 71, resetsOn: "2026-10-01", suspended: true };
  const d = loadDeep({ answer: { findings: [{ id: "s1", verdict: "false", explanation: "Still wrong." }], modelUsed: "gpt-5.6-luna", thorough } });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  assert.equal(d.api.deepView("s1", "false").note, d.api.DEEP_COPY.paused);
  assert.ok(!d.api.deepView("s1", "false").note.includes("used up"), "71% left was called used up");
});

test("an allowance too small for this one call says that, not that it is spent", async () => {
  const thorough = { used: false, remainingPct: 6, resetsOn: "2026-10-01" };
  const d = loadDeep({ answer: { findings: [{ id: "s1", verdict: "false", explanation: "Still wrong." }], modelUsed: "gpt-5.6-luna", thorough } });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  assert.equal(d.api.deepView("s1", "false").note, d.api.DEEP_COPY.short);
});

test("a server that reports no provenance shows no contradicting verdict", async () => {
  // `node server.js` answers with modelUsed and no `thorough` at all. The
  // card cannot say which reading is which, so it must not print both.
  const d = loadDeep({ answer: { findings: [{ id: "s1", verdict: "questionable", explanation: "It is more complicated." }], modelUsed: "gpt-5.6-luna" } });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  const v = d.api.deepView("s1", "false");
  assert.equal(v.prefix, "");
  assert.equal(v.note, "");
  assert.equal(v.verdictLabel, "", "a verdict contradicting the card's own badge, with nothing to tell them apart");
  assert.ok(d.api.deepHtml("s1", "false").includes("It is more complicated."), "the explanation itself still shows");
});

test("Free and Student see a locked button with the Pro tooltip, and no request is made", async () => {
  for (const tier of [FREE_TIER, { ...FREE_TIER, plan: "student" }]) {
    const d = loadDeep({ tier, answer: ANSWER("false", "x") });
    assert.equal(d.api.canDeep(), false, tier.plan);
    const v = d.api.deepView("s1", "false");
    assert.equal(v.kind, "locked");
    assert.equal(v.title, "Thorough explanations come with Pro");
    const html = d.api.deepHtml("s1", "false");
    assert.ok(html.includes('title="Thorough explanations come with Pro"') && html.includes('data-deep-locked="s1"'), html);
    // Clicking it says why, with a way to the plans — and still calls nothing.
    d.api.lockDeep("s1");
    assert.ok(d.api.deepHtml("s1", "false").includes("See plans"), "no way to the plans from the locked state");
    await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
    assert.deepEqual(d.calls, [], `${tier.plan} spent a request on a locked button`);
  }
});

test("Pro, a beta tester and an unenforced local server are all offered it", () => {
  for (const tier of [PRO_TIER, { ...FREE_TIER, beta: true }, { ...FREE_TIER, unenforced: true }]) {
    const d = loadDeep({ tier });
    assert.equal(d.api.canDeep(), true, JSON.stringify(tier));
    assert.equal(d.api.deepView("s1", "false").kind, "button");
  }
});

test("a 403 plan_required shows the locked copy, and a plan change clears it", async () => {
  const d = loadDeep({ fail: { kind: "plan_required", message: "Explain in depth comes with Pro." } });
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  const v = d.api.deepView("s1", "false");
  assert.equal(v.kind, "locked");
  assert.equal(v.note, "Thorough explanations come with Pro");
  d.api.forgetDeepLocks(); // what a tier change runs
  assert.equal(d.api.deepView("s1", "false").kind, "button", "an upgrade must not leave the button locked");
});

test("one answer per sentence hash per session — re-hovering never re-spends", async () => {
  const d = loadDeep({ answer: ANSWER("false", "A fuller explanation.", { used: true, remainingPct: 71, resetsOn: "2026-10-01" }) });
  for (let i = 0; i < 3; i++) await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  assert.equal(d.calls.length, 1, "the allowance was spent again on the same sentence");
  // A different sentence is its own answer.
  await d.api.explainInDepth("s2", "Another claim.", "doc", "questionable", () => {});
  assert.equal(d.calls.length, 2);
  assert.deepEqual(d.calls[1].body.sentences, [{ id: "s2", text: "Another claim." }]);
});

test("a call still in flight is not started twice; a failure can be retried", async () => {
  const d = loadDeep({ answer: ANSWER("false", "A fuller explanation.") });
  const first = d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {}); // while loading
  await first;
  assert.equal(d.calls.length, 1);

  const bad = loadDeep({ fail: { message: "server said no" } });
  await bad.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  const v = bad.api.deepView("s1", "false");
  assert.equal(v.kind, "button");
  assert.equal(v.error, "Couldn't get a deeper explanation — try again.");
  await bad.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
  assert.equal(bad.calls.length, 2, "a failure must be retryable");
});

test("an answer with no explanation is a failure, not an empty card", async () => {
  for (const answer of [{ findings: [] }, { findings: [{ id: "s1", verdict: "false", explanation: "" }] }, {}]) {
    const d = loadDeep({ answer });
    await d.api.explainInDepth("s1", "A claim.", "doc", "false", () => {});
    assert.equal(d.api.deepView("s1", "false").kind, "button", JSON.stringify(answer));
  }
});

/* ── the two widgets' panels ────────────────────────────────────────────── */

// A shadow root that answers every lookup with an inert element.
function fakeShadow() {
  const el = () => ({ addEventListener() {}, dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, scrollTop: 0, value: "0" });
  return { getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [] };
}

const ISSUE = { seg: { hash: "s1", text: "The sky is green." }, f: { verdict: "false", explanation: "It is blue.", revision: "The sky is blue." } };

function widgetContext(tier) {
  const root = { innerHTML: "", style: {} };
  return {
    root,
    ctx: {
      root,
      shadow: fakeShadow(),
      PLANE_SVG: "<svg></svg>",
      VERDICT_LABEL,
      MAX_INPUT_CHARS: 30_000,
      ORDER_URL: "https://jointracely.com/order",
      openOrderPage() {},
      api: async () => ({}),
      tier: { ...tier },
      CHECK_INTERVAL_MS: 10_000,
      sourcesMap: new Map(),
      cache: new Map([[ISSUE.seg.hash, ISSUE.f]]),
      segments: [ISSUE.seg],
      dismissed: new Set(),
      console,
      Date,
    },
  };
}

function renderDocsPanel(tier) {
  const { root, ctx } = widgetContext(tier);
  const code = `
    let orphaned = false, expanded = true, panelWasOpen = false, undoShown = false;
    let inflight = false, lastCheckEnd = 0, statusKind = "idle", statusMsg = "all clear";
    let copiedFixHash = null, docBusy = false, lastDocEdit = null, docText = "a document";
    const DISMISS_KEY = "k";
    const lsSet = () => true;
    const currentIssues = () => [${JSON.stringify(ISSUE)}];
    const activeFlowIssues = () => [];
    const flowHashOf = () => "f1";
    const canEditDoc = () => false;
    const editBtnHtml = () => "", editNoteHtml = () => "";
    const orphanPillHtml = () => "<div class='pill'></div>";
    const settings = { citationStyle: "apa", autoSources: false };
    const formatCitation = () => ({ ref: "", inText: "" });
    const CITE_STYLES = [];
    const persistSettings = () => {};
    const SETTINGS_KEY = "k";
    const copyText = () => {};
    const fetchSources = () => {};
    const citeUrlWidget = () => {};
    const cycle = () => {};
    const requestDocsMarks = () => {};
    const undoLastDocEdit = () => {};
    const docFix = () => {}, docCite = () => {}, addTransition = () => {};
    const renderPopDeep = () => {};
    ${SHARED()}
    ${content('    function render() {\n      if (orphaned)', "    function saveSettings() {")}
    ({ render, explainSentence })`;
  const api = vm.runInContext(code, vm.createContext(ctx));
  api.render();
  return root.innerHTML;
}

test("the Docs panel has no speed bar, and offers Explain in depth", () => {
  const html = renderDocsPanel(PRO_TIER);
  for (const gone of ["speedbar", "speedSel", "sb-track", "Faster", "Smarter", 'type="range"']) {
    assert.ok(!html.includes(gone), `the Docs panel still renders ${gone}`);
  }
  assert.ok(html.includes("It is blue."), "the panel did not render its card");
  assert.ok(html.includes('data-deep="s1"') && html.includes("Explain in depth"), html.slice(0, 400));

  const free = renderDocsPanel(FREE_TIER);
  assert.ok(free.includes('data-deep-locked="s1"') && free.includes("Thorough explanations come with Pro"), "Free gets the locked button");
  assert.ok(!free.includes('data-deep="s1"'), "Free was offered the live button");
});

function renderFieldPanel(tier) {
  const { root, ctx } = widgetContext(tier);
  const code = `
    let orphaned = false, expanded = true, panelWasOpen = false, checkedOnce = true;
    let inflight = false, lastCheckEnd = 0, statusKind = "idle", statusMsg = "all clear";
    let copiedFixHash = null, fieldText = "a field";
    const widget = { shadow, root };
    const tracked = {};
    const fieldFixed = new Set();
    const DISMISS_KEY = "k";
    const lsSet = () => true;
    const scheduleMarks = () => {};
    const siteEnabled = () => true;
    const setSiteEnabled = () => {};
    const fieldEligible = () => true;
    const currentIssues = () => [${JSON.stringify(ISSUE)}];
    const orphanPillHtml = () => "<div class='pill'></div>";
    const settings = { citationStyle: "apa", autoSources: false };
    const formatCitation = () => ({ ref: "", inText: "" });
    const persistSettings = () => {};
    const SETTINGS_KEY = "k";
    const copyText = () => {};
    const fetchSources = () => {};
    const citeUrlWidget = () => {};
    const fixInField = () => {};
    const cycle = () => {};
    ${SHARED()}
    ${content('    function render() {\n      scheduleMarks();', "    function saveSettings() {")}
    ({ render, explainSentence })`;
  const api = vm.runInContext(code, vm.createContext(ctx));
  api.render();
  return root.innerHTML;
}

test("the field-mode panel has no speed bar, and offers Explain in depth", () => {
  const html = renderFieldPanel(PRO_TIER);
  for (const gone of ["speedbar", "speedSel", "sb-track", "Faster", "Smarter", 'type="range"']) {
    assert.ok(!html.includes(gone), `the field panel still renders ${gone}`);
  }
  assert.ok(html.includes("It is blue."), "the panel did not render its card");
  assert.ok(html.includes('data-deep="s1"') && html.includes("Explain in depth"), html.slice(0, 400));

  const free = renderFieldPanel(FREE_TIER);
  assert.ok(free.includes('data-deep-locked="s1"') && free.includes("Thorough explanations come with Pro"), "Free gets the locked button");
});

test("neither widget's CSS or markup keeps a speed bar rule", () => {
  const src = read("content.js");
  for (const gone of [".speedbar", ".sb-track", ".sb-lab", ".sb-dots", ".sb-pro", 'input[type="range"].speed', "speedbarHtml", "wireSpeedbar"]) {
    assert.ok(!src.includes(gone), `content.js still carries ${gone}`);
  }
});

/* ── flow cadence ───────────────────────────────────────────────────────── */

function loadFlow({ fail = null, issues = [] } = {}) {
  const calls = [];
  const state = { renders: 0, statusKind: "idle", statusMsg: "all clear" };
  const ctx = vm.createContext({
    harness: null,
    document: { hidden: false },
    MAX_INPUT_CHARS: 30_000,
    CHECK_MODEL: "gpt-5.6-luna",
    lsGet: () => null,
    lsSet: () => true,
    hashText: (s) => "h" + s.length,
    render: () => { state.renders++; },
    scheduleDocsMarks: () => {},
    api: async (path, body) => {
      calls.push({ path, body: plain(body) });
      if (fail) throw Object.assign(new Error("no"), { kind: fail });
      return { issues };
    },
  });
  const api = vm.runInContext(`
    const FCACHE_KEY = "fc";
    let docText = "", flowIssues = [], flowSig = "", flowAt = 0, flowInflight = false;
    let flowDismissed = new Set();
    ${content("    const FLOW_MIN_CHARS", "    function persistCaches()")}
    ({ flowSignature, requestFlow, FLOW_MIN_INTERVAL,
       setDoc(t) { docText = t; }, setFlowAt(v) { flowAt = v; },
       state: () => ({ flowSig, flowAt, issues: flowIssues.length }) })`, ctx);
  return { api, calls, state };
}

const PARA = (opening, n = 30) => `${opening} ` + Array.from({ length: n - 1 }, (_, i) => `word${i}`).join(" ");
const DOC = [PARA("Alpha starts here"), PARA("Beta follows on"), PARA("Gamma finishes it")].join("\n\n");

test("typing at the end of the document does not change the flow signature", () => {
  const { api } = loadFlow();
  const base = api.flowSignature(DOC);
  for (const typed of [DOC + " more", DOC + " more words still", `${DOC} and a whole further clause on the end.`]) {
    assert.equal(api.flowSignature(typed), base, `typing "${typed.slice(DOC.length)}" re-ran flow`);
  }
  // Deleting back into the last paragraph is the same edit from the other side.
  assert.equal(api.flowSignature(DOC.split(" ").slice(0, -2).join(" ")), base);
});

test("a growing last paragraph still moves the signature", () => {
  const { api } = loadFlow();
  // A draft with no paragraph breaks is the shape that most needs flow
  // feedback. Its signature must not be frozen by the first 400 characters:
  // the last paragraph's coarse length bucket has to carry the growth.
  const ONE = PARA("Alpha starts here", 60);
  assert.equal(api.flowSignature(ONE + " word60 word61"), api.flowSignature(ONE), "a few words typed re-ran flow");
  const grown = ONE + " " + Array.from({ length: 60 }, (_, i) => `later${i}`).join(" ");
  assert.notEqual(api.flowSignature(grown), api.flowSignature(ONE), "a single-paragraph draft can never re-run flow");
  // The same is true of the last paragraph of a many-paragraph document.
  const paras = DOC.split("\n\n");
  const longTail = [...paras.slice(0, -1), paras.at(-1) + " " + Array.from({ length: 60 }, (_, i) => `tail${i}`).join(" ")];
  assert.notEqual(api.flowSignature(longTail.join("\n\n")), api.flowSignature(DOC));
});

test("a paragraph added, cut or reordered does change it", () => {
  const { api } = loadFlow();
  const base = api.flowSignature(DOC);
  const paras = DOC.split("\n\n");
  assert.notEqual(api.flowSignature(DOC + "\n\n" + PARA("Delta arrives late")), base, "a new paragraph");
  assert.notEqual(api.flowSignature([PARA("Delta arrives first"), ...paras].join("\n\n")), base, "a paragraph inserted first");
  assert.notEqual(api.flowSignature(paras.slice(1).join("\n\n")), base, "a paragraph cut");
  assert.notEqual(api.flowSignature([paras[1], paras[0], paras[2]].join("\n\n")), base, "two paragraphs swapped");
  // An edit INSIDE an earlier paragraph's ending still counts: it is a seam.
  assert.notEqual(api.flowSignature([paras[0] + " tail end.", paras[1], paras[2]].join("\n\n")), base);
});

test("the flow floor clears the server's 120 s, and the call names the fast model", async () => {
  const f = loadFlow({ issues: [{ passage: "p", explanation: "e" }] });
  assert.ok(f.api.FLOW_MIN_INTERVAL > 120_000, "no margin over the server floor: a jittery second call is answered 429 flow_rate");
  f.api.setDoc(DOC);
  await f.api.requestFlow();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/api/flow");
  assert.equal(f.calls[0].body.model, "gpt-5.6-luna");
  assert.ok(!("effort" in f.calls[0].body), "a flow call must send no effort");
  assert.equal(f.api.state().issues, 1);

  // A new shape inside the interval waits; the same shape never asks again.
  f.api.setDoc(DOC + "\n\n" + PARA("Delta arrives late"));
  await f.api.requestFlow();
  assert.equal(f.calls.length, 1, "a flow call went out inside the 120 s floor");
  f.api.setFlowAt(Date.now() - 126_000);
  await f.api.requestFlow();
  assert.equal(f.calls.length, 2);
  await f.api.requestFlow();
  assert.equal(f.calls.length, 2, "an unchanged shape asked again");
});

test("a 429 flow_rate is silent, and the shape is retried an interval later", async () => {
  const f = loadFlow({ fail: "flow_rate" });
  f.api.setDoc(DOC);
  await f.api.requestFlow();
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.statusKind, "idle", "the checker's status line moved");
  assert.equal(f.state.statusMsg, "all clear");
  assert.equal(f.state.renders, 0, "a refused flow call repainted the widget");
  assert.equal(f.api.state().flowSig, "", "the shape must stay unanswered so it is retried");
  f.api.setFlowAt(Date.now() - 126_000);
  await f.api.requestFlow();
  assert.equal(f.calls.length, 2);
});

/* ── the options page ───────────────────────────────────────────────────── */

async function renderOptions(answer) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: false, disabled: false, textContent: "", className: "", href: "", value: "0",
        dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, addEventListener() {},
      });
    }
    return els.get(id);
  };
  for (const id of ["signedIn", "signedOut", "betaPlanOut", "acctBeta", "thoroughPro", "thoroughLocked", "thoroughMeter", "thoroughMeterText", "sourcesLine", "fairUseLine"]) el(id).hidden = true;
  const chrome = {
    runtime: { sendMessage: async (m) => (m.type === "tracely-entitlement" ? { ok: true, configured: true, ...answer } : { ok: true }) },
    storage: { local: { get: (d, cb) => cb?.({ ...d }), set() {}, remove() {} }, onChanged: { addListener() {} } },
  };
  vm.runInContext(read("options.js"), vm.createContext({
    chrome, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, AbortSignal, encodeURIComponent,
    fetch: async () => { throw new TypeError("offline"); },
    document: { getElementById: el, querySelectorAll: () => [] },
  }), { filename: "options.js" });
  await tick(); await tick();
  return el;
}

const PAID = { signedIn: true, email: "p@example.com", plan: "pro", unenforced: false };

test("options: the checking-model hint says every plan runs the same model", () => {
  const html = read("options.html");
  assert.match(html, /<h2>Checking model<\/h2>/);
  assert.match(html, /Every plan checks with the same model/);
  assert.match(html, /Bigger models weren’t better at catching false or uncited claims/);
  assert.match(html, /Thorough explanations \(Pro\)/);
  assert.match(html, /It comes from a monthly allowance; when that runs out, the standard model answers until the 1st\./);
});

test("options: Pro sees the Thorough meter with the percent left and the reset date", async () => {
  const $ = await renderOptions({ ...PAID, thorough: { remainingPct: 62, resetsOn: "2026-10-01", suspended: false } });
  assert.equal($("thoroughPro").hidden, false);
  assert.equal($("thoroughLocked").hidden, true);
  assert.equal($("thoroughMeter").hidden, false);
  assert.equal($("thoroughMeterText").textContent, "62% of this month's Thorough allowance left · resets Oct 1");
});

test("options: a spent allowance says what answers until the reset", async () => {
  const $ = await renderOptions({ ...PAID, thorough: { remainingPct: 0, resetsOn: "2026-11-01", suspended: false } });
  assert.equal($("thoroughMeterText").textContent, "This month's Thorough allowance is used up. Explanations use the standard model until Nov 1.");
});

/* A fair-use suspension turns Thorough off without spending a cent of the
   allowance. The meter is the only line on the page that speaks about
   Thorough, so if it keeps reporting the percentage it is the one thing
   telling a paying account it still has something it is not getting. */
test("options: a suspended allowance says paused, not how much is left", async () => {
  const $ = await renderOptions({
    ...PAID,
    thorough: { remainingPct: 71, resetsOn: "2026-10-01", suspended: true },
    fairUse: { state: "month", resetsOn: "2026-10-01" },
  });
  const text = $("thoroughMeterText").textContent;
  assert.match(text, /^Thorough is paused while this account is over its fair-use limit/);
  assert.match(text, /standard model until Oct 1/);
  assert.match(text, /71% of this month's allowance is still unused\./);
  assert.doesNotMatch(text, /used up/);
  assert.doesNotMatch(text, /71% of this month's Thorough allowance left/);
});

test("options: a daily fair-use trip pauses Thorough until midnight", async () => {
  const $ = await renderOptions({
    ...PAID,
    thorough: { remainingPct: 40, resetsOn: "2026-10-01", suspended: true },
    fairUse: { state: "day", resetsOn: "2026-09-23" },
  });
  assert.match($("thoroughMeterText").textContent, /standard model until midnight/);
});

test("options: Free and Student get the locked line instead", async () => {
  for (const plan of ["free", "student"]) {
    const $ = await renderOptions({ signedIn: true, email: "s@example.com", plan });
    assert.equal($("thoroughPro").hidden, true, plan);
    assert.equal($("thoroughLocked").hidden, false, plan);
    assert.equal($("thoroughMeter").hidden, true, plan);
  }
  assert.match(read("options.html"), /id="thoroughLocked"[^>]*>Thorough explanations come with Pro\. <a[^>]*>See plans →<\/a>/);
});

test("options: the source-search line is the server's own counting", async () => {
  const free = await renderOptions({
    signedIn: false, plan: "free",
    limits: { checksPerDay: 400, aiActionsPerDay: 150, flowPerDay: 40, sources: { day: 5, month: 40 } },
    usage: { sources: { today: 2, month: 12 } },
  });
  assert.equal(free("sourcesLine").hidden, false);
  assert.equal(free("sourcesLine").textContent, "Source searches: 2 of 5 today · 12 of 40 this month.");

  const pro = await renderOptions({
    ...PAID,
    limits: { checksPerDay: null, aiActionsPerDay: null, flowPerDay: 150, sources: { day: 40, month: 250 } },
    usage: { sources: { today: 3, month: 120 } },
  });
  assert.equal(pro("sourcesLine").textContent, "Source searches: 120 of 250 this month (37 left today).");
});

test("options: a fair-use period says so, and says the plan is unchanged", async () => {
  const month = await renderOptions({ ...PAID, fairUse: { state: "month", resetsOn: "2026-10-01" } });
  assert.equal(month("fairUseLine").hidden, false);
  assert.equal(
    month("fairUseLine").textContent,
    "You've reached this month's fair-use limit, so Tracely is running at Starter limits until Oct 1. Your plan and billing are unchanged.",
  );
  const day = await renderOptions({ ...PAID, fairUse: { state: "day", resetsOn: "2026-09-23" } });
  assert.match(day("fairUseLine").textContent, /today's fair-use limit, so Tracely is running at Starter limits until midnight/);
  const ok = await renderOptions({ ...PAID, fairUse: { state: "ok", resetsOn: null } });
  assert.equal(ok("fairUseLine").hidden, true, "an account inside its limits is told nothing");
});

test("options: a server that meters nothing is not made to look as if it does", async () => {
  // A plain `node server.js` (no Supabase) reports no limits, usage, thorough
  // or fairUse — and gates nothing, so Thorough is not locked either.
  const $ = await renderOptions({ signedIn: false, plan: "free", unenforced: true });
  assert.equal($("sourcesLine").hidden, true);
  assert.equal($("fairUseLine").hidden, true);
  assert.equal($("thoroughMeter").hidden, true);
  assert.equal($("thoroughMeterText").hidden, true);
  assert.equal($("thoroughPro").hidden, false);
  assert.equal($("thoroughLocked").hidden, true);
});

test("options: a signed-in Starter account is told what the paid plans add", async () => {
  const $ = await renderOptions({ signedIn: true, email: "f@example.com", plan: "free" });
  assert.equal(
    $("acctHint").textContent,
    "You're on Starter. Student removes the daily check limit and adds 100 source searches a month and auto-sources; Pro adds Thorough explanations.",
  );
});

/* ── the worker relays the server's metering ────────────────────────────── */

const EXT_ID = "dffmoeebkkghhgcklkbmaibfhgiegmdm";

function loadWorker(entitlement) {
  const data = {};
  const listeners = [];
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") return { [defaults]: data[defaults] };
          const out = {};
          for (const [k, v] of Object.entries(defaults)) out[k] = k in data ? data[k] : v;
          return out;
        },
        async set(obj) { Object.assign(data, obj); },
        async remove(k) { delete data[k]; },
      },
    },
    management: { async getSelf() { return { id: EXT_ID, installType: "normal" }; } },
    identity: {},
    tabs: { async create() { return { id: 1 }; } },
  };
  const fetch = async (url) => {
    if (new URL(url).pathname === "/api/entitlement") return { ok: true, status: 200, json: async () => entitlement };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const ctx = vm.createContext({ chrome, fetch, console, URL, URLSearchParams, AbortSignal, crypto: globalThis.crypto, setInterval: () => 0, setTimeout, clearTimeout });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });
  const ask = (sender) => new Promise((resolve) => { for (const fn of listeners) fn({ type: "tracely-entitlement", force: true }, sender, resolve); });
  return { ask, options: () => ask({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` }), page: () => ask({ id: EXT_ID, url: "https://docs.google.com/document/d/x/edit", tab: { id: 7 } }) };
}

const SERVER_ANSWER = {
  plan: "pro", email: null, userId: null, enforced: true,
  limits: { checksPerDay: null, aiActionsPerDay: null, flowPerDay: 150, sources: { day: 40, month: 250 } },
  usage: { sources: { today: 3, month: 120 } },
  thorough: { remainingPct: 62, resetsOn: "2026-10-01" },
  fairUse: { state: "ok", resetsOn: null },
};

test("the worker relays limits, usage, thorough and fairUse to both its pages", async () => {
  const w = loadWorker({ ...SERVER_ANSWER, beta: true });
  for (const answer of [await w.options(), await w.page()]) {
    assert.deepEqual(plain(answer.limits), SERVER_ANSWER.limits);
    assert.deepEqual(plain(answer.usage), SERVER_ANSWER.usage);
    assert.deepEqual(plain(answer.thorough), { remainingPct: 62, resetsOn: "2026-10-01", suspended: false });
    assert.deepEqual(plain(answer.fairUse), { state: "ok", resetsOn: null });
  }
  assert.equal((await w.page()).userId, null, "a content script still gets no account id");
});

test("a server that sends none of them, or nonsense, is relayed as none", async () => {
  const none = loadWorker({ plan: "pro", enforced: true, beta: true });
  const a = await none.options();
  assert.deepEqual([a.limits, a.usage, a.thorough, a.fairUse], [null, null, null, null]);

  const junk = loadWorker({
    plan: "pro", enforced: true, beta: true,
    limits: { checksPerDay: "lots", aiActionsPerDay: -4, flowPerDay: null, sources: { day: "5", month: 250 } },
    usage: { sources: { today: -1, month: 3.5 } },
    thorough: { remainingPct: "half", resetsOn: "soon" },
    fairUse: { state: "sometimes", resetsOn: "2026-10-01" },
  });
  const b = await junk.options();
  assert.deepEqual(plain(b.limits), { checksPerDay: null, aiActionsPerDay: null, flowPerDay: null, sources: { day: null, month: 250 } });
  assert.deepEqual(plain(b.usage), { sources: { today: 0, month: 3.5 } });
  assert.equal(b.thorough, null, "a percent that is not a number is not a meter");
  assert.equal(b.fairUse, null, "an unknown fair-use state says nothing");
});

test("a Thorough percent is clamped to a whole 0-100, and a bad date is dropped", async () => {
  const w = loadWorker({ plan: "pro", enforced: true, beta: true, thorough: { remainingPct: 128.6, resetsOn: "2026-13-99x", suspended: true } });
  assert.deepEqual(plain((await w.options()).thorough), { remainingPct: 100, resetsOn: null, suspended: true });
});

test("the options page words a reset date exactly as the server does", async () => {
  // The meter's date is the server's resetsOn, so "Oct 1" here and "Oct 1" in
  // a refusal message must be the same words.
  const { monthDayLabel } = await import("../shared/plan.js");
  const page = vm.runInContext(
    slice("options.js", "const MONTHS = [", "/* ── the account") + ";monthDayLabel",
    vm.createContext({}),
  );
  for (const ymd of ["2026-10-01", "2027-01-01", "2026-02-28"]) {
    assert.equal(page(ymd), monthDayLabel(ymd), ymd);
  }
  // A missing or malformed date still reads as a sentence, never as "null".
  for (const bad of ["", null, undefined, "next month"]) assert.equal(page(bad), "the 1st", String(bad));
});

test("options: a plan with a daily source allowance and no monthly one still reads", async () => {
  const $ = await renderOptions({
    signedIn: false, plan: "free",
    limits: { checksPerDay: 400, aiActionsPerDay: 150, flowPerDay: 40, sources: { day: 5, month: null } },
    usage: { sources: { today: 4, month: 9 } },
  });
  assert.equal($("sourcesLine").textContent, "Source searches: 4 of 5 today.");
});

/* The server reports per-CALLER metering on /api/entitlement — the Thorough
   allowance, fair use, searches used. Without the install header it has no
   caller to report about, so a signed-out Pro tester saw no allowance at all
   (found in a real browser against production: thorough came back null). */
test("the entitlement request carries the install id, like every relayed call", async () => {
  const src = read("background.js");
  const withBeta = src.slice(src.indexOf("async function withBeta"), src.indexOf("async function withBeta") + 400);
  assert.match(withBeta, /X-Tracely-Install/, "withBeta must add the install header");
  assert.match(withBeta, /await installId\(\)/);
  // Every /api/entitlement fetch goes through withBeta.
  for (const m of src.matchAll(/fetch\(`\$\{SERVER\}\/api\/entitlement`,\s*\{\s*headers:\s*([^}]+)/g)) {
    assert.match(m[1], /await withBeta\(/, `an entitlement fetch bypasses withBeta: ${m[1].slice(0, 60)}`);
  }
});
