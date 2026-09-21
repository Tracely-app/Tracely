/**
 * Watch tab — the surface for the macOS watcher.
 *
 * The watcher backend reads the focused text field of allowed native apps
 * (TextEdit, Notes, Pages, …) through the Accessibility API and runs claim
 * DETECTION automatically. Per the cost doctrine, this tab only ever shows
 * the results of the cheap automatic passes (detection + free evidence
 * retrieval); a PAID critique fires exclusively from the "Check this claim"
 * button, and "Fix in <app>" only appears once that critique produced a
 * revision.
 *
 * Backend contract (same-origin; the backend may not exist yet — every fetch
 * failure renders a graceful "watch backend starting…" state):
 *   GET  /api/watch/state    → { enabled, hasAccess, app, role, textPreview,
 *                                updatedAt, findings:[{ key, claimText,
 *                                sentence, kind, label, color, revision,
 *                                sources:[{title,venue,year,url}], verdict?,
 *                                explanation?, fixed? }], watchApps:[] }
 *   POST /api/watch/toggle   { enabled }
 *   POST /api/watch/critique { key }   — PAID, button-only
 *   POST /api/watch/fix      { key }   — writes the revision back into the app
 *
 * Rendering model: the tab polls state every 2s while mounted (torn down on
 * hashchange / unmount, following analyze.js's teardown pattern). Mode changes
 * rebuild the body; inside the watching mode, finding cards are RECONCILED by
 * key rather than rebuilt, so in-flight button states survive polls and new
 * findings fade-slide in via the shell's .card animation.
 *
 * Colors: findings carry marks.js color NAMES; they are painted through the
 * var(--mark-*) theme tokens only — never raw hexes — so dark mode retunes.
 */
import { applyAppearance } from "/app/settings.js";

/* ── styles (injected once, namespaced under .watch-root) ───────────────── */

const STYLE_ID = "watch-style";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.dataset.tab = "watch";
  s.textContent = `
.watch-root { flex: 1; min-height: 0; overflow-y: auto; padding: var(--tab-pad, 32px); }
.watch-root [hidden] { display: none !important; } /* display:flex rules below must not defeat [hidden] */
.watch-root .watch-inner {
  max-width: 760px; margin: 0 auto; width: 100%;
  display: flex; flex-direction: column; gap: var(--tab-gap, 16px);
  padding-bottom: var(--s-6, 48px);
}

/* ── hero (disabled state) ── */
.watch-root .watch-hero {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: var(--s-2, 16px); padding: var(--s-6, 48px) var(--s-3, 24px) var(--s-2, 16px);
  animation: fade-slide var(--t-med, 200ms) var(--ease, ease) both;
}
.watch-root .watch-badge {
  width: 72px; height: 72px; border-radius: 22px; color: #fff;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--accent), var(--accent-deep));
  box-shadow: 0 2px 6px color-mix(in srgb, var(--accent-deep) 35%, transparent),
              0 12px 32px color-mix(in srgb, var(--accent) 28%, transparent);
}
.watch-root .watch-badge svg { width: 36px; height: 36px; }
.watch-root .watch-hero h1 {
  font-family: var(--serif); font-size: var(--fs-2xl, 32px);
  font-weight: 700; letter-spacing: -.3px;
}
.watch-root .watch-lead {
  color: var(--ink-dim); font-size: var(--fs-md, 15px); line-height: 1.65; max-width: 540px;
}
.watch-root .watch-hero .btn { margin-top: 4px; }

/* setup / no-access cards */
.watch-root .watch-setup { padding: var(--card-pad, 24px); text-align: left; }
.watch-root .watch-setup .eyebrow { display: block; margin-bottom: 8px; color: var(--accent-deep); }
.watch-root .watch-setup p { font-size: var(--fs-sm, 13.5px); color: var(--ink-dim); line-height: 1.6; }
.watch-root .watch-steps { margin: 10px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 7px; }
.watch-root .watch-steps li { font-size: var(--fs-sm, 13.5px); color: var(--ink-dim); line-height: 1.55; }
.watch-root .watch-path {
  font-family: var(--mono); font-size: var(--fs-xs, 12.5px); color: var(--ink);
  background: var(--bg-panel); border: 1px solid var(--line);
  border-radius: 5px; padding: 1px 6px; white-space: nowrap;
}
.watch-root .watch-setup .watch-actions { margin-top: var(--s-2, 16px); display: flex; gap: 8px; }

/* centered informational card (loading / offline) */
.watch-root .watch-center {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 10px; padding: var(--s-6, 48px) var(--s-3, 24px);
}
.watch-root .watch-center h3 { font-family: var(--serif); font-size: var(--fs-lg, 18px); font-weight: 600; }
.watch-root .watch-center p { font-size: var(--fs-sm, 13.5px); color: var(--ink-dim); line-height: 1.6; max-width: 420px; }
.watch-root .watch-pulse {
  width: 10px; height: 10px; border-radius: 50%; background: var(--accent);
  animation: watch-pulse 1.4s ease-in-out infinite;
}
@keyframes watch-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.72); } }

/* ── status strip (watching state) ── */
.watch-root .watch-strip {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px var(--card-pad, 24px);
}
.watch-root .watch-strip:hover { transform: none; box-shadow: var(--shadow); }
.watch-root .ws-eye { display: flex; color: var(--accent-deep); flex-shrink: 0; }
.watch-root .ws-eye svg { width: 18px; height: 18px; }
.watch-root .ws-app { font-weight: 700; font-size: var(--fs-sm, 13.5px); }
.watch-root .ws-sep { color: var(--line-strong); }
.watch-root .ws-ago {
  color: var(--ink-faint); font-size: var(--fs-xs, 12.5px);
  font-variant-numeric: tabular-nums;
}
.watch-root .ws-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.watch-root .ws-right .btn { padding: 4px 10px; font-size: var(--fs-xs, 12.5px); }

.watch-root .watch-preview {
  font-family: var(--serif); font-size: 13.5px; line-height: 1.6; color: var(--ink-dim);
  background: var(--bg-panel); border: 1px solid var(--line);
  border-radius: var(--radius-sm, 8px); padding: 10px 14px;
  white-space: pre-wrap; word-wrap: break-word;
  max-height: 132px; overflow: hidden;
}

/* ── finding cards ── */
.watch-root .watch-find { padding: var(--card-pad, 24px); display: flex; flex-direction: column; gap: 10px; }
.watch-root .wf-head { display: flex; align-items: center; gap: 8px; }
.watch-root .wf-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.watch-root .wf-label { font-weight: 700; font-size: var(--fs-sm, 13.5px); }
.watch-root .wf-sentence { font-family: var(--serif); font-size: 15px; line-height: 1.65; }
.watch-root .wf-sources { font-size: var(--fs-xs, 12.5px); color: var(--ink-faint); line-height: 1.6; }
.watch-root .wf-sources a { color: var(--accent-deep); text-decoration: none; }
.watch-root .wf-sources a:hover { text-decoration: underline; }
.watch-root .wf-critique {
  border: 1px solid var(--line); background: var(--bg-panel);
  border-radius: var(--radius-sm, 8px); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
  animation: fade-slide var(--t-med, 200ms) var(--ease, ease) both;
}
.watch-root .wf-verdict {
  align-self: flex-start; font-size: var(--fs-xs, 12.5px); font-weight: 700;
  border-radius: 999px; padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--vc, var(--mark-grey)) 34%, transparent);
  background: color-mix(in srgb, var(--vc, var(--mark-grey)) 12%, transparent);
  color: color-mix(in srgb, var(--vc, var(--mark-grey)) 72%, var(--ink));
}
.watch-root .wf-explain { font-size: var(--fs-sm, 13.5px); color: var(--ink-dim); line-height: 1.55; }
.watch-root .wf-revision {
  font-family: var(--serif); font-size: 13.5px; line-height: 1.6;
  border-left: 3px solid var(--accent); padding: 2px 2px 2px 10px;
}
.watch-root .wf-rev-eyebrow { display: block; margin-bottom: 2px; }
.watch-root .wf-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.watch-root .wf-actions .btn { padding: 5px 12px; font-size: var(--fs-xs, 12.5px); }
.watch-root .wf-fixed { color: var(--grade-a, #2f9e63); font-weight: 700; font-size: var(--fs-sm, 13.5px); }

/* empty-watching + cost footnote */
.watch-root .watch-empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 8px; padding: var(--s-5, 40px) var(--s-3, 24px); color: var(--ink-dim);
}
.watch-root .watch-empty svg { width: 30px; height: 30px; color: var(--ink-faint); }
.watch-root .watch-empty h3 { font-family: var(--serif); font-size: var(--fs-lg, 18px); font-weight: 600; color: var(--ink); }
.watch-root .watch-empty p { font-size: var(--fs-sm, 13.5px); line-height: 1.6; max-width: 440px; }
.watch-root .watch-note { text-align: center; font-size: var(--fs-xs, 12.5px); color: var(--ink-faint); }
`;
  document.head.appendChild(s);
}

/* ── small utilities ────────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* Paint through the theme tokens, never COLORS.hex — dark mode retunes. */
const MARK_TOKENS = {
  red: "var(--mark-red)",
  amber: "var(--mark-amber)",
  orange: "var(--mark-orange)",
  grey: "var(--mark-grey)",
};
function markPaint(color) {
  return MARK_TOKENS[color] ?? MARK_TOKENS.grey;
}

/* Verdict vocabulary — tolerant of both the legacy factcheck verdicts and the
   marks.js critique verdicts, since the contract leaves the enum open. */
const VERDICTS = {
  accurate: { label: "Accurate", paint: "var(--grade-a, #2f9e63)" },
  sound: { label: "Sound", paint: "var(--grade-a, #2f9e63)" },
  false: { label: "False", paint: "var(--mark-red)" },
  contradicted: { label: "Contradicted", paint: "var(--mark-red)" },
  fabricated: { label: "Source not found", paint: "var(--mark-red)" },
  questionable: { label: "Questionable", paint: "var(--mark-amber)" },
  incoherent: { label: "Doesn't follow", paint: "var(--mark-orange)" },
  unsupported: { label: "Unsupported", paint: "var(--mark-orange)" },
  weak: { label: "Weak evidence", paint: "var(--mark-orange)" },
  citationFix: { label: "Citation needs fixing", paint: "var(--mark-amber)" },
  no_claim: { label: "No checkable claim", paint: "var(--mark-grey)" },
  // The relay's vocabulary, used by the critique since the desktop's
  // five-pass version moved into the server. Without these three a finding
  // printed its raw verdict string on a grey chip.
  "well-supported": { label: "Well supported", paint: "var(--grade-a, #2f9e63)" },
  "partially-supported": { label: "Partially supported", paint: "var(--mark-orange)" },
  overstated: { label: "Overstated", paint: "var(--mark-amber)" },
};
function verdictInfo(v) {
  return VERDICTS[v] ?? { label: String(v), paint: "var(--mark-grey)" };
}

function toTime(v) {
  if (v == null) return 0;
  const t = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;

/* The watch endpoints are not in api.js (owned by another module); this local
   wrapper mirrors its fetch/error shape. */
async function call(path, body) {
  const res = await fetch(path, body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), {
      kind: data?.error?.kind, status: res.status,
    });
  }
  return data;
}

/* The one-time macOS setup steps — shared by the hero and the no-access card. */
function setupSteps() {
  const ol = el("ol", "watch-steps");
  const li1 = el("li");
  li1.append("Open ", pathChip("System Settings"), " → ", pathChip("Privacy & Security"), " → ", pathChip("Accessibility"), ".");
  const li2 = el("li");
  li2.append("Enable the app your terminal runs in (Terminal, iTerm2, or your editor) — that is the process reading the text field on Tracely's behalf.");
  const li3 = el("li");
  li3.append("Come back here — Tracely picks the permission up automatically.");
  ol.append(li1, li2, li3);
  return ol;
}
function pathChip(text) {
  return el("span", "watch-path", text);
}

/* ── render ─────────────────────────────────────────────────────────────── */

export async function render(mount, ctx) {
  ensureStyles();
  applyAppearance(ctx.settings);

  const root = el("div", "watch-root");
  const inner = el("div", "watch-inner");
  root.appendChild(inner);
  mount.appendChild(root);

  /* teardown plumbing — analyze.js's pattern: an AbortController for
     listeners, a timer registry that refuses to fire once detached, and a
     staleness check after every await. */
  const ac = new AbortController();
  const signal = ac.signal;
  const timers = new Set();
  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); if (root.isConnected) fn(); }, ms);
    timers.add(t);
    return t;
  }
  function teardown() {
    ac.abort();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }
  window.addEventListener("hashchange", teardown, { signal });
  const disposed = () => !root.isConnected || mount.dataset.tab !== "watch";

  const state = {
    mode: null,       // "loading" | "offline" | "disabled" | "noaccess" | "watching"
    data: null,       // last successful GET /api/watch/state payload
    offline: false,   // last poll failed (backend starting / not built yet)
    local: new Map(), // finding key → { checking, fixing, verdict, explanation, revision, fixed }
  };
  const cardByKey = new Map(); // finding key → card ui record (watching mode only)
  let ui = {};                 // refs into the current mode's DOM
  let pollTimer = null;
  let polling = false;

  function setLocal(key, patch) {
    state.local.set(key, { ...(state.local.get(key) ?? {}), ...patch });
  }
  function effective(f) {
    const o = state.local.get(f.key) ?? {};
    return {
      verdict: o.verdict ?? f.verdict ?? null,
      explanation: o.explanation ?? f.explanation ?? "",
      revision: o.revision ?? f.revision ?? "",
      fixed: Boolean(o.fixed || f.fixed),
      checking: Boolean(o.checking),
      fixing: Boolean(o.fixing),
    };
  }

  /* ── polling (every 2s while mounted; failures render, never throw) ── */
  async function poll() {
    if (polling || disposed()) return;
    polling = true;
    try {
      const data = await call("/api/watch/state");
      if (disposed()) return;
      state.data = data;
      state.offline = false;
    } catch {
      if (disposed()) return;
      state.offline = true;
    } finally {
      polling = false;
    }
    renderMain();
    pollTimer = later(poll, 2000);
  }
  function pollSoon() {
    if (pollTimer) { clearTimeout(pollTimer); timers.delete(pollTimer); pollTimer = null; }
    poll();
  }

  function computeMode() {
    if (state.offline) return "offline";
    if (!state.data) return "loading";
    if (!state.data.enabled) return "disabled";
    if (!state.data.hasAccess) return "noaccess";
    return "watching";
  }

  function renderMain() {
    const mode = computeMode();
    if (mode !== state.mode) {
      state.mode = mode;
      buildMode(mode);
    }
    if (mode === "watching") updateWatching();
  }

  /* ── mode skeletons ── */
  function buildMode(mode) {
    inner.textContent = "";
    cardByKey.clear();
    ui = {};
    if (mode === "loading") buildCenter("Connecting…", "Reaching the watch service.", false);
    else if (mode === "offline") buildCenter("Watch backend starting…", "The watcher service isn't answering yet. This tab keeps retrying — nothing to do on your end.", true);
    else if (mode === "disabled") buildDisabled();
    else if (mode === "noaccess") buildNoAccess();
    else buildWatching();
  }

  function buildCenter(title, sub, pulse) {
    const card = el("div", "card watch-center");
    if (pulse) card.appendChild(el("span", "watch-pulse"));
    card.append(el("h3", null, title), el("p", null, sub));
    inner.appendChild(card);
  }

  function buildDisabled() {
    const hero = el("div", "watch-hero");
    const badge = el("div", "watch-badge");
    badge.innerHTML = EYE_SVG;
    const lead = el("p", "watch-lead",
      "Tracely reads the focused text field in the apps you allow and flags claims as you write — like Grammarly, for credibility. Detection runs on the cheap model automatically; a paid critique only ever runs when you press the button.");
    const enableBtn = el("button", "btn btn-primary", "Enable watching");
    enableBtn.addEventListener("click", async () => {
      enableBtn.disabled = true;
      enableBtn.textContent = "Enabling…";
      try {
        await call("/api/watch/toggle", { enabled: true });
      } catch (e) {
        if (disposed()) return;
        ctx.toast(`Could not enable watching: ${e.message}`, true);
        enableBtn.disabled = false;
        enableBtn.textContent = "Enable watching";
        return;
      }
      if (disposed()) return;
      pollSoon();
    }, { signal });
    hero.append(badge, el("h1", null, "Watch"), lead, enableBtn);

    const setup = el("div", "card watch-setup");
    setup.appendChild(el("span", "eyebrow", "One-time macOS setup"));
    const p = el("p");
    p.append("Reading another app's text field uses macOS Accessibility, which you grant once:");
    setup.append(p, setupSteps());

    inner.append(hero, setup);
  }

  function buildNoAccess() {
    const card = el("div", "card watch-setup");
    card.appendChild(el("span", "eyebrow", "Accessibility permission needed"));
    const p = el("p");
    p.append("Watching is on, but macOS hasn't granted the Accessibility permission yet, so Tracely can't read any text field. Grant it once:");
    card.append(p, setupSteps());
    const actions = el("div", "watch-actions");
    const retry = el("button", "btn btn-primary", "Try again");
    retry.addEventListener("click", () => {
      retry.disabled = true;
      retry.textContent = "Checking…";
      later(() => { retry.disabled = false; retry.textContent = "Try again"; }, 1500);
      pollSoon();
    }, { signal });
    actions.appendChild(retry);
    card.appendChild(actions);
    inner.appendChild(card);
  }

  function buildWatching() {
    const strip = el("div", "card watch-strip");
    const eye = el("span", "ws-eye");
    eye.innerHTML = EYE_SVG;
    const app = el("span", "ws-app", "Watching");
    const sep = el("span", "ws-sep", "·");
    const ago = el("span", "ws-ago", "");
    const right = el("span", "ws-right");
    const pulse = el("span", "watch-pulse");
    const pauseBtn = el("button", "btn btn-ghost", "Pause");
    pauseBtn.title = "Stop reading — nothing runs while paused";
    pauseBtn.addEventListener("click", async () => {
      pauseBtn.disabled = true;
      try {
        await call("/api/watch/toggle", { enabled: false });
      } catch (e) {
        if (disposed()) return;
        ctx.toast(`Could not pause: ${e.message}`, true);
        pauseBtn.disabled = false;
        return;
      }
      if (disposed()) return;
      pollSoon();
    }, { signal });
    right.append(pulse, pauseBtn);
    strip.append(eye, app, sep, ago, right);

    const preview = el("div", "watch-preview");
    preview.hidden = true;

    const empty = el("div", "card watch-empty");
    empty.hidden = true;

    const findings = el("div", "watch-findings");
    findings.style.display = "contents"; // children are .card siblings for the shell stagger

    const note = el("div", "watch-note",
      "Detection runs automatically on the cheap model · a paid critique only runs when you press “Check this claim”.");

    inner.append(strip, preview, empty, findings, note);
    ui = { appEl: app, agoEl: ago, preview, empty, findings };
  }

  /* ── watching-state updates (idempotent; runs on every poll) ── */
  function updateWatching() {
    const d = state.data ?? {};
    const focused = Boolean(d.app);
    ui.appEl.textContent = focused ? `Watching ${d.app}` : "Watching — waiting for a text field";
    updateAgo();

    const preview = String(d.textPreview ?? "").trim();
    ui.preview.hidden = !(focused && preview);
    if (!ui.preview.hidden && ui.preview.textContent !== preview) ui.preview.textContent = preview;

    const findings = Array.isArray(d.findings) ? d.findings.filter((f) => f && f.key != null) : [];
    reconcileFindings(findings);

    const showEmpty = findings.length === 0;
    ui.empty.hidden = !showEmpty;
    if (showEmpty) {
      const apps = (Array.isArray(d.watchApps) && d.watchApps.length ? d.watchApps : ["TextEdit", "Notes", "Pages"]).join(", ");
      const title = focused ? "Nothing flagged yet" : "Focus a text field in an allowed app";
      const sub = focused
        ? "Tracely is reading as you write — claims that need a look will appear here."
        : `Click into a document in ${apps} and Tracely starts reading — claims that need a look will appear here.`;
      const sig = title + "\n" + sub;
      if (ui.empty.dataset.sig !== sig) {
        ui.empty.dataset.sig = sig;
        ui.empty.textContent = "";
        const icon = el("span");
        icon.innerHTML = EYE_SVG;
        icon.querySelector("svg").style.width = "30px";
        icon.querySelector("svg").style.height = "30px";
        icon.style.color = "var(--ink-faint)";
        ui.empty.append(icon, el("h3", null, title), el("p", null, sub));
      }
    }
  }

  function updateAgo() {
    if (state.mode !== "watching" || !ui.agoEl) return;
    const t = toTime(state.data?.updatedAt);
    ui.agoEl.textContent = t ? `last read ${fmtAgo(Date.now() - t)}` : "waiting for the first read";
  }
  // Live "Xs ago" ticker — 1s cadence, cheap textContent-only update.
  (function tickAgo() {
    updateAgo();
    later(tickAgo, 1000);
  })();

  /* ── finding cards (reconciled by key so button state survives polls) ── */
  function reconcileFindings(findings) {
    const seen = new Set();
    const ordered = [];
    for (const f of findings) {
      const key = String(f.key);
      if (seen.has(key)) continue;
      seen.add(key);
      let rec = cardByKey.get(key);
      if (!rec) {
        rec = buildFindingCard(f);
        cardByKey.set(key, rec);
        ui.findings.appendChild(rec.el);
      }
      rec.f = f;
      updateFindingCard(rec);
      ordered.push(rec.el);
    }
    for (const [key, rec] of cardByKey) {
      if (!seen.has(key)) { rec.el.remove(); cardByKey.delete(key); }
    }
    // Local overrides die with their finding: once the server stops listing a
    // key, a later REAPPEARANCE of that key is a fresh detection and must not
    // inherit a stale "Fixed ✓" / critique from an earlier round.
    for (const key of [...state.local.keys()]) {
      if (!seen.has(key)) state.local.delete(key);
    }
    // Restore server order without touching nodes already in place (re-inserting
    // a node restarts its entry animation, so only move actual strays).
    for (let i = 0; i < ordered.length; i++) {
      if (ui.findings.children[i] !== ordered[i]) ui.findings.insertBefore(ordered[i], ui.findings.children[i] ?? null);
    }
  }

  function buildFindingCard(f) {
    const card = el("div", "card watch-find");
    const head = el("div", "wf-head");
    const dot = el("span", "wf-dot");
    const label = el("span", "wf-label");
    head.append(dot, label);
    const sentence = el("div", "wf-sentence");
    const sources = el("div", "wf-sources");
    sources.hidden = true;
    const critique = el("div", "wf-critique");
    critique.hidden = true;
    const actions = el("div", "wf-actions");
    const checkBtn = el("button", "btn btn-primary", "Check this claim");
    checkBtn.title = "Runs a paid critique of this claim — one call, only when you press it";
    const fixBtn = el("button", "btn", "Fix");
    fixBtn.hidden = true;
    const fixedTag = el("span", "wf-fixed", "Fixed ✓");
    fixedTag.hidden = true;
    actions.append(checkBtn, fixBtn, fixedTag);
    card.append(head, sentence, sources, critique, actions);

    const rec = { el: card, f, sig: null, dot, label, sentence, sources, critique, checkBtn, fixBtn, fixedTag };
    checkBtn.addEventListener("click", () => runCritique(rec), { signal });
    fixBtn.addEventListener("click", () => runFix(rec), { signal });
    return rec;
  }

  function updateFindingCard(rec) {
    const f = rec.f;
    const eff = effective(f);
    const sig = JSON.stringify([f.kind, f.label, f.color, f.sentence, f.claimText, f.sources, eff, state.data?.app]);
    if (sig === rec.sig) return;
    rec.sig = sig;

    rec.dot.style.background = markPaint(f.color);
    rec.label.textContent = f.label ?? f.kind ?? "Flagged claim";
    rec.sentence.textContent = f.sentence ?? f.claimText ?? "";

    // sources line — free retrieval results, when present
    const srcs = Array.isArray(f.sources) ? f.sources.filter(Boolean) : [];
    rec.sources.hidden = srcs.length === 0;
    rec.sources.textContent = "";
    if (srcs.length) {
      rec.sources.append("Sources: ");
      srcs.slice(0, 4).forEach((s, i) => {
        if (i > 0) rec.sources.append(" · ");
        const bits = [s.title, s.venue, s.year].filter((v) => v != null && String(v).trim() !== "").map(String);
        const text = bits.length ? bits.join(", ") : "Untitled source";
        const url = String(s.url ?? "");
        if (/^https?:\/\//i.test(url)) {
          const a = el("a", null, text);
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          rec.sources.appendChild(a);
        } else {
          rec.sources.append(text);
        }
      });
    }

    // critique block — verdict + explanation + revision, once a critique ran
    const hasCritique = Boolean(eff.verdict || eff.explanation);
    rec.critique.hidden = !hasCritique;
    rec.critique.textContent = "";
    if (hasCritique) {
      if (eff.verdict) {
        const v = verdictInfo(eff.verdict);
        const chip = el("span", "wf-verdict", v.label);
        chip.style.setProperty("--vc", v.paint);
        rec.critique.appendChild(chip);
      }
      if (eff.explanation) rec.critique.appendChild(el("div", "wf-explain", eff.explanation));
      if (eff.revision) {
        const rev = el("div", "wf-revision");
        rev.append(el("span", "eyebrow wf-rev-eyebrow", "Suggested revision"), document.createTextNode(eff.revision));
        rec.critique.appendChild(rev);
      }
    }

    // actions — the cost doctrine's two buttons
    rec.checkBtn.hidden = hasCritique && !eff.checking;
    rec.checkBtn.disabled = eff.checking;
    rec.checkBtn.textContent = eff.checking ? "Checking…" : "Check this claim";
    const appName = state.data?.app;
    rec.fixBtn.hidden = !eff.revision || eff.fixed;
    rec.fixBtn.disabled = eff.fixing;
    rec.fixBtn.textContent = eff.fixing ? "Fixing…" : `Fix in ${appName ?? "the app"}`;
    rec.fixedTag.hidden = !eff.fixed;
  }

  /* PAID: only ever fires from the button above. */
  async function runCritique(rec) {
    const key = String(rec.f.key);
    setLocal(key, { checking: true });
    updateFindingCard(rec);
    try {
      const r = await call("/api/watch/critique", { key });
      if (disposed()) return;
      const out = r?.finding ?? r ?? {};
      setLocal(key, {
        checking: false,
        verdict: out.verdict ?? null,
        explanation: out.explanation ?? "",
        revision: out.revision ?? "",
      });
    } catch (e) {
      if (disposed()) return;
      setLocal(key, { checking: false });
      ctx.toast(`Critique failed: ${e.message}`, true);
    }
    updateFindingCard(rec);
  }

  async function runFix(rec) {
    const key = String(rec.f.key);
    setLocal(key, { fixing: true });
    updateFindingCard(rec);
    try {
      await call("/api/watch/fix", { key });
      if (disposed()) return;
      setLocal(key, { fixing: false, fixed: true });
      ctx.toast("Fixed in the app");
    } catch (e) {
      if (disposed()) return;
      setLocal(key, { fixing: false });
      ctx.toast(`Could not apply the fix: ${e.message}`, true);
    }
    updateFindingCard(rec);
  }

  /* first paint + poll loop */
  renderMain(); // "loading" immediately — no blank flash while the first fetch runs
  poll();
}
