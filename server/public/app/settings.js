/**
 * Settings tab — grouped preference fields, persisted via /api/prefs.
 * Also home of the shared appearance helper: main.js cannot be edited by this
 * module's owner, so applyAppearance() is exported here and called at the top
 * of every tab render this owner controls (home, documents, library, settings).
 *
 * Theme is NOT set here — after every successful save this module dispatches
 * a "tracely:prefs" CustomEvent and main.js re-themes (html[data-theme]).
 */

import { MODEL_FOR_TIER, currentModelId } from "/shared/plan.js";

const FALLBACK_ACCENT = "#f97316";

/* ── tiny shared helpers (imported by home/documents/library) ─────────── */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Letter → tint band. A=green, B=accent, C=amber, D/F=red, else grey. */
export function gradeBand(letter) {
  const L = String(letter ?? "").trim().charAt(0).toUpperCase();
  if (L === "A") return "a";
  if (L === "B") return "b";
  if (L === "C") return "c";
  if (L === "D" || L === "F") return "d";
  return "none";
}

/** Polished empty state — the paper-plane motif (styled by the shell). */
export function emptyState(title, sub) {
  return `<div class="empty-state">
    <svg class="empty-plane" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
    <h3>${esc(title)}</h3>
    ${sub ? `<p>${esc(sub)}</p>` : ""}
  </div>`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

/* Appearance-owned custom properties. --grade-a is the ONE colour the grade
   tint map introduces (no green exists in the shell tokens); every other band
   borrows a shell token via color-mix. */
const APPEARANCE_CSS = `
:root {
  --tab-pad: var(--s-4, 32px);
  --tab-gap: var(--s-2, 16px);
  --card-pad: var(--s-3, 24px);
  --grade-a: #2f9e63; /* grade-tint map: the single non-token colour, defined once */
}
html[data-theme="dark"] { --grade-a: #4fbe82; }
:root[data-density="compact"] {
  --tab-pad: var(--s-2, 16px);
  --tab-gap: var(--s-1, 8px);
  --card-pad: 12px;
}

/* letter-grade chips, colour-tinted by band — tokens + color-mix only */
.grade-chip[data-band] {
  min-width: 34px; text-align: center;
  border: 1px solid color-mix(in srgb, var(--gt) 32%, transparent);
  background: color-mix(in srgb, var(--gt) 12%, transparent);
  color: color-mix(in srgb, var(--gt) 72%, var(--ink));
}
.grade-chip[data-band="a"] { --gt: var(--grade-a); }
.grade-chip[data-band="b"] { --gt: var(--accent-deep); }
.grade-chip[data-band="c"] { --gt: color-mix(in srgb, var(--mark-amber) 72%, var(--mark-orange)); }
.grade-chip[data-band="d"] { --gt: var(--mark-red); }
.grade-chip[data-band="none"] { --gt: var(--mark-grey); }
`;

let lastAppearance = null;
let themeObserver = null;

/**
 * Apply accent / font size / density from the prefs object to the document.
 * Idempotent and cheap — every tab this owner renders calls it first, so the
 * appearance survives navigation without touching main.js. Coexists with the
 * theme engine: it never writes data-theme, only reads it (so a custom accent
 * can derive theme-appropriate deep/soft variants), and re-derives them when
 * the shell re-themes.
 */
export function applyAppearance(settings = {}) {
  lastAppearance = settings;
  const root = document.documentElement;

  if (!document.getElementById("tracelyAppearanceVars")) {
    const st = document.createElement("style");
    st.id = "tracelyAppearanceVars";
    st.textContent = APPEARANCE_CSS;
    document.head.appendChild(st);
  }

  // Re-derive accent variants whenever main.js flips html[data-theme].
  if (!themeObserver && typeof MutationObserver === "function") {
    themeObserver = new MutationObserver(() => applyAppearance(lastAppearance ?? {}));
    themeObserver.observe(root, { attributeFilter: ["data-theme"] });
  }

  const raw = String(settings.accent ?? "");
  const valid = /^#[0-9a-fA-F]{6}$/.test(raw);
  const accent = valid ? raw : FALLBACK_ACCENT;
  if (!valid || accent.toLowerCase() === FALLBACK_ACCENT) {
    // Default accent: let the stylesheet govern, so each theme's own
    // accent / accent-deep / accent-soft values apply untouched.
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-deep");
    root.style.removeProperty("--accent-soft");
  } else {
    const rgb = hexToRgb(accent);
    const dark = root.dataset.theme === "dark";
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-deep", rgbToHex(dark ? mix(rgb, [255, 255, 255], 0.12) : mix(rgb, [0, 0, 0], 0.18)));
    root.style.setProperty("--accent-soft", rgbToHex(dark ? mix(rgb, [0, 0, 0], 0.78) : mix(rgb, [255, 255, 255], 0.9)));
  }

  const size = [13, 14, 15].includes(Number(settings.fontSize)) ? Number(settings.fontSize) : 14;
  document.body.style.fontSize = `${size}px`;

  root.dataset.density = settings.density === "compact" ? "compact" : "comfortable";
}

/* ── tab styles ───────────────────────────────────────────────────────── */

const CSS = `
.settings-tab { flex: 1; min-height: 0; overflow-y: auto; padding: var(--tab-pad, 32px); }
.settings-tab .set-inner {
  max-width: 720px; margin: 0 auto; width: 100%;
  display: flex; flex-direction: column; gap: var(--tab-gap, 16px);
  padding-bottom: var(--s-6, 48px);
}
.settings-tab .set-head { margin-bottom: var(--s-1, 8px); }
.settings-tab h1 { font-family: var(--serif); font-size: var(--fs-2xl, 32px); font-weight: 700; letter-spacing: -.3px; }
.settings-tab .set-sub { color: var(--ink-dim); margin-top: 4px; font-size: var(--fs-sm, 13.5px); }

.settings-tab .set-group { padding: var(--s-2, 16px) var(--s-3, 24px) var(--s-2, 16px); }
.settings-tab .set-group:hover { transform: none; box-shadow: var(--shadow); }
.settings-tab .set-group > .eyebrow { display: block; padding: var(--s-1, 8px) 0 4px; color: var(--accent-deep); }

.settings-tab .set-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-3, 24px);
  padding: 14px 0; border-bottom: 1px solid var(--line);
}
.settings-tab .set-row:last-child { border-bottom: none; }
.settings-tab .set-lab { display: flex; flex-direction: column; gap: 3px; }
.settings-tab .set-lab > span:first-child { font-weight: 600; font-size: var(--fs-sm, 13.5px); }
.settings-tab .set-hint { font-size: var(--fs-xs, 12.5px); color: var(--ink-faint); max-width: 400px; line-height: 1.5; }
.settings-tab .set-cost { color: var(--accent-deep); }
.settings-tab .set-ctl { flex-shrink: 0; display: flex; align-items: center; gap: var(--s-1, 8px); }
.settings-tab .set-ctl .input { min-width: 190px; }
.settings-tab input[type="color"] {
  width: 48px; height: 32px; padding: 2px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-sm, 8px);
  background: var(--bg-raised); cursor: pointer;
  transition: border-color var(--t-fast, 150ms) var(--ease, ease), box-shadow var(--t-fast, 150ms) var(--ease, ease);
}
.settings-tab input[type="color"]:hover { border-color: var(--accent); }
.settings-tab input[type="checkbox"] { width: 17px; height: 17px; accent-color: var(--accent); cursor: pointer; }
.settings-tab .set-status { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm, 13.5px); }
.settings-tab .set-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--mark-grey); transition: background var(--t-med, 200ms) var(--ease, ease); }
.settings-tab .set-dot.on { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.settings-tab .set-danger:hover { border-color: var(--mark-red); color: var(--mark-red); }
.settings-tab code {
  font-family: var(--mono); font-size: var(--fs-xs, 12.5px);
  background: var(--bg-panel); border: 1px solid var(--line);
  border-radius: 5px; padding: 1px 5px;
}

/* Watch (macOS) — allowed-apps chip editor */
.settings-tab .set-row.set-col { flex-direction: column; align-items: stretch; gap: 10px; }
.settings-tab .set-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.settings-tab .set-chip {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--line-strong); background: var(--bg-panel);
  border-radius: 999px; padding: 3px 5px 3px 12px;
  font-size: var(--fs-xs, 12.5px); font-weight: 600; color: var(--ink);
  animation: fade-slide var(--t-med, 200ms) var(--ease, ease) both;
}
.settings-tab .set-chip button {
  border: none; background: none; cursor: pointer; color: var(--ink-faint);
  width: 18px; height: 18px; border-radius: 50%; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; padding: 0;
  transition: background var(--t-fast, 150ms) var(--ease, ease), color var(--t-fast, 150ms) var(--ease, ease);
}
.settings-tab .set-chip button:hover { background: color-mix(in srgb, var(--mark-red) 14%, transparent); color: var(--mark-red); }
.settings-tab .set-chip-input { min-width: 170px; flex: 0 1 auto; }

/* custom rubric — a column row, like the chip editor */
.settings-tab .set-rubric { width: 100%; min-height: 96px; resize: vertical; line-height: 1.5; font-size: var(--fs-xs, 12.5px); }
`;

function ensureStyles() {
  if (document.querySelector('style[data-tab="settings"]')) return;
  const st = document.createElement("style");
  st.dataset.tab = "settings";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ── render ───────────────────────────────────────────────────────────── */

/* The model list is the server's tier map, IMPORTED — never a copy.
   This was three hand-written Anthropic ids (claude-opus-5 / claude-sonnet-5 /
   claude-haiku-4-5) for weeks after the server moved to OpenAI. None of them
   was in ALLOWED_MODELS, so chooseModel quietly mapped every pick to the free
   model: the picker looked like it worked and chose nothing. /shared/plan.js
   is the same leaf module the server and tests read, so a model rename there
   reaches this select with no edit here. Labels name the TIER, never the
   model — the same rule the extension's slider follows. A prefs row saved
   before the 2026-09-21 remap can hold a retired id; currentModelId shows it
   as the tier it means, which is also what the server runs (pickModel). */
const MODELS = [
  { id: MODEL_FOR_TIER.fast, label: "Fast" },
  { id: MODEL_FOR_TIER.balanced, label: "Balanced" },
  { id: MODEL_FOR_TIER.thorough, label: "Thorough" },
];

const EFFORTS = [
  { id: "low", label: "Fast" },
  { id: "medium", label: "Balanced" },
  { id: "high", label: "Thorough" },
];

const STYLES = [
  { id: "apa", label: "APA" },
  { id: "mla", label: "MLA" },
  { id: "chicago", label: "Chicago" },
];

const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

const STRATEGIES = [
  { id: "smart", label: "Smart (recommended)" },
  { id: "uniform", label: "Uniform — my model for everything" },
];

const STRATEGY_HINTS = {
  smart: "The fast model detects claims, maps structure and runs Tracer; the balanced model judges critique &amp; grading — routine passes run on the cheaper model.",
  uniform: "Every call uses the model above — simplest to reason about, and the priciest option when that model is Thorough.",
};

function options(list, current) {
  return list.map((o) => `<option value="${esc(o.id)}"${String(o.id) === String(current) ? " selected" : ""}>${esc(o.label)}</option>`).join("");
}

function row(label, hint, controlHtml, { costs = false } = {}) {
  const hintHtml = hint ? `<span class="set-hint${costs ? " set-cost" : ""}">${hint}</span>` : "";
  return `<div class="set-row"><div class="set-lab"><span>${label}</span>${hintHtml}</div><div class="set-ctl">${controlHtml}</div></div>`;
}

export async function render(mount, ctx) {
  applyAppearance(ctx.settings);
  ensureStyles();

  const settings = { ...ctx.settings };
  const root = document.createElement("div");
  root.className = "settings-tab";
  mount.appendChild(root);

  const gradeOptions = [];
  for (let g = 3; g <= 12; g++) gradeOptions.push({ id: g, label: `Grade ${g}` });

  const strategy = settings.modelStrategy === "uniform" ? "uniform" : "smart";

  root.innerHTML = `
    <div class="set-inner">
      <div class="set-head">
        <h1>Settings</h1>
        <div class="set-sub">Preferences persist on this machine. Anything that spends API money says so.</div>
      </div>

      <section class="card set-group">
        <span class="eyebrow">Account</span>
        ${row("First name", "", `<input class="input" data-set="firstName" value="${esc(settings.firstName ?? "")}" placeholder="First name" />`)}
        ${row("Last name", "", `<input class="input" data-set="lastName" value="${esc(settings.lastName ?? "")}" placeholder="Last name" />`)}
      </section>

      <section class="card set-group">
        <span class="eyebrow">Appearance</span>
        ${row("Theme", "System follows your OS and switches live", `<select class="input" data-set="theme">${options(THEMES, settings.theme ?? "system")}</select>`)}
        ${row("Accent color", "Repaints the orange throughout the app", `<input type="color" data-set="accent" value="${esc(/^#[0-9a-fA-F]{6}$/.test(String(settings.accent ?? "")) ? settings.accent : FALLBACK_ACCENT)}" />`)}
        ${row("Font size", "", `<select class="input" data-set="fontSize">${options([{ id: 13, label: "13 px" }, { id: 14, label: "14 px" }, { id: 15, label: "15 px" }], settings.fontSize ?? 14)}</select>`)}
        ${row("Density", "", `<select class="input" data-set="density">${options([{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }], settings.density ?? "comfortable")}</select>`)}
      </section>

      <section class="card set-group">
        <span class="eyebrow">Google Docs widget</span>
        ${row("Bridge status", "Tracely can highlight and edit a Google Doc through a small Apps Script bridge you deploy once.", `<span class="set-status" id="setBridge"><span class="set-dot"></span><span>Checking…</span></span>`)}
        <div class="set-row"><div class="set-lab"><span class="set-hint">Setup: paste <code>docs-bridge/Code.gs</code> into script.google.com, deploy it as a web app, and put the URL and token in <code>.env</code> — the README walks through it step by step.</span></div></div>
      </section>

      <section class="card set-group">
        <span class="eyebrow">Watch (macOS)</span>
        ${row("Watch my Mac apps", "Reads the focused text field in allowed apps. Detection uses the fast model automatically — critique only when you click.", `<span class="set-status"><input type="checkbox" id="setWatchEnabled" /></span>`, { costs: true })}
        <div class="set-row set-col">
          <div class="set-lab">
            <span>Allowed apps</span>
            <span class="set-hint">Tracely only ever reads the focused text field of apps on this list.</span>
          </div>
          <div class="set-chips" id="setWatchApps">
            <span id="setWatchChipList" style="display:contents"></span>
            <input class="input set-chip-input" id="setWatchAppInput" list="setWatchAppSugg" placeholder="Add an app…" />
            <datalist id="setWatchAppSugg">
              <option value="TextEdit"></option>
              <option value="Notes"></option>
              <option value="Pages"></option>
              <option value="Mail"></option>
              <option value="Word"></option>
            </datalist>
          </div>
        </div>
      </section>

      <section class="card set-group">
        <span class="eyebrow">Preferences</span>
        ${row("Default citation style", "Used in the Library and in suggested citations", `<select class="input" data-set="citationStyle">${options(STYLES, settings.citationStyle ?? "apa")}</select>`)}
        ${row("Grading level", "Grades below 12 earn a small credit on the rubric score", `<select class="input" data-set="gradingLevel">${options(gradeOptions, settings.gradingLevel ?? 12)}</select>`)}
        <div class="set-row set-col">
          <div class="set-lab">
            <span>Custom rubric</span>
            <span class="set-hint">Paste an assignment rubric and AI Insights grades against it instead of the built-in one. Leave empty to use Tracely's rubric. Level credit still applies.</span>
          </div>
          <textarea class="input set-rubric" data-set="customRubric" rows="5" placeholder="e.g.&#10;Thesis (20 points): states an arguable position…&#10;Evidence (30 points): claims are supported by cited sources…">${esc(settings.customRubric ?? "")}</textarea>
        </div>
        ${row("Fact-check my claims automatically", "Uses the API when on", `<input type="checkbox" data-set="autoCritique"${settings.autoCritique ? " checked" : ""} />`, { costs: true })}
        ${row("Auto-find sources for flagged claims", "Uses web search, capped", `<input type="checkbox" data-set="autoSources"${settings.autoSources ? " checked" : ""} />`, { costs: true })}
        ${row("Model", "Affects cost", `<select class="input" data-set="model">${options(MODELS, currentModelId(settings.model) ?? MODEL_FOR_TIER.fast)}</select>`, { costs: true })}
        ${row(
          "Model strategy",
          `<span id="setStrategyHint">${STRATEGY_HINTS[strategy]}</span>`,
          `<select class="input" data-set="modelStrategy">${options(STRATEGIES, strategy)}</select>`,
          { costs: true },
        )}
        ${row("Depth", "How hard the model works per pass", `<select class="input" data-set="effort">${options(EFFORTS, settings.effort ?? "low")}</select>`)}
      </section>

      <section class="card set-group">
        <span class="eyebrow">Privacy</span>
        ${row("Clear analysis history", "Deletes analyses, claims and cached model results. The library keeps your saved sources.", `<button class="btn set-danger" id="setClearHistory">Clear history</button>`)}
        ${row("Clear history and library", "Everything above, plus every saved source and note.", `<button class="btn set-danger" id="setClearAll">Clear all</button>`)}
      </section>
    </div>
  `;

  async function save(patch) {
    try {
      const next = await ctx.api.prefs.set(patch);
      Object.assign(settings, next);
      // The shell listens for this and re-themes (html[data-theme]) — this
      // module never writes data-theme itself.
      window.dispatchEvent(new CustomEvent("tracely:prefs", { detail: { ...settings } }));
      // Re-derive accent variants for whatever theme the shell just applied.
      applyAppearance(settings);
    } catch (e) {
      ctx.toast(`Could not save setting: ${e.message}`, true);
    }
  }

  for (const el of root.querySelectorAll("[data-set]")) {
    const key = el.dataset.set;
    if (el.type === "color") {
      // live-preview while dragging the picker, persist on release
      el.addEventListener("input", () => {
        settings.accent = el.value;
        applyAppearance(settings);
      });
      el.addEventListener("change", () => save({ accent: el.value }));
      continue;
    }
    el.addEventListener("change", async () => {
      let value;
      if (el.type === "checkbox") value = el.checked;
      else if (key === "fontSize" || key === "gradingLevel") value = Number(el.value);
      else value = el.value;
      settings[key] = value;
      if (key === "fontSize" || key === "density") applyAppearance(settings);
      if (key === "modelStrategy") {
        const hint = root.querySelector("#setStrategyHint");
        if (hint) hint.innerHTML = STRATEGY_HINTS[value] ?? STRATEGY_HINTS.smart;
      }
      await save({ [key]: value });
    });
  }

  const bridgeEl = root.querySelector("#setBridge");
  try {
    const status = await ctx.api.status();
    if (!root.isConnected) return;
    const on = Boolean(status.docsBridge);
    bridgeEl.innerHTML = `<span class="set-dot${on ? " on" : ""}"></span><span>${on ? "Connected" : "Not set up"}</span>`;
  } catch {
    if (bridgeEl) bridgeEl.innerHTML = `<span class="set-dot"></span><span>Server unreachable</span>`;
  }

  /* ── Watch (macOS) ──────────────────────────────────────────────────────
     The enable switch is live watcher state (POST /api/watch/toggle), not a
     pref; the allowed-apps list persists as prefs.watchApps. The watch
     endpoints are not in api.js, so a tiny local fetch mirrors its shape.
     The backend may not be running — every failure degrades quietly. */
  async function watchCall(path, body) {
    const res = await fetch(path, body === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    return data;
  }

  const watchToggle = root.querySelector("#setWatchEnabled");
  watchCall("/api/watch/state").then((s) => {
    if (root.isConnected) watchToggle.checked = Boolean(s.enabled);
  }).catch(() => { /* backend not up yet — leave unchecked; toggling will report */ });
  watchToggle.addEventListener("change", async () => {
    const want = watchToggle.checked;
    try {
      await watchCall("/api/watch/toggle", { enabled: want });
      ctx.toast(want ? "Watching enabled" : "Watching paused");
    } catch (e) {
      watchToggle.checked = !want;
      ctx.toast(`Could not ${want ? "enable" : "pause"} watching: ${e.message}`, true);
    }
  });

  let watchApps = Array.isArray(settings.watchApps)
    ? settings.watchApps.filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim())
    : [];
  const chipListEl = root.querySelector("#setWatchChipList");
  const appInput = root.querySelector("#setWatchAppInput");
  function renderWatchChips() {
    chipListEl.innerHTML = watchApps.map((a, i) =>
      `<span class="set-chip">${esc(a)}<button type="button" data-chip="${i}" title="Remove ${esc(a)}" aria-label="Remove ${esc(a)}">×</button></span>`
    ).join("");
  }
  async function saveWatchApps() {
    renderWatchChips();
    const list = [...watchApps];
    await save({ watchApps: list });
    // save() overwrites `settings` with the server echo, which may not carry
    // watchApps back yet — the chip list stays the local source of truth.
    settings.watchApps = list;
  }
  function addWatchApp() {
    const name = appInput.value.trim().slice(0, 60);
    appInput.value = "";
    if (!name) return;
    if (watchApps.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    if (watchApps.length >= 20) { ctx.toast("That's plenty of apps — remove one first", true); return; }
    watchApps.push(name);
    saveWatchApps();
  }
  renderWatchChips();
  appInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addWatchApp(); } });
  appInput.addEventListener("change", addWatchApp); // datalist pick fires change
  chipListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chip]");
    if (!btn) return;
    watchApps.splice(Number(btn.dataset.chip), 1);
    saveWatchApps();
  });

  root.querySelector("#setClearHistory").addEventListener("click", async () => {
    if (!confirm("Clear all analysis history? This cannot be undone.")) return;
    try {
      await ctx.api.clearHistory(false);
      ctx.toast("Analysis history cleared");
    } catch (e) {
      ctx.toast(`Could not clear history: ${e.message}`, true);
    }
  });

  root.querySelector("#setClearAll").addEventListener("click", async () => {
    if (!confirm("Clear analysis history AND the source library? This cannot be undone.")) return;
    try {
      await ctx.api.clearHistory(true);
      ctx.toast("History and library cleared");
    } catch (e) {
      ctx.toast(`Could not clear: ${e.message}`, true);
    }
  });
}
