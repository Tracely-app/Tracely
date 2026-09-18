/* Tracely — universal writing checker.

   Three modes, chosen at load:
   • Docs mode (docs.google.com/document/*) — the original behavior, untouched:
     reads the doc via the signed-in export endpoint every 10s, shows findings
     in the floating widget; edits go through the local server's Docs bridge
     (or copy-paste when the bridge isn't configured).
   • Harness mode (window.__tracelyHarness) — the test page stands in for Docs.
   • Field mode (everywhere else) — Grammarly's actual core mechanism: track
     the focused textarea / contenteditable, check its sentences, and rewrite
     flagged ones IN PLACE. Automatic 10s checking is opt-in per site
     ("tracely.site.enabled" in the page's localStorage); on a non-enabled
     site nothing is sent anywhere until the user clicks.

   All API traffic goes through the extension's background service worker,
   which picks the engine: the local Tracely server when it's reachable
   (all features), or direct api.openai.com calls when an API key is set
   on the options page (standalone — checks + web-search sources; cite-url
   and Docs write-back hide). Harness/plain test pages fetch directly.

   Field mode also draws Grammarly-style overlay underlines: flagged
   sentences get a wavy colored underline (no highlight wash) — false #d93636,
   questionable #ffb800, incoherent #ff5900; grey dotted while pending;
   clicking one opens the panel and flashes that verdict's card. */
"use strict";

(() => {
  const SERVER = "http://localhost:4477";
  const CHECK_INTERVAL_MS = 10_000;
  const MAX_SENTENCES_PER_CHECK = 40;
  const MAX_INPUT_CHARS = 30_000; // GUARDS.maxInputChars — clamp before anything reaches a model
  const MIN_FIELD_CHARS = 80;     // GUARDS.detect.minChars — fields shorter than this are ignored

  const harness = window.__tracelyHarness ?? null; // test harness page stands in for Docs
  const IS_DOCS = !harness && location.hostname === "docs.google.com" && location.pathname.startsWith("/document/");
  if (document.getElementById("tracely-host")) return;

  const ISSUE_VERDICTS = ["false", "questionable", "incoherent", "needs_citation"];
  const VERDICT_LABEL = { false: "False", questionable: "Questionable", incoherent: "Doesn't make sense", needs_citation: "Citation needed" };
  const AUTO_SOURCE_VERDICTS = ["false", "questionable", "needs_citation"];
  // The mark vocabulary — one DISTINCT colour per verdict, used for the
  // underlines, the card accents and the hover popover:
  //   false → red, questionable → amber, incoherent → violet,
  //   needs_citation → blue (the product's home turf: the claim looks right,
  //   it just needs a source behind it).
  const MARK_COLORS = { false: "#d93636", questionable: "#ffb800", incoherent: "#8e4ec6", needs_citation: "#2563eb" };
  const VERDICT_WASH = { false: "#fdecec", questionable: "#fff4d6", incoherent: "#f1e6fb", needs_citation: "#e8f0fd" };
  const VERDICT_TEXT = { false: "#d93636", questionable: "#a67500", incoherent: "#8e4ec6", needs_citation: "#2563eb" };
  const MARK_PENDING = "#9a9ba1"; // grey dotted while a sentence's check is in flight

  // Read from the manifest so it can never disagree with the shipped version.
  const EXT_VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch { return "dev"; }
  })();

  /* An ORPHANED content script — the extension was reloaded or updated while
     this page kept running — keeps executing, but every chrome.* call then
     throws "Extension context invalidated" SYNCHRONOUSLY. That is why a
     .catch() on a promise never caught it, and why the console filled with
     repeats rather than one error: every timer tick and every storage event
     tried again.

     chrome.runtime.id is the liveness test — it becomes undefined the instant
     the context dies. Latch it, because an orphaned script never recovers
     until the tab reloads, and stop calling out at all once it has.

     These wrappers take the SAME arguments as the calls they replace, so the
     call sites keep their shape. */
  let extDead = false;
  function extAlive() {
    if (extDead) return false;
    try {
      if (chrome?.runtime?.id) return true;
    } catch { /* even reading it can throw */ }
    extDead = true;
    return false;
  }
  function extCall(fn, fallback) {
    if (!extAlive()) return fallback;
    try { return fn(); } catch { extDead = true; return fallback; }
  }
  const storageGet = (defaults, cb) => extCall(() => storageGet(defaults, cb));
  const storageSet = (obj) => extCall(() => storageSet(obj));
  const storageOnChanged = (cb) => extCall(() => storageOnChanged(cb));
  const sendMsg = (msg) => extCall(() => chrome.runtime.sendMessage(msg), Promise.resolve(null));

  /* Flow flags — passage-level coaching, drawn as a margin bracket rather
     than an underline (Figma "Overlay Mockup — Inline Flow Flag"). Colors
     sampled from that file: bracket/badge, then the chip + link accent. */
  const FLOW_COLOR = "#7344f1";
  const FLOW_ACCENT = "#7b44d4";

  // The Faster↔Smarter slider — one control replacing the model + effort
  // dropdowns on both widget surfaces. Three stops; effort rides along.
  const SPEED_STOPS = [
    { model: "gpt-5-nano", effort: "low" },
    { model: "gpt-5.4", effort: "low" },
    { model: "gpt-6-astra", effort: "medium" },
  ];
  function speedPos(model) {
    const i = SPEED_STOPS.findIndex((s) => s.model === model);
    return i === -1 ? 0 : i;
  }

  /* ── plan gate ───────────────────────────────────────────────────────────
     Which stops of the Faster↔Smarter slider this account can reach: free
     stops at Fast, student at Balanced, pro at Thorough. The plan comes from the
     signed-in Supabase account, resolved by the SERVER (GET /api/entitlement)
     and relayed here by the background worker.

     THIS GATE IS COSMETIC. It exists so the slider tells the truth about what
     the account will actually get, and so a stale paid setting does not sit in
     localStorage looking active. It prevents nothing: the model in a request
     body is a request, and the server clamps it to the plan on the token it
     received. Anyone editing this file can move the slider; they still get the
     model their account pays for.

     Two exceptions open every stop, and neither is a loophole — in both the
     server has already decided there is no plan to apply:
     • `byoKey` — standalone mode. The call is served by the user's own
       OpenAI API key, billed to them by OpenAI. Nothing of ours to meter.
     • `unenforced` — the local server reported `enforced: false`: it has no
       Supabase project configured, so it clamps NOTHING. Locking the slider
       here would show an upgrade prompt for a server that will serve the top
       model on request — a lie in the one mode a plain `node server.js` runs in. */
  const ORDER_URL = "https://jointracely.com/order";
  /* The upgrade link carries the signed-in account id as `uid`, which the order
     page forwards to Stripe as client_reference_id.
   
     Without it the billing webhook can only map a payment to an account by
     matching the PAYER'S email against a Tracely account — which is wrong in
     exactly the case that matters: a student who pays with a parent's card gets
     charged and stays on the free plan. The server's fallback chain
     (client_reference_id -> learned customer mapping -> email) is only as good
     as its first rung, and nothing was filling it. */
  function orderUrl(userId) {
    if (!userId) return ORDER_URL; // signed out: Stripe falls back to email
    return `${ORDER_URL}?uid=${encodeURIComponent(userId)}`;
  }

  const PLAN_MAX_STOP = { free: 0, student: 1, pro: 2 };
  let tier = { plan: "free", byoKey: false, unenforced: false, userId: null };
  const tierListeners = []; // widget re-renders to run when the tier resolves

  // The highest slider stop this account may use. Unknown plan → free, always.
  function maxStop() {
    if (tier.byoKey || tier.unenforced) return SPEED_STOPS.length - 1;
    return PLAN_MAX_STOP[tier.plan] ?? 0;
  }
  function effModel(settings) { return SPEED_STOPS[Math.min(speedPos(settings.model), maxStop())].model; }
  function effEffort(settings) {
    const pos = speedPos(settings.model);
    return pos <= maxStop() ? settings.effort : SPEED_STOPS[maxStop()].effort;
  }
  // Pull a stored preference down to what the plan reaches. Returns whether it
  // moved, so the caller knows to persist.
  function clampSettingsToPlan(settings) {
    if (speedPos(settings.model) <= maxStop()) return false;
    const stop = SPEED_STOPS[maxStop()];
    settings.model = stop.model;
    settings.effort = stop.effort;
    return true;
  }
  function tierChanged() {
    for (const fn of tierListeners) { try { fn(); } catch { /* widget torn down */ } }
  }
  let tierResolved = false;
  let tierTimer = 0;
  function refreshTier() {
    if (!useRelay) return; // harness page: no background worker — stays free
    let pending;
    try {
      if (!extAlive()) throw new Error("orphaned");
      pending = chrome.runtime.sendMessage({ type: "tracely-entitlement" });
    } catch {
      /* The extension was reloaded or updated while this page kept running.
         chrome.runtime.sendMessage THROWS SYNCHRONOUSLY in that state rather
         than returning a rejected promise, so the .catch() below never sees
         it and the error escapes uncaught — once here, and then again on
         every interval tick forever. This content script is orphaned until
         the tab reloads, so stop asking. */
      if (tierTimer) { clearInterval(tierTimer); tierTimer = 0; }
      return;
    }
    pending.then((r) => {
      if (!r?.ok) return;
      const next = { plan: r.plan ?? "free", byoKey: Boolean(r.byoKey), unenforced: Boolean(r.unenforced), userId: r.userId ?? null };
      if (tierResolved && next.plan === tier.plan && next.byoKey === tier.byoKey
          && next.unenforced === tier.unenforced && next.userId === tier.userId) return;
      tier = next;
      tierResolved = true;
      tierChanged(); // first resolve fires too: free-tier listeners clamp stale paid settings
    }).catch(() => { /* worker asleep or extension reloaded — stays free */ });
  }
  // Called once `useRelay` is known (below) — refreshTier depends on it.
  function initTier() {
    try {
      refreshTier();
      // The background worker writes the entitlement cache and the API key
      // lives in the same area, so watching storage is how a sign-in on the
      // options page reaches an already-open tab without a reload.
      chrome.storage?.onChanged?.addListener((changes, area) => {
        try {
          if (area === "local" && (changes.entitlement || changes.apiKey)) refreshTier();
        } catch { /* orphaned content script — refreshTier already stood down */ }
      });
      tierTimer = setInterval(refreshTier, 5 * 60_000); // matches the worker's entitlement TTL
    } catch { /* harness page: no chrome.* — stays free tier */ }
  }
  function sbFill(pos) {
    const pct = (pos / (SPEED_STOPS.length - 1)) * 100;
    return `linear-gradient(90deg, #ff7f00 0%, #f9a35a ${pct}%, rgba(20,16,10,0.08) ${pct}%, rgba(20,16,10,0.08) 100%)`;
  }
  function speedbarHtml(pos) {
    const ceiling = maxStop();
    const locked = ceiling < SPEED_STOPS.length - 1; // some stops are above this plan
    const p = Math.min(pos, ceiling);
    const title = locked ? ' title="Smarter models come with a paid Tracely plan"' : "";
    return `<div class="speedbar${locked ? " locked" : ""}"${title}>
      <span class="sb-lab${p === 0 ? " on" : ""}" data-sb-lab="0">Faster</span>
      <div class="sb-track">
        <input type="range" class="speed" id="speedSel" min="0" max="${SPEED_STOPS.length - 1}" step="0.01" value="${p}" style="--sb-fill:${sbFill(p)}"${ceiling === 0 ? " disabled" : ""}>
        <span class="sb-dots">${SPEED_STOPS.map((_, i) => `<i${i > ceiling ? ' class="off"' : ""}></i>`).join("")}</span>
      </div>
      <span class="sb-lab${p === SPEED_STOPS.length - 1 ? " on" : ""}" data-sb-lab="max">Smarter${locked ? `<a class="sb-pro" href="${orderUrl(tier.userId)}" target="_blank" rel="noopener noreferrer">PRO</a>` : ""}</span>
    </div>`;
  }
  // Wire the slider without re-rendering: a full render mid-drag drops the
  // thumb. The drag is SMOOTH (step 0.01, fill follows the finger); on
  // release it snaps to the nearest stop, and only the snap saves settings.
  // The drag stops dead at the plan's ceiling so the thumb never sits over a
  // stop the account would not actually be served.
  function wireSpeedbar(shadow, settings, saveSettings) {
    const el = shadow.getElementById("speedSel");
    if (!el || el.disabled) return; // free tier has a single stop: nothing to drag
    const ceiling = maxStop();
    el.addEventListener("input", () => {
      if (Number(el.value) > ceiling) el.value = String(ceiling);
      el.style.setProperty("--sb-fill", sbFill(Number(el.value)));
    });
    const snap = () => {
      const pos = Math.max(0, Math.min(ceiling, Math.round(Number(el.value))));
      el.value = String(pos);
      const stop = SPEED_STOPS[pos];
      settings.model = stop.model;
      settings.effort = stop.effort;
      saveSettings();
      el.style.setProperty("--sb-fill", sbFill(pos));
      shadow.querySelector('[data-sb-lab="0"]')?.classList.toggle("on", pos === 0);
      shadow.querySelector('[data-sb-lab="max"]')?.classList.toggle("on", pos === SPEED_STOPS.length - 1);
    };
    el.addEventListener("change", snap); // fires on release for range inputs
    el.addEventListener("keyup", snap); // arrow-key users snap too
  }

  /* ── shared helpers (mirror public/app.js) ─────────────────────────────── */

  function hashText(s) {
    const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
    return "s" + h.toString(36);
  }

  // Bibliography block ("Sources:" + numbered entries) — mirrors public/app.js.
  function sourcesBlock(text) {
    const m = text.match(/(?:^|\n)Sources:\n/);
    if (!m) return null;
    const headStart = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const bodyStart = m.index + m[0].length;
    const entryRe = /^(\d+)\.\s+(.*?)\s+—\s+(\S+)\s*$/;
    const entries = [];
    let pos = bodyStart;
    while (pos < text.length) {
      const nl = text.indexOf("\n", pos);
      const lineEnd = nl === -1 ? text.length : nl;
      const em = text.slice(pos, lineEnd).match(entryRe);
      if (!em) break;
      entries.push({ num: Number(em[1]), title: em[2], url: em[3] });
      pos = nl === -1 ? text.length : nl + 1;
    }
    return { headStart, end: pos, entries };
  }

  // ── citation formatting ──
  // Web sources rarely expose author/year, so all three styles use the
  // site-name + access-date web-page form. `doc` deliberately omits the URL:
  // bibliography lines in the doc must stay "N. <text> — <url>" so
  // sourcesBlock can keep parsing (and deduping) them.
  const CITE_STYLES = [["apa", "APA"], ["mla", "MLA"], ["chicago", "Chicago"]];
  const CITE_MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  function formatCitation(src, style) {
    let host = (src.publisher || "").trim();
    if (!host) {
      try { host = new URL(src.url).hostname.replace(/^www\./, ""); } catch { host = "Web source"; }
    }
    const title = (src.title || src.url || "").trim().replace(/[.?!]\s*$/, "");
    const d = new Date();
    const long = `${CITE_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    const mlaDate = `${d.getDate()} ${CITE_MONTHS[d.getMonth()].slice(0, 3)}. ${d.getFullYear()}`;
    if (style === "mla") return {
      doc: `“${title}.” ${host}. Accessed ${mlaDate}.`,
      ref: `“${title}.” ${host}, ${src.url}. Accessed ${mlaDate}.`,
      marker: `(${host})`,
    };
    if (style === "chicago") return {
      doc: `${host}. “${title}.” Accessed ${long}.`,
      ref: `${host}. “${title}.” Accessed ${long}. ${src.url}.`,
      marker: `(${host}, n.d.)`,
    };
    return {
      doc: `${host}. (n.d.). ${title}.`,
      ref: `${host}. (n.d.). ${title}. Retrieved ${long}, from ${src.url}`,
      marker: `(${host}, n.d.)`,
    };
  }

  function segmentText(text) {
    const segs = [];
    const block = sourcesBlock(text);
    const lineRe = /[^\n]+/g;
    let lm;
    while ((lm = lineRe.exec(text))) {
      const line = lm[0];
      const base = lm.index;
      if (block && base >= block.headStart && base < block.end) continue; // skip the bibliography
      const sentRe = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
      let sm;
      while ((sm = sentRe.exec(line))) {
        const raw = sm[0];
        const lead = raw.match(/^\s*/)[0].length;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const start = base + sm.index + lead;
        segs.push({ text: trimmed, start, end: start + trimmed.length, hash: hashText(trimmed) });
      }
    }
    for (const seg of segs) {
      const words = seg.text.split(/\s+/).length;
      const endsTerminal = /[.!?]["')\]]*$/.test(seg.text);
      const moreAfter = text.slice(seg.end).trim().length > 0;
      seg.checkable = words >= 3 && seg.text.length <= 2000 && (endsTerminal || moreAfter)
        // Raw-code claim gate: never spend an API call on text that cannot
        // be a factual claim. Conservative on purpose — a skipped real claim
        // costs trust, a checked non-claim only costs pennies. (No opinion-
        // opener filter: "I think the Great Wall is visible from space" is a
        // checkable falsehood wearing a hedge.)
        && !/\?\s*$/.test(seg.text)                       // bare questions aren't claims ("(or was it 1945?)" tails still check)
        && /\p{L}/u.test(seg.text)                        // any-script letters — numbers/dividers only
        && !/^[\d\s.)\-–—•*#]+$/.test(seg.text)           // list markers / rules
        && !(!endsTerminal && words <= 6);                // short unpunctuated line = heading (or mid-typing)
    }
    return segs;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Carry [n] citation markers from the original sentence into a revision that
  // dropped them (mirrors applyFix in the app).
  function withMarkers(original, revision) {
    const markers = [...new Set(original.match(/\[\d+\]/g) ?? [])].filter((m) => !revision.includes(m));
    if (!markers.length) return revision;
    const punct = revision.match(/[.!?]+["')\]]*$/);
    const at = punct ? revision.length - punct[0].length : revision.length;
    return revision.slice(0, at).replace(/\s+$/, "") + " " + markers.join(" ") + revision.slice(at);
  }

  /* ── transport ─────────────────────────────────────────────────────────── */

  // Inside the real extension, ALL modes relay through the background worker,
  // which picks the engine (local server vs standalone api.openai.com).
  // The harness and plain-script test pages fetch the server directly.
  const useRelay = !harness && typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

  initTier(); // the plan gate asks the worker, so it can only start once useRelay is known

  async function api(path, body) {
    if (useRelay) {
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: "tracely-api", path, body });
      } catch {
        throw new Error("Tracely extension was reloaded — refresh this page");
      }
      if (!resp) throw new Error("No reply from the Tracely background worker");
      if (!resp.ok) {
        throw Object.assign(new Error(resp.message ?? `HTTP ${resp.status}`), { kind: resp.kind, offline: resp.offline });
      }
      return resp.data;
    }
    const res = await fetch(`${SERVER}${path}`, body === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { kind: data?.error?.kind });
    }
    return data;
  }

  function offlineError(err) {
    return Boolean(err?.offline) || err instanceof TypeError || /failed to fetch/i.test(String(err?.message));
  }

  /* ── widget chrome (shared shadow-DOM shell) ───────────────────────────── */

  const PLANE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>`;

  // jointracely.com's own font, bundled in the extension (web_accessible).
  const FONT_URL = (() => { try { return chrome.runtime.getURL("fonts/PlusJakartaSans.woff2"); } catch { return ""; } })();
  const JAKARTA = `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

  const WIDGET_CSS = `
    ${FONT_URL ? `@font-face { font-family: 'Plus Jakarta Sans'; src: url('${FONT_URL}') format('woff2'); font-weight: 200 800; font-display: swap; }` : ""}
    :host { all: initial; }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: ${JAKARTA}; -webkit-font-smoothing: antialiased; }
    .root { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; }
    .pill {
      display: flex; align-items: center; gap: 9px;
      background: #fff; color: #0e0e10;
      border: 1px solid rgba(20,16,10,0.06); border-radius: 999px;
      padding: 9px 17px 9px 11px;
      box-shadow: 0 8px 26px rgba(180,120,60,0.18);
      cursor: pointer; user-select: none;
      font-size: 13.5px; font-weight: 700;
    }
    .pill:hover { transform: translateY(-1px); }
    .pill.quiet { color: #8e8e93; }
    .pill.quiet .plane { background: linear-gradient(150deg, #c7c7cc, #a7a7ac); }
    .plane {
      width: 28px; height: 28px; border-radius: 9px;
      background: linear-gradient(150deg, #ff7f00, #f9a35a);
      display: flex; align-items: center; justify-content: center;
      color: #fff; flex-shrink: 0; box-shadow: 0 4px 12px rgba(255,127,0,0.30);
    }
    .plane svg { width: 15px; height: 15px; }
    .count { background: #fdecec; color: #d93636; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 700; }
    .count.ok { background: #e7f6ee; color: #1f9d55; }
    .count.off { background: #f2f2f3; color: #a7a7ac; }
    .panel {
      position: absolute; right: 0; bottom: 54px;
      width: 384px; max-height: min(560px, 72vh);
      background: #fdfbf9; border: 1px solid rgba(20,16,10,0.06); border-radius: 20px;
      box-shadow: 0 20px 60px rgba(180,120,60,0.22);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 14px 16px; background: #fff; border-bottom: 1px solid rgba(20,16,10,0.05);
      cursor: grab;
    }
    .head .name { font-weight: 800; font-size: 16px; letter-spacing: -0.02em; }
    .head .autosrc { flex-shrink: 0; }
    .status { margin-left: auto; font-size: 11px; color: #a7a7ac; max-width: 170px; text-align: right; font-weight: 500; }
    .status.error { color: #d93636; }
    .selects { display: flex; gap: 6px; padding: 9px 16px; background: #fff; border-bottom: 1px solid rgba(20,16,10,0.05); align-items: center; }
    .speedbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #fff; border-bottom: 1px solid rgba(20,16,10,0.05); }
    .speedbar.locked .sb-track { opacity: .5; }
    .speedbar.locked input[disabled] { cursor: not-allowed; }
    .sb-pro { display: inline-block; margin-left: 5px; padding: 1px 6px; border-radius: 8px; background: linear-gradient(150deg, #ff7f00, #f9a35a); color: #fff; font-size: 8px; font-weight: 800; letter-spacing: .6px; vertical-align: 1px; text-decoration: none; cursor: pointer; }
    .sb-dots i.off { background: rgba(20,16,10,0.18); box-shadow: none; }
    .sb-lab { font-size: 12px; font-weight: 700; color: #8e8e93; flex-shrink: 0; }
    .sb-lab.on { color: #0e0e10; }
    .sb-track { position: relative; flex: 1; display: flex; align-items: center; }
    input[type="range"].speed { -webkit-appearance: none; appearance: none; width: 100%; height: 12px; border-radius: 999px; background: transparent; outline: none; cursor: pointer; margin: 0; }
    input[type="range"].speed::-webkit-slider-runnable-track { height: 12px; border-radius: 999px; background: var(--sb-fill, linear-gradient(90deg, #ff7f00, #f9a35a)); }
    input[type="range"].speed::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 24px; height: 24px; border-radius: 50%; background: #fff; border: 1px solid rgba(20,16,10,0.12); box-shadow: 0 2px 8px rgba(180,120,60,0.38); margin-top: -6px; cursor: grab; }
    .sb-dots { position: absolute; inset: 0; display: flex; justify-content: space-between; align-items: center; padding: 0 10px; pointer-events: none; }
    .sb-dots i { width: 4px; height: 4px; border-radius: 50%; background: rgba(255,255,255,0.9); box-shadow: 0 0 0 1px rgba(20,16,10,0.05); }
    .foot .act { padding: 4px 11px; font-size: 11px; }
    .foot-left { display: flex; align-items: center; gap: 10px; }
    select { font-size: 12px; border: 1px solid rgba(20,16,10,0.1); border-radius: 8px; padding: 4px 8px; background: #fff; color: #0e0e10; outline: none; font-weight: 600; }
    .list { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .empty { text-align: center; color: #a7a7ac; font-size: 13px; padding: 28px 12px; font-weight: 500; }
    .card { background: #fff; border: 1px solid rgba(20,16,10,0.05); border-left: 3px solid #a7a7ac; border-radius: 14px; padding: 12px 14px; box-shadow: 0 4px 14px rgba(180,120,60,0.07); }
    .card.c-false { border-left-color: #d93636; }
    .card.c-quest { border-left-color: #ffb800; }
    .card.c-inco { border-left-color: #8e4ec6; }
    .card.c-cite { border-left-color: #2563eb; }
    .top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .badge { font-size: 9px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; padding: 3px 8px; border-radius: 20px; }
    .badge-false { background: #fdecec; color: #d93636; }
    .badge-quest { background: #fff4d6; color: #a67500; }
    .badge-inco { background: #f1e6fb; color: #8e4ec6; }
    .badge-cite { background: #e8f0fd; color: #2563eb; }
    .x { margin-left: auto; background: none; border: none; color: #a7a7ac; cursor: pointer; font-size: 14px; }
    .x:hover { color: #0e0e10; }
    .quote { font-style: italic; font-size: 12.5px; color: #8e8e93; border-left: 2px solid rgba(20,16,10,0.1); padding-left: 9px; margin-bottom: 7px; font-weight: 500; }
    .expl { font-size: 12.5px; color: #0e0e10; margin-bottom: 9px; line-height: 1.5; font-weight: 500; }
    .fix { background: #fdfbf9; border: 1px solid rgba(20,16,10,0.06); border-radius: 12px; padding: 10px 12px; margin-bottom: 7px; }
    .fix-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: #1f9d55; margin-bottom: 4px; }
    .fix-text { font-size: 12.5px; margin-bottom: 7px; line-height: 1.5; }
    .row { display: flex; gap: 7px; }
    button.act {
      border: 1px solid rgba(20,16,10,0.1); background: #fff; color: #0e0e10; border-radius: 9px;
      padding: 6px 12px; font-size: 11.5px; cursor: pointer; font-weight: 700; font-family: ${JAKARTA};
    }
    button.act:hover { border-color: #ff7f00; color: #ff7f00; }
    button.act.primary { background: #0e0e10; border-color: #0e0e10; color: #fff; }
    button.act.primary:hover { color: #fff; opacity: .9; }
    button.act[disabled] { opacity: .5; cursor: default; }
    .sources { border-top: 1px solid rgba(20,16,10,0.07); margin-top: 9px; padding-top: 7px; }
    .sources-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: #ff7f00; margin-bottom: 5px; }
    .src { display: flex; gap: 7px; align-items: flex-start; padding: 6px 7px; border-radius: 9px; }
    .src:hover { background: #fff6ee; }
    .stance { font-size: 8px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 8px; margin-top: 2px; flex-shrink: 0; }
    .st-supports { background: #e7f6ee; color: #1f9d55; }
    .st-refutes { background: #fdecec; color: #d93636; }
    .st-context { background: #f2f2f3; color: #8e8e93; }
    .c-flow { border-left-color: #7344f1; }
    .badge-flow { background: #f2ecff; color: #7b44d4; }
    .src-body { flex: 1; min-width: 0; }
    .src a { font-size: 11.5px; font-weight: 700; color: #0e0e10; text-decoration: none; display: block; }
    .src a:hover { color: #ff7f00; }
    .src-meta { font-size: 10px; color: #a7a7ac; font-weight: 500; }
    .src-snip { font-size: 10.5px; color: #8e8e93; }
    .src-actions { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
    .loading { font-size: 11.5px; color: #a7a7ac; font-style: italic; }
    .st-manual { background: #eaf1fb; color: #2c6fb8; }
    .cite-url { display: flex; gap: 6px; margin-top: 8px; }
    .cite-url input { flex: 1; min-width: 0; border: 1px solid rgba(20,16,10,0.1); border-radius: 9px; padding: 6px 10px; font-size: 11.5px; outline: none; color: #0e0e10; background: #fff; font-family: ${JAKARTA}; }
    .cite-url input:focus { border-color: #ff7f00; }
    .autosrc { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #8e8e93; cursor: pointer; user-select: none; font-weight: 600; }
    .autosrc input { accent-color: #ff7f00; }
    .foot { padding: 8px 16px; background: #fff; border-top: 1px solid rgba(20,16,10,0.05); font-size: 10.5px; color: #a7a7ac; display: flex; justify-content: space-between; font-weight: 500; }
    .card.flash { animation: tracely-flash 1.2s ease-out; }
    @keyframes tracely-flash {
      0% { box-shadow: 0 0 0 3px rgba(255,127,0,0.4); }
      100% { box-shadow: 0 4px 14px rgba(180,120,60,0.07); }
    }
  `;

  function makeWidget() {
    const host = document.createElement("div");
    host.id = "tracely-host";
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "root";
    shadow.appendChild(root);
    return { host, shadow, root };
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } } // false: sandboxed page or quota
  function lsDel(key) { try { localStorage.removeItem(key); } catch { /* sandboxed */ } }
  function jsonParse(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }

  if (harness || IS_DOCS) docsMode();
  else fieldMode();

  /* ════════════════════════════════════════════════════════════════════════
     DOCS MODE — the original Google Docs widget, behavior unchanged.
     ════════════════════════════════════════════════════════════════════════ */
  function docsMode() {
    const DOC_ID = harness ? "harness" : (location.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)/)?.[1] ?? null);
    if (!DOC_ID) return;

    const SETTINGS_KEY = "tracely.widget.settings";
    const DISMISS_KEY = `tracely.widget.dismissed.${DOC_ID}`;
    const VCACHE_KEY = `tracely.widget.vcache.${DOC_ID}`;
    const SCACHE_KEY = `tracely.widget.scache.${DOC_ID}`;
    const FCACHE_KEY = `tracely.widget.fcache.${DOC_ID}`;

    // ── state ──
    // Verdicts and source lists persist per doc: reopening the tab re-checks
    // NOTHING that hasn't changed (hash-keyed, stale entries just never
    // match) and never re-searches a claim it already has sources for.
    const cache = new Map(jsonParse(lsGet(VCACHE_KEY) ?? "[]", []));
    const dismissed = new Set(jsonParse(lsGet(DISMISS_KEY) ?? "[]", []));
    const sourcesMap = new Map(jsonParse(lsGet(SCACHE_KEY) ?? "[]", [])
      .map(([h, st]) => [h, { loading: false, list: st.list, copiedUrl: null, citedUrl: st.citedUrl ?? null }]));
    /* ── flow coaching state ──────────────────────────────────────────────
       Flow is judged on the SHAPE of the document, so it re-runs only when
       the paragraph structure actually changes — not on every keystroke like
       the sentence checker. One fast-model call per structural change, cached
       across reloads, so the whole feature costs a fraction of a cent. */
    const flowSaved = jsonParse(lsGet(FCACHE_KEY) ?? "null", null);
    let flowIssues = Array.isArray(flowSaved?.issues) ? flowSaved.issues : [];
    let flowSig = String(flowSaved?.sig ?? "");
    let flowAt = 0;
    let flowInflight = false;
    let flowDismissed = new Set(Array.isArray(flowSaved?.dismissed) ? flowSaved.dismissed : []);
    const FLOW_MIN_CHARS = harness ? 0 : 400; // below this there's no structure to judge
    // Opt-in escape hatch, read once. See the comment at the draw site.
    const FLOW_IN_DOC = lsGet("tracely.flowInDoc") === "1";
    const FLOW_MIN_INTERVAL = 45_000; // never more than one flow call per 45s

    // Signature of the document's SHAPE: paragraph count plus each one's
    // opening and closing words. Editing inside a sentence doesn't move it;
    // adding, cutting, or reordering a paragraph does.
    function flowSignature(text) {
      const paras = text.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.split(/\s+/).length >= 12);
      return paras.length + "|" + paras.map((p) => {
        const w = p.split(/\s+/);
        return w.slice(0, 4).join(" ") + "…" + w.slice(-3).join(" ");
      }).join("¶");
    }

    function persistFlow() {
      lsSet(FCACHE_KEY, JSON.stringify({ sig: flowSig, issues: flowIssues, dismissed: [...flowDismissed] }));
    }

    function flowHashOf(issue) { return "flow" + hashText(issue.passage); }

    function activeFlowIssues() {
      return flowIssues.filter((i) => !flowDismissed.has(flowHashOf(i)));
    }

    async function requestFlow() {
      if (flowInflight || document.hidden) return;
      const text = docText;
      if (text.length < FLOW_MIN_CHARS) { // too short to have a shape
        if (flowIssues.length) { flowIssues = []; flowSig = ""; persistFlow(); scheduleDocsMarks(); }
        return;
      }
      const sig = flowSignature(text);
      if (sig === flowSig) return;                            // structure unchanged — cached answer stands
      if (Date.now() - flowAt < FLOW_MIN_INTERVAL) return;    // rate floor
      flowInflight = true;
      flowAt = Date.now();
      try {
        const data = await api("/api/flow", { text: text.slice(0, MAX_INPUT_CHARS), model: effModel(settings) });
        flowIssues = Array.isArray(data.issues) ? data.issues : [];
        flowSig = sig;
        persistFlow();
        render();
        scheduleDocsMarks();
      } catch {
        // Flow is an enhancement — a failure must never disturb the checker's
        // status line. Retry naturally on the next structural change.
      } finally {
        flowInflight = false;
      }
    }

    function persistCaches() {
      // Doc-aware eviction: verdicts for sentences STILL IN the doc are what
      // stop reload re-checks — persist those first, pad with recent others.
      // Blind slice(-400) on a long doc evicted live verdicts and re-spent
      // API calls on every reload, forever.
      const live = new Set(segments.map((s) => s.hash));
      const entries = [...cache];
      const keep = entries.filter(([h]) => live.has(h)).slice(-400);
      if (keep.length < 400) {
        keep.push(...entries.filter(([h]) => !live.has(h)).slice(-(400 - keep.length)));
      }
      const src = [...sourcesMap]
        .filter(([, st]) => st.list?.length)
        .map(([h, st]) => [h, { list: st.list.slice(0, 5), citedUrl: st.citedUrl ?? null }]);
      let ok = lsSet(VCACHE_KEY, JSON.stringify(keep));
      ok = lsSet(SCACHE_KEY, JSON.stringify(src.slice(-20))) && ok;
      if (!ok) {
        // Quota (shared with Google Docs' own storage): drop other docs'
        // Tracely caches, then retry once at reduced size. Never throw.
        try {
          for (const k of Object.keys(localStorage)) {
            if (/^tracely\.widget\.(vcache|scache)\./.test(k) && k !== VCACHE_KEY && k !== SCACHE_KEY) lsDel(k);
          }
        } catch { /* sandboxed */ }
        lsSet(VCACHE_KEY, JSON.stringify(keep.slice(-100)));
        lsSet(SCACHE_KEY, JSON.stringify(src.slice(-5)));
      }
    }
    // LRU registry of docs holding Tracely caches — GC the oldest beyond 20
    // so dead docs never fill the origin's localStorage (shared with Docs).
    {
      const REG_KEY = "tracely.widget.docs";
      const reg = jsonParse(lsGet(REG_KEY) ?? "[]", []).filter((e) => Array.isArray(e) && e[0] !== DOC_ID);
      reg.push([DOC_ID, Date.now()]);
      reg.sort((a, b) => a[1] - b[1]);
      while (reg.length > 20) {
        const [old] = reg.shift();
        lsDel(`tracely.widget.vcache.${old}`);
        lsDel(`tracely.widget.scache.${old}`);
        lsDel(`tracely.widget.dismissed.${old}`);
      }
      lsSet(REG_KEY, JSON.stringify(reg));
    }
    let settings = { model: SPEED_STOPS[0].model, effort: "low", citationStyle: "apa", ...jsonParse(lsGet(SETTINGS_KEY) ?? "{}", {}) };
    let segments = [];
    let inflight = false;
    let sourcesInflight = false;
    let lastCheckEnd = Date.now();
    let statusMsg = "starting…";
    let statusKind = "idle"; // idle | checking | error | offline
    let expanded = false;
    let docText = "";
    let copiedFixHash = null; // survives re-renders, unlike a bare textContent swap
    let bridgeReady = false;  // Docs bridge configured server-side → in-doc edit buttons
    let standaloneMode = false; // background worker is talking to api.openai.com directly
    let docBusy = false;
    const docFixed = new Set();
    let autoSourceTimes = []; // rolling-hour guard on automatic source lookups

    // ── doc reading ──
    async function getDocText() {
      if (harness) return harness.getText();
      const res = await fetch(`https://docs.google.com/document/d/${DOC_ID}/export?format=txt`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`doc export failed (${res.status})`);
      const t = await res.text();
      return t.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    }

    function uncheckedSegments() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        if (cache.has(seg.hash)) continue;
        out.push(seg);
      }
      return out;
    }

    async function cycle() {
      if (inflight || document.hidden) return;
      inflight = true;
      try {
        docText = await getDocText();
        segments = segmentText(docText);
        const todo = uncheckedSegments().slice(0, MAX_SENTENCES_PER_CHECK);
        if (todo.length > 0) {
          statusKind = "checking";
          statusMsg = `checking ${todo.length}…`;
          render();
          const data = await api("/api/check", {
            text: docText.slice(0, MAX_INPUT_CHARS),
            sentences: todo.map((s) => ({ id: s.hash, text: s.text })),
            model: effModel(settings),
            effort: effEffort(settings),
          });
          for (const f of data.findings ?? []) {
            cache.set(f.id, { verdict: f.verdict, explanation: f.explanation, revision: f.revision, confidence: f.confidence });
          }
          persistCaches();
          autoFindSources(data.findings ?? []); // fire-and-forget, capped
        }
        statusKind = "idle";
        const n = currentIssues().length + activeFlowIssues().length;
        statusMsg = n > 0 ? `${n} issue${n === 1 ? "" : "s"} found` : "all clear";
        requestFlow(); // fire-and-forget; gated on structure change + rate floor
      } catch (err) {
        if (err?.kind === "no_key") {
          statusKind = "error";
          statusMsg = "Add your OpenAI API key in Tracely's settings";
        } else if (err?.kind === "no_engine") {
          statusKind = "offline";
          statusMsg = err.message;
        } else if (offlineError(err)) {
          statusKind = "offline";
          statusMsg = "Can't reach Tracely — add your API key in settings to keep checking";
        } else {
          statusKind = "error";
          statusMsg = err?.message ?? "check failed";
        }
      } finally {
        inflight = false;
        lastCheckEnd = Date.now();
        render();
      }
    }

    function currentIssues() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        if (!f || dismissed.has(seg.hash) || !ISSUE_VERDICTS.includes(f.verdict)) continue;
        out.push({ seg, f });
      }
      return out;
    }

    /* ── overlay underlines over the Docs canvas ──────────────────────────
       Docs paints text onto canvas tiles, so field mode's DOM techniques
       can't see it. docs-hook.js (page world, document_start) wraps the
       canvas text calls and keeps a ledger of what was painted where; we ask
       it to locate each flagged sentence and draw the same wavy underlines
       in a fixed overlay. If the hook finds nothing (Docs changed how it
       paints, hook not injected), nothing is drawn and the widget behaves
       exactly as before — this is strictly additive. */
    let locateSeq = 0;
    let lastVerdictByHash = new Map();

    /* ── PRIMARY position source: Docs' SVG annotation layer ──────────────
       Modern Docs keeps an invisible SVG beside each canvas tile: one
       <rect aria-label="line text" data-font-css="…"> per painted text run.
       It is ordinary DOM — every line is ALWAYS represented (no repaint
       churn, so never "one underline at a time") and getBoundingClientRect
       is always current (no locate round-trip, so no scroll lag). The
       canvas-paint hook remains only as a fallback for docs where this
       layer is absent. Matching logic mirrors the hook's (whitespace-free). */
    const nrm = (s) => s.toLowerCase().replace(/[​‌﻿ ]/g, " ").replace(/\s+/g, "");
    const SVG_STRIP = /[\s​‌﻿ ]/;
    function svgRawIndexAt(text, normIdx) {
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        if (SVG_STRIP.test(text[i])) continue;
        if (n === normIdx) return i;
        n++;
      }
      return text.length;
    }
    function svgOverlapRange(L, S) {
      const i = L.indexOf(S);
      if (i >= 0) return [i, i + S.length];
      if (L.length >= 6 && S.includes(L)) return [0, L.length];
      const lim = Math.min(L.length, S.length);
      for (let p = lim; p >= 12; p--) {
        let ok = true;
        const off = L.length - p;
        for (let k = 0; k < p; k++) if (L.charCodeAt(off + k) !== S.charCodeAt(k)) { ok = false; break; }
        if (ok) return [L.length - p, L.length];
      }
      const tailMin = /[.!?…"'’”)\]]$/.test(S) ? 5 : 12;
      for (let p = lim; p >= tailMin; p--) {
        let ok = true;
        const off = S.length - p;
        for (let k = 0; k < p; k++) if (L.charCodeAt(k) !== S.charCodeAt(off + k)) { ok = false; break; }
        if (ok) return [0, p];
      }
      return null;
    }
    let svgMeas = null;
    function svgFrac(node, text, font, rawTo) {
      if (!svgMeas) svgMeas = document.createElement("canvas").getContext("2d");
      try {
        svgMeas.font = font || "16px Arial";
        const full = svgMeas.measureText(text).width || 1;
        return svgMeas.measureText(text.slice(0, rawTo)).width / full;
      } catch {
        return 0;
      }
    }
    function svgLineNodes() {
      let nodes = document.querySelectorAll(".kix-canvas-tile-content svg rect[aria-label]");
      if (!nodes.length) nodes = document.querySelectorAll("svg rect[aria-label][data-font-css]");
      return [...nodes].filter((n) => (n.getAttribute("aria-label") || "").trim());
    }
    // Group nodes into visual lines by rendered top, join normalized text,
    // find each sentence's covered span, convert boundary coverage into
    // FRACTIONS of each node's width (zoom-proof), return bar descriptors.
    function svgLocate(issues) {
      const nodes = svgLineNodes();
      if (!nodes.length) return null; // no annotation layer — fall back
      const buckets = new Map();
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (r.width === 0) continue;
        const key = Math.round(r.top / 4) * 4;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push({ node, r, raw: node.getAttribute("aria-label"), font: node.getAttribute("data-font-css") || "" });
      }
      const lines = [];
      for (const runs of buckets.values()) {
        runs.sort((a, b) => a.r.left - b.r.left);
        let joined = "";
        const spans = [];
        for (const run of runs) {
          const n = nrm(run.raw);
          spans.push([joined.length, joined.length + n.length, run]);
          joined += n;
        }
        if (joined) lines.push({ joined, spans });
      }
      const bars = [];
      for (const { seg } of issues) {
        const S = nrm(seg.text);
        if (S.length < 4) continue;
        for (const line of lines) {
          const range = svgOverlapRange(line.joined, S);
          if (!range) continue;
          for (const [s, e, run] of line.spans) {
            if (e <= range[0] || s >= range[1]) continue;
            let f0 = 0, f1 = 1;
            if (range[0] > s) f0 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[0] - s));
            if (range[1] < e) f1 = svgFrac(run.node, run.raw, run.font, svgRawIndexAt(run.raw, range[1] - s));
            if (f1 - f0 <= 0.005) continue;
            bars.push({ hash: seg.hash, node: run.node, raw: run.raw, f0, f1 });
          }
        }
      }
      return bars;
    }

    /* Bars are carried by the COMPOSITOR wherever that is possible, and glued
       to the document by a per-frame loop only where it is not:
         - SVG mode  → a <rect> beside Docs' own annotation rect (in-tree);
         - canvas fallback → an absolutely-positioned div inside the kix PAGE
           the text is painted on (page-anchored, see ensurePageLayer);
         - anything unresolvable → a position:fixed div in marksLayer, glued
           every frame. Laggy, but it is never absent.
       The v2.6 lesson ("never inject into DOM an app owns") was about kix's
       TILE divs, which kix wipes. Both exceptions above are measured, not
       assumed — see the note on ensurePageLayer. */
    let marksLayer = null;
    let docsBars = []; // [{hash, el, tile, rx, ry, w, size, fallLeft, fallTop, inSvg, inPage}]
    const tileState = new Map(); // tileId → {canvas, sx, sy, shiftX, shiftY}
    const pageLayers = new Map(); // kix page el → our overlay div inside it
    let glueRaf = 0;
    let docsScroller = null;
    let selfMutating = false;      // our own annotation-SVG writes, for the observer to skip
    let inTreeDisabledUntil = 0;   // in-tree bars paused until this time if Docs fights us
    let inTreeCooldown = 60_000;   // doubles per latch, capped at 15min
    let hostileStrikes = [];       // timestamps of Docs deleting our bars targetedly

    function ensureLayer() {
      if (marksLayer && marksLayer.isConnected) return;
      marksLayer = document.createElement("div");
      marksLayer.setAttribute("data-tracely-docs-marks", "");
      Object.assign(marksLayer.style, {
        // Modest z: above the editing surface, below Docs menus/dialogs.
        position: "fixed", inset: "0", pointerEvents: "none", zIndex: "900",
      });
      document.documentElement.appendChild(marksLayer);
    }

    /* ── the canvas fallback's compositor anchor ───────────────────────────
       One overlay div per kix page, holding that page's bars. Measured on
       real Docs (signed-out doc, so the annotation layer was absent and this
       WAS the live path) rather than assumed:

       - `div.kix-page-paginated` carries an inline
         `position:absolute; top:…; left:…; z-index:N; width:816px; height:1056px`,
         so it is the canvas tile's offsetParent — canvas.offsetLeft/offsetTop
         are page-local CSS px with no transform anywhere in the chain, which
         is exactly the space the hook's canvas-relative rects convert into.
       - kix does NOT sanitize children out of it: zero removals across two
         documents, every scroll, every repaint, and page recycling. (The nodes
         kix wipes are the TILE divs; this is the page above them.)
       - a div in there is rigidly compositor-locked to the text — a probe bar
         held its offset to the page to the pixel across every scroll position,
         with no script in the loop. That is the whole point of this path.
       - the page is overflow:visible, so it does NOT clip: the overlay carries
         overflow:hidden itself, which is what keeps a bar off the gutter
         between pages (the fixed layer never managed that).
       - the page sets a z-index (its page number), making it a stacking
         context, and the canvas inside it carries that same z-index. So the
         overlay needs to outrank the canvas — and a max-int z-index is safe
         precisely BECAUSE the page is a stacking context: it cannot escape the
         page to cover Docs' menus. */
    function ensurePageLayer(page) {
      let layer = pageLayers.get(page);
      if (layer && layer.isConnected && layer.parentNode === page) return layer;
      layer = document.createElement("div");
      // Same marker the annotation observer uses to recognize our own writes —
      // a differently-tagged node would read as an external mutation and spin
      // a re-locate loop.
      layer.setAttribute("data-tracely-bar", "");
      layer.setAttribute("data-tracely-page-layer", "");
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, {
        position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
        overflow: "hidden", pointerEvents: "none", zIndex: "2147483647",
      });
      page.appendChild(layer);
      pageLayers.set(page, layer);
      return layer;
    }

    // The kix page a tile canvas paints onto, or null when this document isn't
    // shaped the way the measurements above describe (pageless view, a future
    // re-layout) — callers then fall through to the glued layer.
    function pageOf(canvas) {
      const page = canvas?.closest?.(".kix-page-paginated");
      // offsetParent identity is the load-bearing part: it is what makes
      // canvas.offsetLeft/offsetTop page-local, and it is false the moment
      // kix stops positioning pages the way we measured.
      return page && canvas.offsetParent === page ? page : null;
    }

    function clearDocsMarks() {
      // Kill any pending glue frame FIRST: draw paths call glueFrame()
      // synchronously right after this, and an orphaned pending handle would
      // self-perpetuate as a second parallel rAF chain (they accumulate).
      if (glueRaf) { cancelAnimationFrame(glueRaf); glueRaf = 0; }
      selfMutating = true;
      if (marksLayer) marksLayer.textContent = "";
      // In-tree bars live inside Docs' annotation SVGs and page-anchored bars
      // inside kix's pages — remove them there, plus a sweep for strays whose
      // tile was recycled out from under us.
      for (const b of docsBars) if (b.inSvg) b.el.remove();
      pageObs.disconnect();
      for (const layer of pageLayers.values()) layer.remove();
      pageLayers.clear();
      for (const stray of document.querySelectorAll("[data-tracely-bar]")) stray.remove();
      docsBars = [];
      tileState.clear();
      queueMicrotask(() => { selfMutating = false; });
    }

    /* Page recycling — the one way a compositor-carried bar can go wrong.
       kix keeps a small POOL of page elements and reuses them for other pages
       as you scroll: the very elements a probe was injected into at document
       offsets 5px and 1071px turned up later at 33051px and 31985px, overlay
       still attached. A bar left on a recycled page would underline whatever
       text now occupies it.

       kix positions both the page and its tile canvas through their inline
       style attributes, so a `style`-filtered observer on exactly the nodes we
       anchored to fires on exactly that event and little else — the same trick
       the annotation observer plays on the SVG path, and for the same reason:
       observer callbacks run BEFORE the next paint, so a stale bar is hidden
       before a wrong frame can reach the screen. Re-matching is left to the
       usual locate pass; this only has to stop the lie. */
    const pageObs = new MutationObserver(() => {
      let stale = false;
      for (const b of docsBars) {
        if (!b.inPage || b.el.style.display === "none") continue;
        const moved = b.page.offsetTop !== b.pageTop || b.page.offsetLeft !== b.pageLeft ||
          b.canvas.offsetTop !== b.canvasTop || b.canvas.offsetLeft !== b.canvasLeft;
        if (!moved) continue;
        b.el.style.display = "none";
        stale = true;
      }
      if (stale) fastDocsMarks(); // this page now paints other text — re-match NOW
    });

    function glueFrame() {
      glueRaf = 0;
      if (docsBars.length === 0) return;
      let staleSvg = false;
      let needLoop = false;
      for (const t of tileState.values()) {
        if (t.canvas && !t.canvas.isConnected) t.canvas = null;
        if (!t.canvas) continue;
        t.rect = t.canvas.getBoundingClientRect();
      }
      // Bars must never draw over Docs' own chrome: clip to the editor's
      // scroll area (tiles for scrolled-away text keep DOM positions that
      // land on the toolbar otherwise).
      let clip = null;
      if (!docsScroller || !docsScroller.isConnected) {
        docsScroller = document.querySelector(".kix-appview-editor");
      }
      if (docsScroller) clip = docsScroller.getBoundingClientRect();
      for (const b of docsBars) {
        // Compositor-carried: no per-frame work, clipped natively (in-tree by
        // the editor, page-anchored by its own overflow:hidden overlay).
        if (b.inSvg || b.inPage) continue;
        needLoop = true;
        if (b.node) {
          // SVG mode: the annotation rect IS the live position — zero lag.
          // Docs RECYCLES annotation nodes when tiles scroll far: the same
          // element suddenly describes different text. Validate the binding
          // every frame — a recycled node hides its bar instantly instead of
          // underlining the wrong sentence until the next re-match.
          if (!b.node.isConnected || b.node.getAttribute("aria-label") !== b.raw) {
            b.el.style.opacity = "0";
            staleSvg = true;
            continue;
          }
          const r = b.node.getBoundingClientRect();
          const x = r.left + b.f0 * r.width;
          const y = r.bottom + 1;
          b.el.style.transform = `translate(${x}px, ${y}px)`;
          b.el.style.width = (b.f1 - b.f0) * r.width + "px";
          const out = y < -20 || y > innerHeight + 20 ||
            (clip && (y < clip.top + 2 || y > clip.bottom - 2 || x > clip.right || x + (b.f1 - b.f0) * r.width < clip.left));
          b.el.style.opacity = out ? "0" : "1";
          b.size = r.height || b.size;
          continue;
        }
        const t = tileState.get(b.tile);
        if (t && t.canvas && t.rect) {
          const x = t.rect.left + b.rx + t.shiftX * t.sx;
          const y = t.rect.top + b.ry + t.shiftY * t.sy;
          const off = y < -20 || y > innerHeight + 20;
          b.el.style.transform = `translate(${x}px, ${y}px)`;
          b.el.style.opacity = off ? "0" : "1";
        } else {
          // Tile unresolvable — fall back to the viewport position the hook
          // computed at locate time (v2.5-era behavior: right place, lags on
          // scroll until the next locate instead of showing nothing).
          b.el.style.transform = `translate(${b.fallLeft}px, ${b.fallTop}px)`;
          b.el.style.opacity = "1";
        }
      }
      if (staleSvg) fastDocsMarks(); // Docs recycled annotation nodes — re-match NOW
      // In-tree and page-anchored bars ride the compositor; only glued bars
      // need frames. !glueRaf: fastDocsMarks above can synchronously redraw and
      // schedule its own chain — never stack a second one on top.
      if (needLoop && !glueRaf) glueRaf = requestAnimationFrame(glueFrame);
    }
    function startGlue() {
      if (!glueRaf && docsBars.some((b) => !b.inSvg && !b.inPage)) glueRaf = requestAnimationFrame(glueFrame);
    }

    function drawDocsMarks(rects) {
      try {
        ensureLayer();
        selfMutating = true;
        clearDocsMarks();
        let received = 0, anchored = 0, glued = 0;
        for (const [hash, list] of Object.entries(rects ?? {})) {
          const verdict = lastVerdictByHash.get(hash);
          const color = MARK_COLORS[verdict];
          if (!color) continue;
          for (const r of list) {
            if (!r || r.width < 3) continue;
            received++;
            if (!tileState.has(r.tile)) {
              const fresh = {
                canvas: document.querySelector(`canvas[data-tracely-tile="${r.tile}"]`),
                sx: 1, sy: 1, shiftX: 0, shiftY: 0, rect: null,
              };
              if (fresh.canvas) {
                fresh.sx = (fresh.canvas.getBoundingClientRect().width || 1) / (fresh.canvas.width || 1);
                fresh.sy = (fresh.canvas.getBoundingClientRect().height || 1) / (fresh.canvas.height || 1);
              }
              tileState.set(r.tile, fresh);
            }
            const t = tileState.get(r.tile);
            /* PAGE-ANCHORED bar — the fallback's answer to scroll lag. The
               hook hands us canvas-relative CSS px; the tile canvas is
               positioned inside its kix page, so page-local coordinates are
               just canvas.offsetLeft/offsetTop plus that. Written once into a
               div inside the page, the bar is then carried by the compositor
               exactly like the in-tree SVG path, with no frame loop at all.
               (Skipped while the hostility latch is engaged — if Docs is
               deleting our nodes out of its own subtree, this is not the
               moment to put more of them there.) */
            const page = Date.now() >= inTreeDisabledUntil ? pageOf(t?.canvas) : null;
            const bar = document.createElement("div");
            Object.assign(bar.style, {
              left: "0", top: "0", width: r.width + "px", height: "3px",
              background: color, borderRadius: "2px", pointerEvents: "none",
            });
            if (page) {
              bar.setAttribute("data-tracely-bar", "");
              bar.setAttribute("aria-hidden", "true");
              const x = t.canvas.offsetLeft + r.x;
              const y = t.canvas.offsetTop + r.y;
              // No will-change: this transform is written once and never
              // again, so promoting 40 bars to their own layers would only
              // spend memory. The page they sit in is already composited.
              bar.style.position = "absolute";
              bar.style.transform = `translate(${x}px, ${y}px)`;
              ensurePageLayer(page).appendChild(bar);
              pageObs.observe(page, { attributes: true, attributeFilter: ["style"] });
              pageObs.observe(t.canvas, { attributes: true, attributeFilter: ["style"] });
              docsBars.push({
                hash, el: bar, tile: r.tile,
                rx: r.x, ry: r.y, size: r.size || 18,
                fallLeft: r.left ?? 0, fallTop: r.top ?? 0,
                // Baked source geometry: the recycling observer diffs these to
                // tell "kix restyled this page" from "kix MOVED it".
                inPage: true, page, canvas: t.canvas,
                pageTop: page.offsetTop, pageLeft: page.offsetLeft,
                canvasTop: t.canvas.offsetTop, canvasLeft: t.canvas.offsetLeft,
              });
              anchored++;
            } else {
              // No resolvable page (pageless view, or the latch is on): the
              // v2.5-era fixed div, glued to the tile every frame.
              bar.style.position = "fixed";
              bar.style.willChange = "transform";
              marksLayer.appendChild(bar);
              docsBars.push({
                hash, el: bar, tile: r.tile,
                rx: r.x, ry: r.y, size: r.size || 18,
                fallLeft: r.left ?? 0, fallTop: r.top ?? 0,
              });
              glued++;
            }
          }
        }
        queueMicrotask(() => { selfMutating = false; });
        // One log per draw — screenshot-diagnosable if bars ever go missing.
        console.debug(`[tracely] v${EXT_VERSION} docs marks (canvas fallback): ${docsBars.length} bar(s) from ${received} rect(s) — ${anchored} page-anchored across ${pageLayers.size} page(s), ${glued} glued; tiles resolved: ${[...tileState.values()].filter((t) => t.canvas).length}/${tileState.size}`);
        glueFrame(); // position immediately, then keep gluing
        startGlue();
      } catch (err) {
        console.warn("[tracely] docs mark draw failed:", err);
      }
    }

    /* Visual rows of the page, in reading order: one entry per painted line,
       carrying its annotation rect(s) and attribute-space geometry. The
       underline matcher buckets the same nodes by top; flow needs whole rows
       (and their extents) so it can bracket a paragraph in the margin. */
    function svgRows() {
      const rows = new Map();
      for (const node of svgLineNodes()) {
        const r = node.getBoundingClientRect();
        if (r.width === 0) continue;
        const key = Math.round(r.top / 4) * 4;
        let row = rows.get(key);
        if (!row) { row = { key, nodes: [], clientTop: r.top }; rows.set(key, row); }
        row.nodes.push(node);
      }
      const out = [];
      for (const row of [...rows.values()].sort((a, b) => a.clientTop - b.clientTop)) {
        row.nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const joined = row.nodes.map((n) => nrm(n.getAttribute("aria-label"))).join("");
        if (!joined) continue;
        const g = row.nodes.map((n) => ({
          x: parseFloat(n.getAttribute("x")), y: parseFloat(n.getAttribute("y")),
          w: parseFloat(n.getAttribute("width")), h: parseFloat(n.getAttribute("height")),
          svg: n.ownerSVGElement, node: n,
        })).filter((v) => [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.svg);
        if (!g.length) continue;
        // Rects are bucketed by their TOP, which quietly merges a table's
        // cells into one pseudo-row: its text is every column concatenated and
        // its box spans the whole table. Prose runs on one line sit flush
        // against each other, so the widest horizontal gap tells the two
        // apart, and a flow bracket must never anchor to the table shape.
        const sorted = [...g].sort((a, b) => a.x - b.x);
        let maxGap = 0;
        for (let i = 1; i < sorted.length; i++) {
          maxGap = Math.max(maxGap, sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
        }
        const y = Math.min(...g.map((v) => v.y));
        const bottom = Math.max(...g.map((v) => v.y + v.h));
        out.push({
          joined, nodes: row.nodes, svg: g[0].svg,
          x: Math.min(...g.map((v) => v.x)),
          right: Math.max(...g.map((v) => v.x + v.w)),
          y, bottom,
          segmented: maxGap > Math.max(12, (bottom - y) * 1.5),
        });
      }
      return out;
    }

    /* Locate each flow issue's PARAGRAPH on the page. The model anchors an
       issue to one verbatim sentence; the bracket spans the whole paragraph
       that sentence belongs to, which is what the design shows. */
    function svgFlowLocate(flows) {
      if (!flows.length) return [];
      const rows = svgRows();
      if (!rows.length) return [];
      const paras = docText.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      const out = [];
      const used = new Set();
      for (const issue of flows) {
        const S = nrm(issue.passage);
        if (S.length < 8) continue;
        const para = paras.find((p) => nrm(p).includes(S)) ?? issue.passage;
        const P = nrm(para);
        /* Anchor on the PASSAGE, not on "any row that happens to appear inside
           the paragraph". The looser test matched the first SHORT row whose
           text coincided with something in the paragraph — a title fragment, a
           table cell like "1492" — which put the bracket at the top of the
           document and, because a short row's right edge is far left, stranded
           the chip out in the margin with no bracket beside it. */
        /* Match the anchor on letters and digits only. `nrm` strips whitespace
           but KEEPS punctuation, and the text Docs exports does not always
           punctuate identically to the text it renders — a straight quote for
           a curly one, an en dash for a hyphen — so a key carrying a comma or
           a quote can fail to match a line that is plainly the right one. The
           underline matcher keeps `nrm`, which has earned its keep on
           sentences; only this anchor needs to be forgiving. */
        const loose = (t) => t.replace(/[^a-z0-9]/g, "");
        const key = loose(S).slice(0, 24);
        const start = key.length < 12 ? -1
          : rows.findIndex((r) => !r.segmented && loose(r.joined).includes(key));
        // No confident anchor: draw NOTHING. The looser fallbacks that used to
        // sit here are what put a bracket on a title and a pair of chips on a
        // table header. The issue still counts in the widget, where it needs
        // no position to be useful — a flag in the wrong place is worse than
        // one the reader has to open the panel to see.
        if (start === -1) continue;
        // Two issues resolving to one line drew their chips on top of each
        // other, which reads as corrupted text rather than as two findings.
        if (used.has(start)) continue;
        used.add(start);
        // Extend while rows still belong to this paragraph and the same tile:
        // a bracket is one shape, so it can't straddle two annotation layers.
        let end = start;
        for (let i = start + 1; i < rows.length; i++) {
          if (rows[i].svg !== rows[start].svg) break;
          if (rows[i].segmented) break; // a table below the paragraph ends it
          if (!rows[i].joined || !P.includes(rows[i].joined)) break;
          if (rows[i].y > rows[end].bottom + rows[end].bottom - rows[end].y) break; // paragraph gap
          end = i;
        }
        /* The chip belongs in the MARGIN, past the text — which means it must
           be placed from the text COLUMN's right edge, not from the matched
           row's. A row's rects do not always span the whole visual line (the
           rest of the line can sit in a separate rect that buckets
           elsewhere), and positioning off that partial edge dropped the chip
           on top of the next words on the same line. The column edge is the
           widest row on this page, which is stable whatever the line does. */
        const colRight = Math.max(...rows.filter((r) => r.svg === rows[start].svg).map((r) => r.right));
        out.push({
          hash: flowHashOf(issue), issue,
          svg: rows[start].svg,
          colRight,
          x: Math.min(...rows.slice(start, end + 1).map((r) => r.x)),
          right: Math.max(...rows.slice(start, end + 1).map((r) => r.right)),
          top: rows[start].y,
          bottom: rows[end].bottom,
          lineH: Math.max(8, rows[start].bottom - rows[start].y),
        });
      }
      return out;
    }

    const SVGNS = "http://www.w3.org/2000/svg";
    function svgEl(name, attrs) {
      const el = document.createElementNS(SVGNS, name);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    }

    /* Draw one flow flag in the annotation layer: margin bracket, badge, and
       a right-margin chip — all in-tree, so they ride the compositor with the
       text exactly like the underlines do. Geometry mirrors the Figma frame. */
    function drawFlowFlag(f) {
      const g = svgEl("g", { "data-tracely-bar": "", "data-tracely-flow": "", "aria-hidden": "true", "pointer-events": "none" });
      const lh = f.lineH;
      const bx = f.x - lh * 1.55;              // bracket sits in the left margin
      const top = f.top + lh * 0.15;
      const bot = f.bottom;
      const r = lh * 0.34;                     // corner radius, scales with type size
      // Vertical spine with a rounded elbow into a short arrow at the foot.
      g.appendChild(svgEl("path", {
        d: `M ${bx} ${top + r} L ${bx} ${bot - r} Q ${bx} ${bot} ${bx + r} ${bot} L ${bx + r * 1.5} ${bot}`,
        fill: "none", stroke: FLOW_COLOR, "stroke-width": Math.max(1.2, lh * 0.075),
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
      g.appendChild(svgEl("path", {
        d: `M ${bx + r * 0.9} ${bot - r * 0.5} L ${bx + r * 1.7} ${bot} L ${bx + r * 0.9} ${bot + r * 0.5} Z`,
        fill: FLOW_COLOR,
      }));
      // Badge: filled disc at the head of the bracket with a flow glyph.
      const cy = f.top + lh * 0.42, cr = lh * 0.62;
      g.appendChild(svgEl("circle", { cx: bx, cy, r: cr, fill: FLOW_COLOR }));
      g.appendChild(svgEl("path", {
        d: `M ${bx - cr * 0.5} ${cy + cr * 0.08} q ${cr * 0.25} ${-cr * 0.55} ${cr * 0.5} 0 q ${cr * 0.25} ${cr * 0.55} ${cr * 0.5} 0`,
        fill: "none", stroke: "#fff", "stroke-width": Math.max(1, cr * 0.22),
        "stroke-linecap": "round",
      }));
      // Right-margin chip — dot plus label, aligned to the first line.
      const chipX = (f.colRight ?? f.right) + lh * 0.9, chipY = f.top + lh * 0.62;
      g.appendChild(svgEl("circle", { cx: chipX, cy: chipY - lh * 0.2, r: Math.max(2, lh * 0.13), fill: FLOW_ACCENT }));
      const label = svgEl("text", {
        x: chipX + lh * 0.42, y: chipY, fill: FLOW_ACCENT,
        "font-size": lh * 0.62, "font-family": "Arial, Helvetica, sans-serif", "font-weight": "500",
      });
      label.textContent = "Flow issue";
      g.appendChild(label);
      f.svg.appendChild(g);
      return g;
    }

    function drawDocsMarksSvg(svgBars, flows = []) {
      try {
        ensureLayer();
        selfMutating = true;
        clearDocsMarks();
        let inTree = 0, glued = 0;
        for (const sb of svgBars) {
          const color = MARK_COLORS[lastVerdictByHash.get(sb.hash)];
          if (!color) continue;
          const svg = sb.node.ownerSVGElement;
          const rx = parseFloat(sb.node.getAttribute("x"));
          const ry = parseFloat(sb.node.getAttribute("y"));
          const rw = parseFloat(sb.node.getAttribute("width"));
          const rh = parseFloat(sb.node.getAttribute("height"));
          if (Date.now() >= inTreeDisabledUntil && svg && [rx, ry, rw, rh].every(Number.isFinite)) {
            /* IN-TREE bar — Grammarly's actual trick. The rect lives in the
               same SVG as Google's text geometry, so the COMPOSITOR scrolls
               it with the text: zero lag with no script in the loop. (The
               v2.6 "never inject into kix's DOM" lesson was about the tile
               DIVS, which kix wipes; this SVG layer exists FOR extensions —
               annotate_canvas_by_ext — and is where Grammarly draws.) */
            const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            bar.setAttribute("data-tracely-bar", "");
            bar.setAttribute("aria-hidden", "true");
            bar.setAttribute("x", String(rx + sb.f0 * rw));
            bar.setAttribute("y", String(ry + rh - 2));
            bar.setAttribute("width", String(Math.max(2, (sb.f1 - sb.f0) * rw)));
            bar.setAttribute("height", "2.5");
            bar.setAttribute("rx", "1.25");
            bar.setAttribute("fill", color);
            bar.setAttribute("pointer-events", "none");
            const tf = sb.node.getAttribute("transform");
            if (tf) bar.setAttribute("transform", tf);
            // Sibling of the matched rect, not the SVG root: inherits the
            // exact ancestor transform chain (a <g transform> would otherwise
            // silently offset every bar).
            sb.node.parentNode.insertBefore(bar, sb.node.nextSibling);
            inTree++;
            docsBars.push({
              hash: sb.hash, el: bar, node: sb.node, raw: sb.raw, f0: sb.f0, f1: sb.f1,
              // size feeds hover-band math and popover placement in CSS px —
              // rh is SVG user units, so measure through the transform chain.
              size: sb.node.getBoundingClientRect().height || rh || 18,
              // Baked source geometry: the observer diffs these to follow
              // in-place re-coordination of the same node.
              gx: rx, gy: ry, gw: rw, gh: rh, tf: tf || "",
              inSvg: true,
            });
          } else {
            // Unusable geometry (or Docs proved hostile to in-tree bars):
            // fixed-layer div glued per-frame — laggy but never absent.
            const bar = document.createElement("div");
            Object.assign(bar.style, {
              position: "fixed", left: "0", top: "0",
              width: "0px", height: "3px",
              background: color, borderRadius: "2px", pointerEvents: "none",
              willChange: "transform",
            });
            marksLayer.appendChild(bar);
            glued++;
            docsBars.push({ hash: sb.hash, el: bar, node: sb.node, raw: sb.raw, f0: sb.f0, f1: sb.f1, size: 18 });
          }
        }
        /* IN-DOCUMENT FLOW BRACKETS ARE OFF BY DEFAULT.
           Placing them against Google's rendered text has now failed in five
           distinct ways — anchored to a title, to a table header, to a partial
           line, drawn twice, and drawn over the words themselves. The feature
           is fine; POSITIONING it is what keeps breaking, and a flag in the
           wrong place is worse than one the reader opens the panel to find.
           Flow issues render as cards there, needing no position at all.
           localStorage tracely.flowInDoc = "1" re-enables the bracket. */
        let flowDrawn = 0;
        for (const f of (FLOW_IN_DOC ? svgFlowLocate(flows) : [])) {
          const g = drawFlowFlag(f);
          flowDrawn++;
          docsBars.push({
            hash: f.hash, el: g, node: f.svg, raw: null, inSvg: true, flow: f.issue,
            size: f.lineH, gx: f.x, gy: f.top, gw: f.right - f.x, gh: f.bottom - f.top, tf: "",
          });
        }
        queueMicrotask(() => { selfMutating = false; });
        console.debug(`[tracely] v${EXT_VERSION} docs marks (svg): ${docsBars.length} bar(s) — ${inTree} in-tree, ${glued} glued, ${flowDrawn} flow — across ${new Set(svgBars.map((b) => b.node)).size} line node(s)`);
        glueFrame();
        startGlue();
      } catch (err) {
        console.warn("[tracely] docs svg mark draw failed:", err);
      }
    }

    // Docs' small scrolls blit pixels INSIDE a canvas (the tile doesn't
    // move) — the hook posts the shift at blit time so bars slide with the
    // pixels between authoritative locate rounds (which reset shifts).
    //
    // STILL LOAD-BEARING, despite page-anchored bars. It is dead for those:
    // in paginated view a tile canvas fills its page at offset 0,0, so a blit
    // that moves pixels within the tile moves them within the page too, and
    // page-local geometry simply stays correct — which is why those bars never
    // read a shift. But the glued path is not gone (pageless documents, an
    // unresolvable tile, the hostility latch), and there it is the only thing
    // keeping bars with blit-scrolled text between locates.
    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-shift") return;
      const t = tileState.get(ev.data.tile);
      if (!t) return;
      t.shiftX += Number(ev.data.dx) || 0;
      t.shiftY += Number(ev.data.dy) || 0;
    });

    window.addEventListener("message", (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-rects") return;
      if (ev.data.id !== locateSeq) return; // stale response from an older request
      drawDocsMarks(ev.data.rects);
    });

    function requestDocsMarks() {
      if (document.hidden) return;
      lastLocateAt = Date.now();
      armAnnotationObserver();
      // The hook caps at 40 wants — cap here too so nothing is silently dropped
      // on the other side of the protocol.
      const issues = currentIssues().slice(0, 40);
      const flows = activeFlowIssues();
      if (issues.length === 0 && flows.length === 0) {
        clearDocsMarks();
        hideDocsPopover();
        // Empty ping still prunes the fallback hook's ledgers. id 0 never
        // matches locateSeq, so its reply can never wipe drawn bars.
        window.postMessage({ type: "tracely-docs-locate", id: -1, wants: [] }, "*");
        return;
      }
      lastVerdictByHash = new Map(issues.map(({ seg, f }) => [seg.hash, f.verdict]));
      // PRIMARY: the SVG annotation layer — complete and live-positioned.
      const svgBars = issues.length ? svgLocate(issues) : [];
      if (svgBars !== null) {
        drawDocsMarksSvg(svgBars, flows);
        // Keep the hook's ledgers pruned even though we're not using them.
        // id 0: the rects listener ignores this reply — it must never clear
        // the SVG bars we just drew (that exact bug blanked every underline).
        window.postMessage({ type: "tracely-docs-locate", id: -1, wants: [] }, "*");
        return;
      }
      // FALLBACK: no annotation layer — canvas-paint locate via the hook.
      locateSeq++;
      window.postMessage({
        type: "tracely-docs-locate",
        id: locateSeq,
        wants: issues.map(({ seg }) => ({ hash: seg.hash, text: seg.text })),
      }, "*");
    }

    /* ── hover popover on the Docs underlines ─────────────────────────────
       Hovering an underline (or the text just above it) opens a compact card:
       verdict badge, explanation, suggested fix, and actions. Lives in the
       page DOM with inline styles only — Docs' stylesheets never touch it. */
    // (verdict labels/washes/colors are the shared top-level maps)
    let popEl = null, popHash = null, popHideTimer = null, popFontIn = false;
    let popAnchor = null, popLastTop = 0, popFollowRaf = 0, popLostAt = 0;

    function popFont() {
      if (popFontIn || !FONT_URL) return;
      popFontIn = true;
      const st = document.createElement("style");
      st.textContent = `@font-face{font-family:'Plus Jakarta Sans';src:url('${FONT_URL}') format('woff2');font-weight:200 800;font-display:swap;}`;
      document.head.appendChild(st);
    }

    function hideDocsPopover() {
      if (popEl) console.debug("[tracely] popover hide");
      if (popEl) popEl.remove();
      popEl = null;
      popHash = null;
      popAnchor = null;
      popLostAt = 0;
      if (popFollowRaf) { cancelAnimationFrame(popFollowRaf); popFollowRaf = 0; }
    }

    /* Position the popover against its underline's LIVE rect and aim the
       caret at it. Shared by the open path and the per-frame follow loop, so
       the card and its arrow stay welded to the bar while the doc scrolls. */
    function placeDocsPopover(r) {
      if (!popEl) return;
      // The card DROPS DOWN, always. Near the viewport bottom the scrollable
      // sources list shrinks to fit instead of the card flipping above the
      // line — the caret stays on the top edge, pointing at the underline.
      let top = (r.bottom ?? r.top + 4) + 8;
      const left = Math.max(12, Math.min(r.left, innerWidth - 360));
      const box = popEl.querySelector("[data-pop-sources]");
      if (box) {
        const fixedH = popEl.getBoundingClientRect().height - box.getBoundingClientRect().height;
        const avail = innerHeight - top - fixedH - 14;
        box.style.maxHeight = Math.max(90, Math.min(250, avail)) + "px";
      }
      // Clamp so the buttons never land below the fold (a fixed card can't be
      // scrolled to). At the extreme bottom this overlaps the line — still
      // never above it.
      const cardH = popEl.getBoundingClientRect().height;
      top = Math.max(12, Math.min(top, innerHeight - cardH - 10));
      const leftPx = left + "px", topPx = top + "px";
      if (popEl.style.left !== leftPx) popEl.style.left = leftPx;
      if (popEl.style.top !== topPx) popEl.style.top = topPx;
      const arrow = popEl.querySelector("[data-pop-arrow]");
      if (arrow) {
        const cx = r.centerX ?? r.left + 24;
        arrow.style.left = Math.max(14, Math.min(cx - left - 6, 340 - 26)) + "px";
      }
    }

    /* Follow loop — only alive while a popover is open. The underlines are
       compositor-carried now, so a card parked at its open position visibly
       detaches on the first scroll; this re-pins it every frame. When a
       re-locate rebuilds docsBars, the old anchor element dies — re-bind to
       the same claim's nearest bar. Anchor gone >400ms → the text left the
       viewport (or the claim resolved): let the card go. */
    function popFollowFrame() {
      popFollowRaf = 0;
      if (!popEl) return;
      const ok = (b) => b && b.el.isConnected && b.el.style.display !== "none" && b.el.style.opacity !== "0";
      if (!ok(popAnchor)) {
        let best = null, bestD = Infinity;
        for (const b of docsBars) {
          if (b.hash !== popHash || !ok(b)) continue;
          const d = Math.abs(b.el.getBoundingClientRect().top - popLastTop);
          if (d < bestD) { best = b; bestD = d; }
        }
        if (best) popAnchor = best;
      }
      let placed = false;
      if (ok(popAnchor)) {
        const r = popAnchor.el.getBoundingClientRect();
        if (!docsScroller || !docsScroller.isConnected) {
          docsScroller = document.querySelector(".kix-appview-editor");
        }
        const clip = docsScroller ? docsScroller.getBoundingClientRect() : null;
        if (!clip || (r.bottom >= clip.top + 2 && r.top <= clip.bottom - 2)) {
          popLastTop = r.top;
          popLostAt = 0;
          placeDocsPopover({
            left: r.left, top: r.top, bottom: r.bottom,
            size: popAnchor.size, centerX: r.left + r.width / 2,
          });
          placed = true;
        }
      }
      if (!placed) {
        if (!popLostAt) popLostAt = performance.now();
        else if (performance.now() - popLostAt > 400) { hideDocsPopover(); return; }
      }
      popFollowRaf = requestAnimationFrame(popFollowFrame);
    }

    function popBtn(label, primary) {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        border: primary ? "none" : "1px solid rgba(20,16,10,0.1)",
        background: primary ? "#0e0e10" : "#fff",
        color: primary ? "#fff" : "#0e0e10",
        borderRadius: "9px", padding: "6px 12px", fontSize: "11.5px",
        fontWeight: "700", cursor: "pointer", fontFamily: "inherit",
      });
      return b;
    }

    /* Flow callout — the card from the Figma flow frame: purple dot + title,
       the explanation, and one action that writes the suggested transition
       into the document ahead of the flagged passage. */
    function showFlowPopover(bar, rect, anchorBar) {
      const issue = bar.flow;
      console.debug("[tracely] flow popover open", bar.hash);
      popFont();
      hideDocsPopover();
      popHash = bar.hash;
      popEl = document.createElement("div");
      popEl.setAttribute("data-tracely-docs-popover", "");
      Object.assign(popEl.style, {
        position: "fixed", zIndex: "901", width: "300px",
        background: "#fff", borderRadius: "14px", padding: "14px 16px",
        border: "1px solid rgba(20,16,10,0.06)",
        boxShadow: "0 16px 44px rgba(88,60,170,0.20)",
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
        color: "#0d0d0f", fontSize: "12.5px", lineHeight: "1.5",
      });
      const arrow = document.createElement("div");
      arrow.setAttribute("data-pop-arrow", "");
      Object.assign(arrow.style, {
        position: "absolute", width: "11px", height: "11px", background: "#fff",
        transform: "rotate(45deg)", border: "solid rgba(20,16,10,0.08)",
        borderWidth: "1px 0 0 1px", top: "-6.5px", left: "20px", borderRadius: "2px 0 0 0",
      });
      popEl.appendChild(arrow);

      const head = document.createElement("div");
      Object.assign(head.style, { display: "flex", alignItems: "center", gap: "7px", marginBottom: "8px" });
      const dot = document.createElement("span");
      Object.assign(dot.style, { width: "7px", height: "7px", borderRadius: "50%", background: FLOW_ACCENT, flexShrink: "0" });
      const title = document.createElement("span");
      title.textContent = "Flow issue";
      Object.assign(title.style, { fontWeight: "700", fontSize: "14.5px", letterSpacing: "-0.01em" });
      head.append(dot, title);
      popEl.appendChild(head);

      const body = document.createElement("div");
      body.textContent = issue.explanation;
      Object.assign(body.style, { color: "#40454c", fontWeight: "500", marginBottom: "10px" });
      popEl.appendChild(body);

      if (issue.transition) {
        const prev = document.createElement("div");
        prev.textContent = `“${issue.transition}”`;
        Object.assign(prev.style, {
          background: "#f7f4ff", border: "1px solid rgba(115,68,241,0.14)", borderRadius: "10px",
          padding: "8px 10px", marginBottom: "10px", fontWeight: "500", color: "#3b3550",
        });
        popEl.appendChild(prev);
      }

      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", alignItems: "center", gap: "12px" });
      const act = document.createElement("button");
      act.textContent = canEditDoc() ? "Add transition →" : "Copy transition →";
      Object.assign(act.style, {
        border: "none", background: "none", padding: "0", cursor: "pointer",
        color: FLOW_ACCENT, fontWeight: "700", fontSize: "13px", fontFamily: "inherit",
      });
      act.addEventListener("click", async () => {
        if (!issue.transition) return;
        if (!canEditDoc()) {
          try { await navigator.clipboard.writeText(issue.transition); } catch { /* denied */ }
          act.textContent = "Copied ✓";
          return;
        }
        act.textContent = "Adding…";
        act.disabled = true;
        await addTransition(bar.hash, issue);
        hideDocsPopover();
      });
      row.appendChild(act);
      const dis = document.createElement("button");
      dis.textContent = "Dismiss";
      Object.assign(dis.style, {
        border: "none", background: "none", padding: "0", cursor: "pointer",
        color: "#8e8e93", fontWeight: "600", fontSize: "12.5px", fontFamily: "inherit",
      });
      dis.addEventListener("click", () => {
        flowDismissed.add(bar.hash);
        persistFlow();
        hideDocsPopover();
        requestDocsMarks();
        render();
      });
      row.appendChild(dis);
      popEl.appendChild(row);

      popEl.style.visibility = "hidden";
      document.documentElement.appendChild(popEl);
      placeDocsPopover(rect);
      popEl.style.visibility = "visible";
      popAnchor = anchorBar ?? null;
      popLastTop = rect.top;
      popLostAt = 0;
      if (!popFollowRaf) popFollowRaf = requestAnimationFrame(popFollowFrame);
    }

    // Insert the suggested transition as its own sentence ahead of the
    // flagged passage, then let the next structural pass re-judge the flow.
    async function addTransition(hash, issue) {
      if (docBusy) return;
      docBusy = true;
      render();
      try {
        const line = docText.split(/\n+/).find((p) => p.includes(issue.passage));
        if (!line) throw new Error("that passage moved — re-checking");
        const bridge = issue.transition.trim().replace(/\s+/g, " ");
        const replacement = line.replace(issue.passage, `${bridge} ${issue.passage}`);
        await docApply({ action: "replace", find: line, replacement });
        flowDismissed.add(hash);          // resolved — clears immediately
        flowSig = "";                     // structure changed: re-run flow next cycle
        persistFlow();
        statusKind = "idle";
        statusMsg = "transition added";
        lastCheckEnd = Date.now() - CHECK_INTERVAL_MS + 3000;
        requestDocsMarks();
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "couldn't add that transition";
      } finally {
        docBusy = false;
        render();
      }
    }

    function showDocsPopover(hash, rect, anchorBar) {
      console.debug("[tracely] popover open", hash);
      const f = cache.get(hash);
      if (!f) { console.debug("[tracely] popover abort: no finding"); return; }
      popFont();
      hideDocsPopover();
      popHash = hash;
      const color = MARK_COLORS[f.verdict] ?? "#8e8e93";
      popEl = document.createElement("div");
      popEl.setAttribute("data-tracely-docs-popover", "");
      Object.assign(popEl.style, {
        position: "fixed", zIndex: "901", width: "340px",
        background: "#fff", borderRadius: "14px", padding: "12px 14px",
        border: "1px solid rgba(20,16,10,0.06)", borderLeft: `3px solid ${color}`,
        boxShadow: "0 16px 44px rgba(180,120,60,0.24)",
        fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
        color: "#0e0e10", fontSize: "12.5px", lineHeight: "1.5",
      });
      const badge = document.createElement("span");
      badge.textContent = VERDICT_LABEL[f.verdict] ?? f.verdict;
      Object.assign(badge.style, {
        display: "inline-block", fontSize: "9px", fontWeight: "700",
        letterSpacing: ".8px", textTransform: "uppercase", padding: "3px 8px",
        borderRadius: "20px", background: VERDICT_WASH[f.verdict] ?? "#f2f2f3",
        color: VERDICT_TEXT[f.verdict] ?? "#8e8e93", marginBottom: "7px",
      });
      popEl.appendChild(badge);
      if (f.explanation) {
        const ex = document.createElement("div");
        ex.textContent = f.explanation;
        ex.style.marginBottom = "9px";
        ex.style.fontWeight = "500";
        popEl.appendChild(ex);
      }
      if (f.revision) {
        const fix = document.createElement("div");
        Object.assign(fix.style, {
          background: "#fdfbf9", border: "1px solid rgba(20,16,10,0.06)",
          borderRadius: "10px", padding: "8px 10px", marginBottom: "9px", fontWeight: "500",
        });
        fix.textContent = f.revision;
        popEl.appendChild(fix);
      }
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "7px" });
      if (f.revision) {
        if (canEditDoc()) {
          // The bridge can rewrite the sentence in the document itself — that
          // beats a clipboard round-trip, so it takes the primary slot.
          const fix = popBtn("Fix in doc", true);
          fix.addEventListener("click", async () => {
            fix.textContent = "Fixing…";
            fix.disabled = true;
            await docFix(hash);
            hideDocsPopover();
            requestDocsMarks(); // the fixed sentence's mark clears right away
          });
          row.appendChild(fix);
        } else {
          const copy = popBtn("Copy fix", true);
          copy.addEventListener("click", () => {
            try { navigator.clipboard.writeText(f.revision); } catch { /* clipboard denied */ }
            copy.textContent = "Copied ✓";
          });
          row.appendChild(copy);
        }
      }
      // With no rewrite on offer (citation-needed), finding the source IS the
      // fix — it gets the primary button. Sources load INTO the popover, so
      // picking one never requires a trip to the widget. Already-searched
      // claims render straight from the cache — closing and reopening the
      // card never repeats a search.
      const st0 = sourcesMap.get(hash);
      const haveSources = !!(st0 && (st0.loading || st0.list?.length));
      if (!haveSources) {
        const label = f.verdict === "needs_citation" ? "Find a source" : "Sources";
        const src = popBtn(label, !f.revision);
        src.addEventListener("click", async () => {
          src.textContent = "Searching…";
          src.disabled = true;
          let started = true;
          try { started = await fetchSources(hash); } catch { /* state lands in sourcesMap */ }
          if (started === false) {
            // Another claim's search holds the slot — don't fake progress.
            src.textContent = label;
            src.disabled = false;
            return;
          }
          src.remove();
          renderPopSources(hash);
        });
        row.appendChild(src);
      }
      const dis = popBtn("Dismiss", false);
      dis.addEventListener("click", () => {
        dismissed.add(hash);
        lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
        hideDocsPopover();
        requestDocsMarks();
        render();
      });
      row.appendChild(dis);
      popEl.appendChild(row);
      if (haveSources) renderPopSources(hash); // cached or in-flight — zero new API work
      // Stubby caret aimed at the underline — a rotated square whose opaque
      // face covers the card border where it meets the top edge (the card
      // always sits below the line; placeDocsPopover aims the caret's x).
      const arrow = document.createElement("div");
      arrow.setAttribute("data-pop-arrow", "");
      Object.assign(arrow.style, {
        position: "absolute", width: "11px", height: "11px",
        background: "#fff", transform: "rotate(45deg)",
        border: "solid rgba(20,16,10,0.08)", borderWidth: "1px 0 0 1px",
        top: "-6.5px", left: "20px", borderRadius: "2px 0 0 0",
      });
      popEl.appendChild(arrow);
      // Position against the LIVE bar rect, then keep following it.
      popEl.style.visibility = "hidden";
      document.documentElement.appendChild(popEl);
      placeDocsPopover(rect);
      popEl.style.visibility = "visible";
      popAnchor = anchorBar ?? null;
      popLastTop = rect.top;
      popLostAt = 0;
      if (!popFollowRaf) popFollowRaf = requestAnimationFrame(popFollowFrame);
    }

    function renderPopSources(hash) {
      if (!popEl || popHash !== hash) return;
      let box = popEl.querySelector("[data-pop-sources]");
      if (!box) {
        box = document.createElement("div");
        box.setAttribute("data-pop-sources", "");
        Object.assign(box.style, {
          marginTop: "9px", paddingTop: "8px", maxHeight: "250px", overflowY: "auto",
          borderTop: "1px solid rgba(20,16,10,0.07)",
        });
        popEl.appendChild(box);
      }
      box.textContent = "";
      const st = sourcesMap.get(hash);
      if (!st || st.loading) {
        box.textContent = !st && !sourcesInflight
          ? "Source search failed — close and reopen this card to retry."
          : "Searching the web for sources…";
        Object.assign(box.style, { color: "#a7a7ac", fontStyle: "italic", fontSize: "11.5px" });
        return;
      }
      box.style.color = "";
      box.style.fontStyle = "";
      if (!st.list || st.list.length === 0) {
        box.textContent = "No usable sources came back — try again from the widget.";
        return;
      }
      // Header: section label + citation-style pills (persisted, shared with
      // the widget via the same settings object).
      const head = document.createElement("div");
      Object.assign(head.style, {
        display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px",
      });
      const title = document.createElement("div");
      title.textContent = "Pick one to cite";
      Object.assign(title.style, {
        fontSize: "9px", fontWeight: "700", textTransform: "uppercase",
        letterSpacing: ".8px", color: "#ff7f00",
      });
      head.appendChild(title);
      const pills = document.createElement("div");
      Object.assign(pills.style, {
        display: "flex", gap: "2px", background: "#f2f2f3", borderRadius: "8px", padding: "2px",
      });
      for (const [key, label] of CITE_STYLES) {
        const p = document.createElement("button");
        p.textContent = label;
        const on = (settings.citationStyle || "apa") === key;
        Object.assign(p.style, {
          border: "none", borderRadius: "6px", padding: "3px 8px",
          fontSize: "9px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit",
          background: on ? "#fff" : "transparent",
          color: on ? "#ff7f00" : "#8e8e93",
          boxShadow: on ? "0 1px 3px rgba(20,16,10,0.10)" : "none",
        });
        p.addEventListener("click", () => {
          settings.citationStyle = key;
          lsSet(SETTINGS_KEY, JSON.stringify(settings));
          renderPopSources(hash); // repaint rows in the new style
        });
        pills.appendChild(p);
      }
      head.appendChild(pills);
      box.appendChild(head);
      const style = settings.citationStyle || "apa";
      st.list.forEach((srcItem, i) => {
        const c = formatCitation(srcItem, style);
        const row = document.createElement("div");
        Object.assign(row.style, { padding: "7px 0", borderBottom: "1px solid rgba(20,16,10,0.05)" });
        const line = document.createElement("div");
        Object.assign(line.style, { display: "flex", alignItems: "flex-start", gap: "6px" });
        if (srcItem.stance) {
          const chip = document.createElement("span");
          chip.textContent = srcItem.stance;
          const chipColors = {
            supports: ["#e7f6ee", "#1f9d55"],
            refutes: ["#fdecec", "#d93636"],
          }[srcItem.stance] ?? ["#f2f2f3", "#8e8e93"];
          Object.assign(chip.style, {
            fontSize: "8px", fontWeight: "700", textTransform: "uppercase",
            padding: "2px 6px", borderRadius: "8px", flexShrink: "0", marginTop: "2px",
            background: chipColors[0], color: chipColors[1],
          });
          line.appendChild(chip);
        }
        const a = document.createElement("a");
        a.href = srcItem.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = srcItem.title;
        Object.assign(a.style, { fontSize: "11.5px", fontWeight: "700", color: "#0e0e10", textDecoration: "none", display: "block", minWidth: "0" });
        line.appendChild(a);
        const meta = document.createElement("div");
        meta.textContent = srcItem.publisher || "";
        Object.assign(meta.style, { fontSize: "10px", color: "#a7a7ac", margin: "1px 0 4px", fontWeight: "500" });
        // Why this source answers the claim — one clamped line of snippet.
        let snip = null;
        if (srcItem.snippet) {
          snip = document.createElement("div");
          snip.textContent = srcItem.snippet;
          Object.assign(snip.style, {
            fontSize: "10.5px", color: "#5c5c60", fontWeight: "500", marginBottom: "5px",
            display: "-webkit-box", WebkitLineClamp: "2", WebkitBoxOrient: "vertical", overflow: "hidden",
          });
        }
        // Live formatted reference in the selected style, plus the in-text form.
        const refBox = document.createElement("div");
        Object.assign(refBox.style, {
          background: "#fdfbf9", border: "1px solid rgba(20,16,10,0.06)",
          borderRadius: "8px", padding: "6px 8px", marginBottom: "6px",
          fontSize: "10.5px", fontWeight: "500", lineHeight: "1.45",
          overflowWrap: "anywhere",
        });
        refBox.textContent = c.ref;
        const marker = document.createElement("div");
        marker.textContent = `In-text: ${c.marker}`;
        Object.assign(marker.style, { fontSize: "9.5px", color: "#a7a7ac", marginTop: "3px", fontWeight: "600" });
        refBox.appendChild(marker);
        const btns = document.createElement("div");
        Object.assign(btns.style, { display: "flex", gap: "6px" });
        if (canEditDoc()) {
          const cite = popBtn("Cite in doc", true);
          cite.style.padding = "4px 10px";
          cite.addEventListener("click", async () => {
            cite.textContent = "Citing…";
            cite.disabled = true;
            await docCite(hash, i);
            cite.textContent = "Cited ✓";
          });
          btns.appendChild(cite);
        }
        const copy = popBtn("Copy cite", !canEditDoc());
        copy.style.padding = "4px 10px";
        copy.addEventListener("click", () => {
          try { navigator.clipboard.writeText(c.ref); } catch { /* denied */ }
          copy.textContent = "Copied ✓";
        });
        btns.appendChild(copy);
        const copyIn = popBtn("Copy in-text", false);
        copyIn.style.padding = "4px 10px";
        copyIn.addEventListener("click", () => {
          try { navigator.clipboard.writeText(c.marker); } catch { /* denied */ }
          copyIn.textContent = "Copied ✓";
        });
        btns.appendChild(copyIn);
        row.appendChild(line);
        row.appendChild(meta);
        if (snip) row.appendChild(snip);
        row.append(refBox, btns);
        box.appendChild(row);
      });
    }

    let hoverRafBusy = false;
    window.addEventListener("mousemove", (e) => {
      if (hoverRafBusy) return;
      hoverRafBusy = true;
      const x = e.clientX, y = e.clientY;
      // rAF starves in hidden/throttled tabs — a lone mousemove during a
      // tab-hide must not wedge hover forever, so a timer backstops the frame.
      let hoverRan = false;
      const runHover = (fn) => { if (hoverRan) return; hoverRan = true; fn(); };
      setTimeout(() => runHover(hoverHit), 90);
      requestAnimationFrame(() => runHover(hoverHit));
      function hoverHit() {
        hoverRafBusy = false;
        // Bars are DOM-anchored now — read their LIVE viewport rects, which
        // are correct mid-scroll by construction.
        // In-tree bars are PAINT-clipped by the editor natively but their
        // client rects still exist off-viewport — clip the hit-test too, or
        // scrolled-away bars open phantom popovers over Docs chrome.
        if (!docsScroller || !docsScroller.isConnected) {
          docsScroller = document.querySelector(".kix-appview-editor");
        }
        const clip = docsScroller ? docsScroller.getBoundingClientRect() : null;
        const hitOf = (b) => {
          if (!b.el.isConnected || b.el.style.opacity === "0" || b.el.style.display === "none") return null;
          const r = b.el.getBoundingClientRect();
          if (clip && (r.bottom < clip.top + 2 || r.top > clip.bottom - 2 || r.left > clip.right || r.right < clip.left)) return null;
          return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - b.size && y <= r.bottom + 3
            ? { left: r.left, top: r.top, bottom: r.bottom, size: b.size, centerX: r.left + r.width / 2 }
            : null;
        };
        if (popEl) {
          const pb = popEl.getBoundingClientRect();
          const inPop = x >= pb.left - 8 && x <= pb.right + 8 && y >= pb.top - 8 && y <= pb.bottom + 8;
          const stillOnMark = docsBars.some((b) => b.hash === popHash && hitOf(b));
          if (inPop || stillOnMark) {
            clearTimeout(popHideTimer);
            popHideTimer = null;
            return;
          }
          if (!popHideTimer) popHideTimer = setTimeout(() => { popHideTimer = null; hideDocsPopover(); }, 250);
          return;
        }
        for (const b of docsBars) {
          const hit = hitOf(b);
          if (hit) {
            if (b.flow) showFlowPopover(b, hit, b);
            else showDocsPopover(b.hash, hit, b);
            break;
          }
        }
      }
    }, { passive: true });

    // Scroll/wheel fire at frame rate; a trailing 140ms throttle keeps the
    // locate pass (line assembly + matching in the page world) off the hot
    // path while underlines still track a scroll closely.
    let locateQueued = false;
    function scheduleDocsMarks() {
      if (locateQueued) return;
      locateQueued = true;
      setTimeout(() => {
        locateQueued = false;
        requestDocsMarks();
      }, 140);
    }

    /* ── instant re-match ──────────────────────────────────────────────
       Bars are repositioned every frame from live annotation-rect geometry,
       so scrolling itself never lags. What DID lag: after Google recycles or
       re-coordinates its annotation nodes (typing, reflow, fast scroll), we
       waited out a 140ms throttle or the 900ms poll before re-matching.
       A MutationObserver on the editor subtree, filtered to exactly the
       attributes Google's annotation layer mutates, re-matches within one
       frame of Google's own update — the earliest any extension can know. */
    let lastLocateAt = 0;
    function fastDocsMarks() {
      // 90ms floor: continuous typing mutates annotations every frame, and a
      // full locate pass per frame would jank the editor. One locate per 90ms
      // reads as instant; bursts fall through to the trailing throttle.
      if (Date.now() - lastLocateAt > 90) requestDocsMarks();
      else scheduleDocsMarks();
    }
    let annoObs = null, annoObsTarget = null, annoRafPending = false;
    function armAnnotationObserver() {
      const target = document.querySelector(".kix-appview-editor");
      if (!target || target === annoObsTarget) return;
      if (annoObs) annoObs.disconnect();
      annoObsTarget = target;
      annoObs = new MutationObserver((records) => {
        // Our own bars live INSIDE the observed subtree now — filter out our
        // writes or every draw would trigger a re-locate loop.
        const oursEl = (n) => n.nodeType === 1 && n.hasAttribute("data-tracely-bar");
        let external = false;
        const removedOurs = [];
        for (const rec of records) {
          if (rec.type === "attributes") {
            if (oursEl(rec.target)) continue; // our geometry-follow writes below
            external = true;
            continue;
          }
          const added = [...rec.addedNodes], removed = [...rec.removedNodes];
          // Insertion-only all-ours records are ALWAYS our own draw — nothing
          // else creates data-tracely-bar elements. (Gating this on
          // selfMutating is a microtask-ordering trap: a clear that touched
          // nothing observable queues its reset BEFORE the first insertion
          // enqueues the observer callback, so the flag is already false.)
          if (removed.length === 0 && added.length > 0 && added.every(oursEl)) continue;
          if (selfMutating && added.every(oursEl) && removed.every(oursEl)) continue; // our clear pass
          for (const n of removed) if (oursEl(n)) removedOurs.push(n);
          external = true;
        }
        if (!external) return;
        /* Hostility check — batch-scoped and precise: a strike only when Docs
           deleted OUR node while the host it was injected into is still
           connected (the annotation rect for an in-tree bar, the kix page for
           a page-anchored bar or its overlay). Benign tile teardown (even one
           removeChild per record, à la Closure) takes the host down too, so it
           never strikes; targeted sanitization of foreign children does. Retry
           first — re-injection is one locate — and latch to the glued layer on
           4 strikes in 10s, with a doubling cooldown instead of forever.

           One latch covers both in-tree strategies deliberately: they differ
           only in WHERE inside Docs' subtree the node goes, and a Docs that
           sanitizes one is not a Docs to keep feeding the other. */
        if (removedOurs.length && Date.now() >= inTreeDisabledUntil) {
          const hostAlive = (el) => {
            if (el.hasAttribute("data-tracely-page-layer")) {
              for (const [page, layer] of pageLayers) if (layer === el) return page.isConnected;
              return false;
            }
            const b = docsBars.find((bar) => bar.el === el);
            return !!(b?.node?.isConnected || b?.page?.isConnected);
          };
          const targeted = removedOurs.some(hostAlive);
          if (targeted) {
            const now = Date.now();
            hostileStrikes = hostileStrikes.filter((t) => now - t < 10_000);
            hostileStrikes.push(now);
            if (hostileStrikes.length >= 4) {
              inTreeDisabledUntil = now + inTreeCooldown;
              inTreeCooldown = Math.min(inTreeCooldown * 2, 900_000);
              hostileStrikes = [];
              console.warn(`[tracely] Docs keeps deleting bars injected into its subtree — glued fallback for ${Math.round((inTreeDisabledUntil - now) / 1000)}s`);
            }
          }
        }
        /* Same-microtask maintenance: observer callbacks run BEFORE the next
           paint, so bars are corrected before a wrong frame can ever hit the
           screen. Recycled binding → hide until re-match; re-coordinated
           geometry/transform on the SAME text → follow it in place. */
        for (const b of docsBars) {
          if (!b.node || !b.inSvg) continue;
          if (b.flow) { // brackets are re-located wholesale by the next pass
            if (!b.el.isConnected || !b.node.isConnected) b.el.style.display = "none";
            continue;
          }
          if (!b.el.isConnected || !b.node.isConnected || b.node.getAttribute("aria-label") !== b.raw) {
            b.el.style.display = "none";
            continue;
          }
          const rx = parseFloat(b.node.getAttribute("x"));
          const ry = parseFloat(b.node.getAttribute("y"));
          const rw = parseFloat(b.node.getAttribute("width"));
          const rh = parseFloat(b.node.getAttribute("height"));
          const tf = b.node.getAttribute("transform") || "";
          if (![rx, ry, rw, rh].every(Number.isFinite)) { b.el.style.display = "none"; continue; }
          if (rx !== b.gx || ry !== b.gy || rw !== b.gw || rh !== b.gh || tf !== b.tf) {
            b.gx = rx; b.gy = ry; b.gw = rw; b.gh = rh; b.tf = tf;
            b.el.setAttribute("x", String(rx + b.f0 * rw));
            b.el.setAttribute("y", String(ry + rh - 2));
            b.el.setAttribute("width", String(Math.max(2, (b.f1 - b.f0) * rw)));
            if (tf) b.el.setAttribute("transform", tf); else b.el.removeAttribute("transform");
            b.size = b.node.getBoundingClientRect().height || b.size;
          }
        }
        if (annoRafPending) return;
        annoRafPending = true;
        // Coalesce a mutation burst into one re-match, aligned to the frame.
        requestAnimationFrame(() => { annoRafPending = false; fastDocsMarks(); });
      });
      // Our own layers (marks, popover) hang off documentElement, OUTSIDE this
      // subtree — the observer can never feed back on our own writes.
      annoObs.observe(target, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ["aria-label", "x", "y", "width", "height", "transform"],
      });
      console.debug("[tracely] annotation observer armed");
    }

    /* Stamp the version. Several "it's still broken" reports have turned out
       to be an older build still loaded — a stale unpacked copy, a tab that
       was never reloaded, or the Web Store copy running alongside a dev one.
       A version in the console settles that from a screenshot. */
    console.log(`[tracely] v${EXT_VERSION} docs overlay armed`);
    const marksTimer = setInterval(requestDocsMarks, 900);
    window.addEventListener("scroll", scheduleDocsMarks, { capture: true, passive: true });
    window.addEventListener("wheel", scheduleDocsMarks, { capture: true, passive: true });
    window.addEventListener("resize", scheduleDocsMarks, { passive: true });

    /* THE GHOST INSTANCE.
       Reloading the extension does not stop the content script already running
       in an open tab. Its chrome.* calls start failing, but NOTHING about
       drawing needs chrome.* — it keeps its cached findings, keeps its 900ms
       timer, and keeps painting marks into the same annotation SVG the NEW
       instance is painting into. Two instances, two sets of marks.

       Underlines hid it: two identical bars stack on the same pixels and look
       like one. The flow CHIP is text, and text drawn twice a few pixels apart
       reads as garbled overlap — which is what "Flow issue" doubling was. The
       two also fight, because each one's clear sweeps `[data-tracely-bar]` and
       so deletes the other's marks, provoking a redraw.

       So an orphaned instance must not merely stop calling chrome.* — it has
       to stand down completely and take its marks with it. */
    function standDown(why) {
      clearInterval(marksTimer);
      if (annoObs) { annoObs.disconnect(); annoObs = null; }
      window.removeEventListener("scroll", scheduleDocsMarks, { capture: true });
      window.removeEventListener("wheel", scheduleDocsMarks, { capture: true });
      window.removeEventListener("resize", scheduleDocsMarks);
      hideDocsPopover();
      clearDocsMarks();
      console.log(`[tracely] v${EXT_VERSION} stood down (${why}) — reload the tab to resume`);
    }
    /* Only meaningful where there WAS an extension context to lose. The
       harness page has no chrome.* at all, so extAlive() is false from the
       first tick — without this gate the overlay would stand itself down
       immediately and the harness would render nothing. */
    const orphanTimer = useRelay ? setInterval(() => {
      if (extAlive()) return;
      clearInterval(orphanTimer);
      standDown("extension reloaded");
    }, 900) : 0;

    async function fetchSources(hash, auto = false) {
      // Returns false when NOTHING was started (another claim's search holds
      // the slot, or the sentence vanished) so callers can restore their UI
      // instead of pretending a search is running.
      if (sourcesMap.get(hash)?.list?.length) return true; // cached — never re-search
      if (sourcesInflight) return false;
      const seg = segments.find((s) => s.hash === hash);
      if (!seg) return false;
      const f = cache.get(hash);
      sourcesInflight = true;
      sourcesMap.set(hash, { loading: true, list: null, copiedUrl: null });
      render();
      try {
        const data = await api("/api/sources", {
          claim: seg.text,
          correction: f?.revision || undefined,
          context: docText.slice(0, 6000),
          model: effModel(settings),
        });
        sourcesMap.set(hash, { loading: false, list: data.sources ?? [], copiedUrl: null });
        persistCaches();
      } catch (err) {
        sourcesMap.delete(hash);
        if (!auto) statusKind = "error";
        statusMsg = err?.message ?? "source search failed";
      } finally {
        sourcesInflight = false;
        render();
        renderPopSources(hash); // popover may be waiting on this claim
      }
      return true;
    }

    // Auto-sources for flagged claims — capped per cycle and per rolling hour.
    async function autoFindSources(findings) {
      if (settings.autoSources !== true) return; // cost: auto web-search is opt-in
      let started = 0;
      for (const f of findings) {
        if (started >= 3) break;
        if (!AUTO_SOURCE_VERDICTS.includes(f.verdict)) continue;
        if (sourcesMap.has(f.id) || dismissed.has(f.id)) continue;
        if (!segments.some((s) => s.hash === f.id)) continue;
        autoSourceTimes = autoSourceTimes.filter((t) => Date.now() - t < 3_600_000);
        if (autoSourceTimes.length >= 15) { statusMsg = "auto-sources paused — hourly cap"; break; }
        autoSourceTimes.push(Date.now());
        started++;
        await fetchSources(f.id, true); // sequential: one paid search at a time
      }
    }

    // "Paste a URL and cite it" — free metadata fetch, then cite in the doc if we can.
    async function citeUrlWidget(hash, rawUrl) {
      if (docBusy) return;
      try {
        const data = await api("/api/cite-url", { url: rawUrl });
        const src = data.source;
        const st = sourcesMap.get(hash) ?? { loading: false, list: [], copiedUrl: null };
        st.loading = false;
        st.list = st.list ?? [];
        if (!st.list.some((s) => s.url === src.url)) st.list.unshift(src);
        sourcesMap.set(hash, st);
        persistCaches(); // pasted-URL sources survive reloads too
        if (canEditDoc()) {
          await docCite(hash, st.list.findIndex((s) => s.url === src.url));
        } else {
          statusKind = "idle";
          statusMsg = "source added — use Copy cite";
        }
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "couldn't cite that URL";
      }
      render();
    }

    function copyText(text, hash, url) {
      navigator.clipboard?.writeText(text).catch(() => {});
      if (hash && url) {
        const st = sourcesMap.get(hash);
        if (st) st.copiedUrl = url;
      }
      render();
    }

    // ── in-doc editing via the local server's Docs bridge ──
    const canEditDoc = () => bridgeReady && !harness;

    async function fetchServerStatus() {
      try {
        const s = await api("/api/status");
        bridgeReady = Boolean(s.docsBridge);
        standaloneMode = Boolean(s.standalone);
      } catch { bridgeReady = false; }
    }

    function docApply(payload) {
      return api("/api/docs/apply", { docId: DOC_ID, ...payload });
    }

    async function docFix(hash) {
      const seg = segments.find((s) => s.hash === hash);
      const f = cache.get(hash);
      if (!seg || !f?.revision || docBusy) return;
      docBusy = true;
      render();
      try {
        await docApply({ action: "replace", find: seg.text, replacement: withMarkers(seg.text, f.revision) });
        docFixed.add(hash);
        cache.delete(hash); // the rewritten sentence gets re-verified on the next read
        persistCaches();
        statusKind = "idle";
        statusMsg = "fixed in doc";
        lastCheckEnd = Date.now() - CHECK_INTERVAL_MS + 3000; // re-read soon (export lags slightly)
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "doc edit failed";
      } finally {
        docBusy = false;
        render();
      }
    }

    async function docCite(hash, i) {
      const seg = segments.find((s) => s.hash === hash);
      const st = sourcesMap.get(hash);
      const src = st?.list?.[Number(i)];
      if (!seg || !src || docBusy) return;
      docBusy = true;
      render();
      try {
        const block = sourcesBlock(docText);
        let num;
        const existing = block?.entries.find((e) => e.url === src.url);
        if (existing) {
          num = existing.num;
        } else {
          num = (block?.entries.length ?? 0) + 1;
          if (!block) await docApply({ action: "appendLine", line: "Sources:" });
          // Styled reference + " — url" tail: the url tail is what sourcesBlock
          // parses for numbering/dedupe, so it must survive every style.
          const styled = formatCitation(src, settings.citationStyle || "apa").doc;
          await docApply({ action: "appendLine", line: `${num}. ${styled} — ${src.url}` });
        }
        if (!seg.text.includes(`[${num}]`)) {
          const punct = seg.text.match(/[.!?]+["')\]]*$/);
          const at = punct ? seg.text.length - punct[0].length : seg.text.length;
          const replacement = seg.text.slice(0, at).replace(/\s+$/, "") + ` [${num}]` + seg.text.slice(at);
          await docApply({ action: "replace", find: seg.text, replacement });
          const newHash = hashText(replacement);
          if (cache.has(hash) && !cache.has(newHash)) cache.set(newHash, cache.get(hash));
          if (sourcesMap.has(hash) && !sourcesMap.has(newHash)) sourcesMap.set(newHash, sourcesMap.get(hash));
        }
        st.citedUrl = src.url;
        persistCaches();
        statusKind = "idle";
        statusMsg = `cited [${num}] in doc`;
        lastCheckEnd = Date.now() - CHECK_INTERVAL_MS + 3000;
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "cite failed";
      } finally {
        docBusy = false;
        render();
      }
    }

    // (the bridge "highlight in doc" feature was removed — real overlay
    //  underlines replaced background tints)

    // ── widget UI ──
    const { shadow, root } = makeWidget();
    tierListeners.push(() => {
      // On downgrade, clamp the STORED choice too — a stale top-tier setting must
      // not sit in localStorage looking active (API calls already clamp, and
      // the server clamps again regardless of what we send).
      if (clampSettingsToPlan(settings)) lsSet(SETTINGS_KEY, JSON.stringify(settings));
      render();
    });

    function render() {
      const issues = currentIssues();
      const countdown = Math.max(0, Math.ceil((CHECK_INTERVAL_MS - (Date.now() - lastCheckEnd)) / 1000));
      const countCls = statusKind === "offline" || statusKind === "error" ? "off" : issues.length > 0 ? "" : "ok";
      const countTxt = statusKind === "offline" ? "off" : inflight ? "…" : issues.length > 0 ? String(issues.length) : "✓";

      let panelHtml = "";
      if (expanded) {
        /* Flow issues live in the PANEL, not only in the document. The
           in-document bracket is off by default (FLOW_IN_DOC) after repeated
           mis-positioning, so this is where the feature actually reads — and
           it needs no position to be useful. */
        const flowCards = activeFlowIssues().map((fi) => {
          const h = flowHashOf(fi);
          const act = canEditDoc() ? "Add transition" : "Copy transition";
          return `
            <div class="card c-flow">
              <div class="top"><span class="badge badge-flow">Flow issue</span><button class="x" data-flow-x="${esc(h)}">✕</button></div>
              <div class="quote">${esc(fi.passage.slice(0, 160))}</div>
              <div class="fix">
                <div class="fix-label">Why it jumps</div>
                <div class="fix-text">${esc(fi.explanation)}</div>
                ${fi.transition ? `<div class="fix-label" style="margin-top:8px">Suggested bridge</div><div class="fix-text">${esc(fi.transition)}</div>` : ""}
                ${fi.transition ? `<div class="row"><button class="act primary" data-flow-go="${esc(h)}">${act}</button></div>` : ""}
              </div>
            </div>`;
        }).join("");

        const cards = issues.map(({ seg, f }) => {
          const kind = f.verdict === "false" ? "false" : f.verdict === "questionable" ? "quest" : f.verdict === "needs_citation" ? "cite" : "inco";
          const st = sourcesMap.get(seg.hash);
          let sourcesHtml = "";
          if (st?.loading) {
            sourcesHtml = `<div class="sources"><div class="loading">Searching the web for sources…</div></div>`;
          } else if (st?.list?.length) {
            sourcesHtml = `<div class="sources"><div class="sources-title">Sources — pick one to cite</div>` +
              st.list.map((src, i) => `
                <div class="src">
                  <span class="stance st-${esc(src.stance)}">${esc(src.stance)}</span>
                  <div class="src-body">
                    <a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a>
                    <div class="src-meta">${esc(src.publisher)}</div>
                    ${src.snippet ? `<div class="src-snip">${esc(src.snippet)}</div>` : ""}
                    <div class="src-actions">
                      ${canEditDoc() ? `<button class="act primary" data-doc-cite="${seg.hash}" data-i="${i}"${docBusy ? " disabled" : ""}>${st.citedUrl === src.url ? "Cited ✓" : "Cite in doc"}</button>` : ""}
                      <button class="act" data-copy-src="${seg.hash}" data-i="${i}">${st.copiedUrl === src.url ? "Copied ✓" : "Copy cite"}</button>
                    </div>
                  </div>
                </div>`).join("") + `</div>`;
          }
          return `
          <div class="card c-${kind}">
            <div class="top">
              <span class="badge badge-${kind}">${VERDICT_LABEL[f.verdict]}</span>
              <button class="x" data-dismiss="${seg.hash}" title="Dismiss">✕</button>
            </div>
            <div class="quote">“${esc(seg.text.length > 140 ? seg.text.slice(0, 139) + "…" : seg.text)}”</div>
            ${f.explanation ? `<div class="expl">${esc(f.explanation)}</div>` : ""}
            ${f.revision ? `
            <div class="fix">
              <div class="fix-label">Suggested revision</div>
              <div class="fix-text">${esc(f.revision)}</div>
              <div class="row">
                ${canEditDoc() ? `<button class="act primary" data-doc-fix="${seg.hash}"${docBusy ? " disabled" : ""}>${docFixed.has(seg.hash) ? "Fixed ✓" : "Fix in doc"}</button>` : ""}
                <button class="act${canEditDoc() ? "" : " primary"}" data-copy-fix="${seg.hash}">${copiedFixHash === seg.hash ? "Copied ✓" : "Copy fix"}</button>
                <button class="act" data-sources="${seg.hash}">Find sources</button>
              </div>
            </div>` : `<div class="row"><button class="act" data-sources="${seg.hash}">Find sources</button></div>`}
            ${sourcesHtml}
            ${standaloneMode ? "" : `<div class="cite-url"><input type="url" placeholder="Or paste a URL you found…" data-url-input="${seg.hash}" /><button class="act" data-url-add="${seg.hash}"${docBusy ? " disabled" : ""}>Cite</button></div>`}
          </div>`;
        }).join("");

        panelHtml = `
        <div class="panel">
          <div class="head" id="dragHead">
            <span class="plane">${PLANE_SVG}</span>
            <span class="name">Tracely</span>
            <span class="status ${statusKind === "error" || statusKind === "offline" ? "error" : ""}">${esc(statusMsg)}</span>
          </div>
          ${speedbarHtml(speedPos(settings.model))}
          <div class="list">
            ${flowCards}${cards || (flowCards ? "" : `<div class="empty">${statusKind === "offline" ? "Start the Tracely server, then reopen this doc." : "Nothing flagged. Keep writing — checking every 10s."}</div>`)}
          </div>
          <div class="foot">
            <span class="foot-left">
              <span id="countdownTxt">${inflight ? "checking…" : `next check in ${countdown}s`}</span>
              <label class="autosrc" title="Automatically look up sources for flagged claims (capped)"><input type="checkbox" id="autoSrcTgl"${settings.autoSources === true ? " checked" : ""} /><span>Auto-src</span></label>
            </span>
            <button class="act" id="checkNow">Check now</button>
          </div>
        </div>`;
      }

      const prevScroll = shadow.querySelector(".list")?.scrollTop ?? 0;
      root.innerHTML = `
        ${panelHtml}
        <div class="pill" id="pill">
          <span class="plane">${PLANE_SVG}</span>
          Tracely
          <span class="count ${countCls}">${countTxt}</span>
        </div>
      `;
      const listEl = shadow.querySelector(".list");
      if (listEl) listEl.scrollTop = prevScroll;

      shadow.getElementById("pill").addEventListener("click", () => { expanded = !expanded; render(); });
      if (expanded) {
        wireSpeedbar(shadow, settings, saveSettings);
        shadow.getElementById("checkNow").addEventListener("click", () => { lastCheckEnd = 0; cycle(); });
        for (const btn of shadow.querySelectorAll("[data-dismiss]")) {
          btn.addEventListener("click", () => {
            dismissed.add(btn.dataset.dismiss);
            lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-copy-fix]")) {
          btn.addEventListener("click", () => {
            const f = cache.get(btn.dataset.copyFix);
            if (f?.revision) { copiedFixHash = btn.dataset.copyFix; copyText(f.revision); }
          });
        }
        for (const btn of shadow.querySelectorAll("[data-sources]")) {
          btn.addEventListener("click", () => fetchSources(btn.dataset.sources));
        }
        for (const btn of shadow.querySelectorAll("[data-flow-go]")) {
          btn.addEventListener("click", async () => {
            const fi = activeFlowIssues().find((x) => flowHashOf(x) === btn.dataset.flowGo);
            if (!fi) return;
            if (!canEditDoc()) {
              try { await navigator.clipboard.writeText(fi.transition); } catch { /* denied */ }
              btn.textContent = "Copied \u2713";
              return;
            }
            btn.textContent = "Adding\u2026";
            btn.disabled = true;
            await addTransition(btn.dataset.flowGo, fi);
          });
        }
        for (const btn of shadow.querySelectorAll("[data-flow-x]")) {
          btn.addEventListener("click", () => {
            flowDismissed.add(btn.dataset.flowX);
            persistFlow();
            requestDocsMarks();
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-copy-src]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.copySrc);
            const src = st?.list?.[Number(btn.dataset.i)];
            if (src) copyText(formatCitation(src, settings.citationStyle || "apa").ref, btn.dataset.copySrc, src.url);
          });
        }
        for (const btn of shadow.querySelectorAll("[data-doc-fix]")) {
          btn.addEventListener("click", () => docFix(btn.dataset.docFix));
        }
        for (const btn of shadow.querySelectorAll("[data-doc-cite]")) {
          btn.addEventListener("click", () => docCite(btn.dataset.docCite, btn.dataset.i));
        }
        shadow.getElementById("autoSrcTgl")?.addEventListener("change", (e) => {
          settings.autoSources = e.target.checked;
          saveSettings();
        });
        for (const btn of shadow.querySelectorAll("[data-url-add]")) {
          btn.addEventListener("click", () => {
            const input = shadow.querySelector(`[data-url-input="${btn.dataset.urlAdd}"]`);
            if (input?.value.trim()) citeUrlWidget(btn.dataset.urlAdd, input.value.trim());
          });
        }
        for (const input of shadow.querySelectorAll("[data-url-input]")) {
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && input.value.trim()) citeUrlWidget(input.dataset.urlInput, input.value.trim());
          });
        }
      }
    }

    function saveSettings() {
      lsSet(SETTINGS_KEY, JSON.stringify(settings));
    }

    // ── loop ──
    setInterval(() => {
      if (!inflight && !document.hidden && Date.now() - lastCheckEnd >= CHECK_INTERVAL_MS) {
        cycle();
      } else if (expanded && !inflight) {
        // Targeted countdown update — a full render() every second would reset
        // the list scroll and close open dropdowns.
        const el = shadow.getElementById("countdownTxt");
        if (el) el.textContent = `next check in ${Math.max(0, Math.ceil((CHECK_INTERVAL_MS - (Date.now() - lastCheckEnd)) / 1000))}s`;
      }
    }, 1000);
    fetchServerStatus();
    setInterval(fetchServerStatus, 30_000);
    cycle();
  }

  /* ════════════════════════════════════════════════════════════════════════
     FIELD MODE — any other site: ordinary editable fields, in-place fixes.
     Money rule: automatic 10s checking runs ONLY when this site is enabled
     ("tracely.site.enabled"). Otherwise nothing is sent until the user clicks.
     ════════════════════════════════════════════════════════════════════════ */
  function fieldMode() {
    const SITE_KEY = "tracely.site.enabled";
    const SETTINGS_KEY = "tracely.widget.settings";
    const DISMISS_KEY = "tracely.widget.dismissed.field"; // localStorage is origin-scoped → per-site

    // Per-site enable lives in chrome.storage.local ("enabledSites": [origin])
    // so the options page can list and manage it. The old per-site localStorage
    // flag is kept in sync (and migrated in) for back-compat and for plain
    // test pages without extension APIs.
    const extStorage = useRelay && typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
    let siteOn = lsGet(SITE_KEY) === "1"; // seed from the legacy flag, then sync below
    const siteEnabled = () => siteOn;
    if (extStorage) {
      storageGet({ enabledSites: [] }, (st) => {
        const list = Array.isArray(st.enabledSites) ? st.enabledSites : [];
        if (siteOn && !list.includes(location.origin)) {
          storageSet({ enabledSites: [...list, location.origin] }); // migrate legacy opt-in
        } else if (siteOn !== list.includes(location.origin)) {
          siteOn = list.includes(location.origin);
          lsSet(SITE_KEY, siteOn ? "1" : "0");
          if (widget) render();
        }
      });
      storageOnChanged((changes, area) => {
        if (area !== "local" || !changes.enabledSites) return;
        const on = (changes.enabledSites.newValue ?? []).includes(location.origin);
        if (on !== siteOn) {
          siteOn = on;
          lsSet(SITE_KEY, on ? "1" : "0");
          if (widget) render();
        }
      });
    }

    // ── engine (server | standalone | offline) — learned from the background ──
    let engine = { mode: "server", hasKey: true };
    const isStandalone = () => engine.mode === "standalone";
    async function refreshEngine() {
      if (!useRelay) return;
      try {
        const s = await sendMsg({ type: "tracely-getState" });
        if (s?.ok) {
          const changed = s.mode !== engine.mode;
          engine = s;
          if (changed && widget) render();
        }
      } catch { /* extension reloaded mid-flight */ }
    }
    refreshEngine();
    setInterval(refreshEngine, 30_000);

    // ── state (mirrors docs mode) ──
    const cache = new Map();
    const dismissed = new Set(jsonParse(lsGet(DISMISS_KEY) ?? "[]", []));
    const sourcesMap = new Map();
    let settings = { model: SPEED_STOPS[0].model, effort: "low", citationStyle: "apa", ...jsonParse(lsGet(SETTINGS_KEY) ?? "{}", {}) };
    let segments = [];
    let inflight = false;
    let sourcesInflight = false;
    let lastCheckEnd = Date.now();
    let statusMsg = siteEnabled() ? "waiting for a text field…" : "auto-check off — click to check";
    let statusKind = "idle"; // idle | checking | error | offline
    let expanded = false;
    let fieldText = "";
    let copiedFixHash = null;
    const fieldFixed = new Set();
    let autoSourceTimes = [];
    let tracked = null;       // the editable element we watch
    let checkedOnce = false;  // pill leaves its quiet state after the first check

    let widget = null; // created lazily — pages without qualifying fields get zero UI
    function ensureWidget() {
      if (!widget) widget = makeWidget();
      return widget;
    }
    tierListeners.push(() => {
      // Same downgrade clamp as docs mode; only repaint if the panel exists.
      if (clampSettingsToPlan(settings)) lsSet(SETTINGS_KEY, JSON.stringify(settings));
      if (widget) render();
    });

    /* ── editable tracking ── */

    const SECURE_RE = /passw|secret|token|otp|2fa|cvc|cvv|card[-_ ]?num|ssn|social[-_ ]?security|\bpin\b/i;
    function looksSecure(el) {
      const hints = [
        el.getAttribute?.("name"), el.id, el.getAttribute?.("aria-label"),
        el.getAttribute?.("autocomplete"), el.getAttribute?.("placeholder"),
      ].filter(Boolean).join(" ");
      return SECURE_RE.test(hints);
    }

    // Resolve a focus target to the editable we should track, or null.
    // <input> never qualifies (short, and where the secure stuff lives).
    function resolveEditable(target) {
      if (!(target instanceof Element)) return null;
      if (widget && (target === widget.host || widget.host.contains(target))) return null; // our own shadow DOM
      if (target instanceof HTMLInputElement) return null;
      if (target instanceof HTMLTextAreaElement) return looksSecure(target) ? null : target;
      if (target.isContentEditable) {
        let top = target;
        while (top.parentElement && top.parentElement.isContentEditable) top = top.parentElement;
        const attr = top.getAttribute("contenteditable");
        if (attr !== null && attr !== "" && attr.toLowerCase() !== "true") return null; // plaintext-only etc.
        return looksSecure(top) ? null : top;
      }
      return null;
    }

    /* ── canonical text index for contenteditable (ports public/app/analyze.js) ── */

    const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE"]);

    function buildTextIndex(rootEl) {
      let text = "";
      const nodeSegs = [];
      (function walk(node) {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const data = child.data.replace(/ /g, " "); // NBSP → space, 1:1
            nodeSegs.push({ node: child, start: text.length, end: text.length + data.length });
            text += data;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.nodeName === "BR") { text += "\n"; continue; }
            const isBlock = BLOCK_TAGS.has(child.nodeName);
            if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
            walk(child);
            if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
          }
        }
      })(rootEl);
      return { text, segments: nodeSegs };
    }

    function rangeForOffsets(index, start, end) {
      const segs = index.segments;
      let a = null;
      let b = null;
      for (const seg of segs) {
        if (a == null && start >= seg.start && start < seg.end) a = { node: seg.node, off: start - seg.start };
        if (end > seg.start && end <= seg.end) b = { node: seg.node, off: end - seg.start };
      }
      if (a == null) {
        for (const seg of segs) {
          if (start === seg.end) { a = { node: seg.node, off: seg.end - seg.start }; break; }
        }
      }
      if (a == null || b == null) return null;
      const range = document.createRange();
      try {
        range.setStart(a.node, a.off);
        range.setEnd(b.node, b.off);
      } catch { return null; }
      return range;
    }

    function readField(el) {
      if (el instanceof HTMLTextAreaElement) return el.value;
      return buildTextIndex(el).text;
    }

    function fieldEligible() {
      if (!tracked || !tracked.isConnected) return false;
      const len = (tracked instanceof HTMLTextAreaElement ? tracked.value : tracked.textContent ?? "").trim().length;
      return len >= MIN_FIELD_CHARS;
    }

    /* ── Grammarly-style overlay underlines (ports the Ethos technique) ──
       A fixed, pointer-events-none layer holds one absolutely-positioned bar
       per line-box of each flagged sentence. Textareas are measured through
       an offscreen mirror div; contenteditable through offset→Range rects on
       the existing canonical text index. Repositioning is rAF-throttled off
       input/scroll/resize; clicks are hit-tested manually since the layer
       never intercepts pointer events. */

    let overlayEl = null;
    let mirror = null;
    const markRects = new Map(); // hash → visible rects (issue marks only — used for hit-testing)
    let marksRaf = null;

    function ensureOverlay() {
      if (overlayEl && overlayEl.isConnected) return overlayEl;
      overlayEl = document.createElement("div");
      overlayEl.id = "tracely-marks";
      Object.assign(overlayEl.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483646" });
      document.documentElement.appendChild(overlayEl);
      return overlayEl;
    }

    // Offscreen mirror-div measurement for textarea sentence rects.
    function taRects(el, start, end) {
      const cs = getComputedStyle(el);
      if (!mirror) {
        mirror = document.createElement("div");
        document.documentElement.appendChild(mirror);
      }
      Object.assign(mirror.style, {
        position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
        whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: cs.wordBreak,
        width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + "px",
        font: cs.font, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize,
      });
      const text = el.value;
      mirror.textContent = "";
      mirror.append(document.createTextNode(text.slice(0, start)));
      const span = document.createElement("span");
      span.textContent = text.slice(start, end);
      mirror.append(span, document.createTextNode(text.slice(end)));
      const mBox = mirror.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop);
      const bordL = parseFloat(cs.borderLeftWidth), bordT = parseFloat(cs.borderTopWidth);
      const out = [];
      for (const r of span.getClientRects()) {
        const x = box.left + bordL + padL + (r.left - mBox.left) - el.scrollLeft;
        const y = box.top + bordT + padT + (r.top - mBox.top) - el.scrollTop;
        if (y + r.height < box.top || y > box.bottom) continue; // clip to the visible box
        out.push({ left: x, top: y, width: r.width, height: r.height });
      }
      return out;
    }

    // Offset→Range rects for contenteditable, via the canonical text index.
    function ceRects(el, index, start, end) {
      const range = rangeForOffsets(index, start, end);
      if (!range) return [];
      const box = el.getBoundingClientRect();
      const out = [];
      for (const r of range.getClientRects()) {
        if (r.width === 0) continue;
        if (r.bottom < box.top || r.top > box.bottom) continue; // clip to the visible box
        out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      return out;
    }

    function scheduleMarks() {
      if (marksRaf) return;
      marksRaf = requestAnimationFrame(() => { marksRaf = null; drawMarks(); });
    }

    function drawMarks() {
      if (!overlayEl && !(tracked && tracked.isConnected)) return; // nothing drawn, nothing to clear
      const layer = ensureOverlay();
      layer.textContent = "";
      markRects.clear();
      if (!tracked || !tracked.isConnected) return;
      const isTa = tracked instanceof HTMLTextAreaElement;
      let index = null;
      let liveText;
      if (isTa) {
        liveText = tracked.value;
      } else {
        index = buildTextIndex(tracked);
        liveText = index.text;
      }
      if (liveText.trim().length < MIN_FIELD_CHARS) return;
      const seen = new Set();
      for (const seg of segmentText(liveText)) {
        if (!seg.checkable || seen.has(seg.hash) || dismissed.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        let color = null;
        let pending = false;
        if (f && ISSUE_VERDICTS.includes(f.verdict)) {
          color = MARK_COLORS[f.verdict];
        } else if (!f && inflight) {
          color = MARK_PENDING; // awaiting a verdict this cycle
          pending = true;
        } else {
          continue;
        }
        const rects = isTa ? taRects(tracked, seg.start, seg.end) : ceRects(tracked, index, seg.start, seg.end);
        if (rects.length === 0) continue;
        if (!pending) markRects.set(seg.hash, rects);
        for (const r of rects) {
          const bar = document.createElement("div");
          Object.assign(bar.style, {
            position: "fixed", left: r.left + "px", top: r.top + "px",
            width: r.width + "px", height: r.height + "px",
            background: "transparent", // Grammarly-style: a clean underline, no highlight wash
            pointerEvents: "none",
          });
          if (pending) {
            bar.style.borderBottom = `2px dotted ${color}`;
            bar.style.opacity = "0.7";
          } else {
            // solid underline along the bottom edge, one colour per verdict
            bar.style.borderBottom = `3px solid ${color}`;
            bar.style.borderRadius = "2px";
          }
          layer.appendChild(bar);
        }
      }
    }

    function hitMark(x, y) {
      for (const [h, rects] of markRects) {
        for (const r of rects) {
          if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height + 2) return h;
        }
      }
      return null;
    }

    let flashTimer = null;
    function flashCard(hash) {
      if (!widget) return;
      const card = widget.shadow.querySelector(`[data-card="${hash}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "nearest" });
      card.classList.add("flash");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => card.classList.remove("flash"), 1300);
    }

    // Clicking an underline opens the panel and flashes that verdict's card.
    document.addEventListener("mousedown", (e) => {
      if (widget && e.composedPath().includes(widget.host)) return;
      const h = hitMark(e.clientX, e.clientY);
      if (!h) return;
      expanded = true;
      ensureWidget();
      render();
      flashCard(h);
    }, true);

    document.addEventListener("input", (e) => {
      if (tracked && (e.target === tracked || (tracked.contains && tracked.contains(e.target)))) scheduleMarks();
    }, true);
    document.addEventListener("scroll", () => scheduleMarks(), true);
    window.addEventListener("resize", () => scheduleMarks());

    /* ── check pipeline (same guards as docs mode) ── */

    function uncheckedSegments() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        if (cache.has(seg.hash)) continue;
        out.push(seg);
      }
      return out;
    }

    function currentIssues() {
      const out = [];
      const seen = new Set();
      for (const seg of segments) {
        if (!seg.checkable || seen.has(seg.hash)) continue;
        seen.add(seg.hash);
        const f = cache.get(seg.hash);
        if (!f || dismissed.has(seg.hash) || !ISSUE_VERDICTS.includes(f.verdict)) continue;
        out.push({ seg, f });
      }
      return out;
    }

    async function cycle() {
      if (inflight || document.hidden) return;
      if (!tracked || !tracked.isConnected) {
        statusKind = "idle";
        statusMsg = "click into a text field first";
        render();
        return;
      }
      inflight = true;
      try {
        fieldText = readField(tracked);
        if (fieldText.trim().length < MIN_FIELD_CHARS) {
          statusKind = "idle";
          statusMsg = `field under ${MIN_FIELD_CHARS} characters — keep writing`;
          segments = [];
          return;
        }
        segments = segmentText(fieldText);
        const todo = uncheckedSegments().slice(0, MAX_SENTENCES_PER_CHECK);
        if (todo.length > 0) {
          statusKind = "checking";
          statusMsg = `checking ${todo.length}…`;
          render();
          const data = await api("/api/check", {
            text: fieldText.slice(0, MAX_INPUT_CHARS),
            sentences: todo.map((s) => ({ id: s.hash, text: s.text })),
            model: effModel(settings),
            effort: effEffort(settings),
          });
          checkedOnce = true;
          for (const f of data.findings ?? []) {
            cache.set(f.id, { verdict: f.verdict, explanation: f.explanation, revision: f.revision, confidence: f.confidence });
          }
          autoFindSources(data.findings ?? []); // fire-and-forget, capped
        }
        statusKind = "idle";
        const n = currentIssues().length;
        statusMsg = n > 0 ? `${n} issue${n === 1 ? "" : "s"} found` : "all clear";
      } catch (err) {
        if (err?.kind === "no_key") {
          statusKind = "error";
          statusMsg = "Add your OpenAI API key in Tracely's settings";
        } else if (err?.kind === "no_engine") {
          statusKind = "offline";
          statusMsg = err.message;
        } else if (offlineError(err)) {
          statusKind = "offline";
          statusMsg = "Tracely offline — start the server or add an API key in options";
        } else {
          statusKind = "error";
          statusMsg = err?.message ?? "check failed";
        }
      } finally {
        inflight = false;
        lastCheckEnd = Date.now();
        render();
      }
    }

    async function fetchSources(hash, auto = false) {
      if (sourcesInflight) return;
      const seg = segments.find((s) => s.hash === hash);
      if (!seg) return;
      const f = cache.get(hash);
      sourcesInflight = true;
      sourcesMap.set(hash, { loading: true, list: null, copiedUrl: null });
      render();
      try {
        const data = await api("/api/sources", {
          claim: seg.text,
          correction: f?.revision || undefined,
          context: fieldText.slice(0, 6000),
          model: effModel(settings),
        });
        sourcesMap.set(hash, { loading: false, list: data.sources ?? [], copiedUrl: null });
      } catch (err) {
        sourcesMap.delete(hash);
        if (!auto) statusKind = "error";
        statusMsg = err?.message ?? "source search failed";
      } finally {
        sourcesInflight = false;
        render();
      }
    }

    // Auto-sources — same toggle and rolling-hour guard as docs mode. Only
    // reachable after a check, which on a non-enabled site takes a click.
    async function autoFindSources(findings) {
      if (settings.autoSources !== true) return; // cost: auto web-search is opt-in
      let started = 0;
      for (const f of findings) {
        if (started >= 3) break;
        if (!AUTO_SOURCE_VERDICTS.includes(f.verdict)) continue;
        if (sourcesMap.has(f.id) || dismissed.has(f.id)) continue;
        if (!segments.some((s) => s.hash === f.id)) continue;
        autoSourceTimes = autoSourceTimes.filter((t) => Date.now() - t < 3_600_000);
        if (autoSourceTimes.length >= 15) { statusMsg = "auto-sources paused — hourly cap"; break; }
        autoSourceTimes.push(Date.now()); // stamp BEFORE the call
        started++;
        await fetchSources(f.id, true); // sequential: one paid search at a time
      }
    }

    async function citeUrlWidget(hash, rawUrl) {
      try {
        const data = await api("/api/cite-url", { url: rawUrl });
        const src = data.source;
        const st = sourcesMap.get(hash) ?? { loading: false, list: [], copiedUrl: null };
        st.loading = false;
        st.list = st.list ?? [];
        if (!st.list.some((s) => s.url === src.url)) st.list.unshift(src);
        sourcesMap.set(hash, st);
        statusKind = "idle";
        statusMsg = "source added — use Copy cite";
      } catch (e) {
        statusKind = "error";
        statusMsg = e?.message ?? "couldn't cite that URL";
      }
      render();
    }

    function copyText(text, hash, url) {
      navigator.clipboard?.writeText(text).catch(() => {});
      if (hash && url) {
        const st = sourcesMap.get(hash);
        if (st) st.copiedUrl = url;
      }
      render();
    }

    /* ── in-place fix — the point of field mode ── */

    function nativeValueSetter() {
      return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ?? null;
    }

    function fixInField(hash) {
      const f = cache.get(hash);
      if (!f?.revision) return;
      const known = segments.find((s) => s.hash === hash);

      // Fallback when the live range can't be located (framework re-rendered,
      // field gone, execCommand refused): copy instead, and say so.
      const fallbackCopy = () => {
        copiedFixHash = hash;
        navigator.clipboard?.writeText(known ? withMarkers(known.text, f.revision) : f.revision).catch(() => {});
        statusKind = "idle";
        statusMsg = "couldn't edit in place — copied instead";
      };

      const el = tracked;
      if (!el || !el.isConnected) { fallbackCopy(); render(); return; }

      try {
        if (el instanceof HTMLTextAreaElement) {
          // Recompute the sentence's range against the CURRENT value.
          const seg = segmentText(el.value).find((s) => s.hash === hash);
          if (!seg) { fallbackCopy(); render(); return; }
          const replacement = withMarkers(seg.text, f.revision);
          el.focus();
          el.setRangeText(replacement, seg.start, seg.end, "end");
          // Controlled inputs (React et al.): re-assert through the native
          // setter so the framework's value tracker sees the change, then
          // dispatch input so it re-renders from the new value.
          nativeValueSetter()?.call(el, el.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          // contenteditable: map sentence offsets onto text-node ranges, then
          // insertText over the selection so the page's own undo stack works.
          const index = buildTextIndex(el);
          const seg = segmentText(index.text).find((s) => s.hash === hash);
          const range = seg ? rangeForOffsets(index, seg.start, seg.end) : null;
          if (!range) { fallbackCopy(); render(); return; }
          const replacement = withMarkers(seg.text, f.revision);
          el.focus();
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          let ok = false;
          try { ok = document.execCommand("insertText", false, replacement); } catch { ok = false; }
          if (!ok) { sel.removeAllRanges(); fallbackCopy(); render(); return; }
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        fieldFixed.add(hash);
        cache.delete(hash); // the rewritten sentence gets re-verified on the next read
        statusKind = "idle";
        statusMsg = "fixed in field";
        lastCheckEnd = Date.now() - CHECK_INTERVAL_MS + 3000; // re-read soon
      } catch {
        fallbackCopy();
      }
      render();
    }

    /* ── per-site opt-in ── */

    function setSiteEnabled(on) {
      siteOn = on;
      lsSet(SITE_KEY, on ? "1" : "0");
      if (extStorage) {
        storageGet({ enabledSites: [] }, (st) => {
          const list = (Array.isArray(st.enabledSites) ? st.enabledSites : []).filter((o) => o !== location.origin);
          if (on) list.push(location.origin);
          storageSet({ enabledSites: list });
        });
      }
      if (on) {
        statusMsg = "auto-check on for this site";
        lastCheckEnd = 0;
        cycle(); // the toggle click is the prompt
      } else {
        statusKind = "idle";
        statusMsg = "auto-check off — click to check";
      }
      render();
    }

    /* ── render ── */

    function render() {
      scheduleMarks(); // keep in-page underlines in step with every state change
      if (!widget) return;
      const { shadow, root } = widget;
      const enabled = siteEnabled();
      const show = Boolean(tracked && (expanded || fieldEligible() || segments.length > 0));
      root.style.display = show ? "" : "none";

      const issues = currentIssues();
      const quiet = !enabled && !checkedOnce && !inflight && statusKind === "idle";
      const countdown = Math.max(0, Math.ceil((CHECK_INTERVAL_MS - (Date.now() - lastCheckEnd)) / 1000));
      const countCls = statusKind === "offline" || statusKind === "error" ? "off" : issues.length > 0 ? "" : "ok";
      const countTxt = statusKind === "offline" ? "off" : inflight ? "…" : issues.length > 0 ? String(issues.length) : "✓";

      let panelHtml = "";
      if (expanded) {
        const cards = issues.map(({ seg, f }) => {
          const kind = f.verdict === "false" ? "false" : f.verdict === "questionable" ? "quest" : f.verdict === "needs_citation" ? "cite" : "inco";
          const st = sourcesMap.get(seg.hash);
          let sourcesHtml = "";
          if (st?.loading) {
            sourcesHtml = `<div class="sources"><div class="loading">Searching the web for sources…</div></div>`;
          } else if (st?.list?.length) {
            sourcesHtml = `<div class="sources"><div class="sources-title">Sources — copy one to cite</div>` +
              st.list.map((src, i) => `
                <div class="src">
                  <span class="stance st-${esc(src.stance)}">${esc(src.stance)}</span>
                  <div class="src-body">
                    <a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a>
                    <div class="src-meta">${esc(src.publisher)}</div>
                    ${src.snippet ? `<div class="src-snip">${esc(src.snippet)}</div>` : ""}
                    <div class="src-actions">
                      <button class="act" data-copy-src="${seg.hash}" data-i="${i}">${st.copiedUrl === src.url ? "Copied ✓" : "Copy cite"}</button>
                    </div>
                  </div>
                </div>`).join("") + `</div>`;
          }
          return `
          <div class="card c-${kind}" data-card="${seg.hash}">
            <div class="top">
              <span class="badge badge-${kind}">${VERDICT_LABEL[f.verdict]}</span>
              <button class="x" data-dismiss="${seg.hash}" title="Dismiss">✕</button>
            </div>
            <div class="quote">“${esc(seg.text.length > 140 ? seg.text.slice(0, 139) + "…" : seg.text)}”</div>
            ${f.explanation ? `<div class="expl">${esc(f.explanation)}</div>` : ""}
            ${f.revision ? `
            <div class="fix">
              <div class="fix-label">Suggested revision</div>
              <div class="fix-text">${esc(f.revision)}</div>
              <div class="row">
                <button class="act primary" data-field-fix="${seg.hash}">${fieldFixed.has(seg.hash) ? "Fixed ✓" : "Fix in field"}</button>
                <button class="act" data-copy-fix="${seg.hash}">${copiedFixHash === seg.hash ? "Copied ✓" : "Copy fix"}</button>
                <button class="act" data-sources="${seg.hash}">Find sources</button>
              </div>
            </div>` : `<div class="row"><button class="act" data-sources="${seg.hash}">Find sources</button></div>`}
            ${sourcesHtml}
            ${isStandalone() ? "" : `<div class="cite-url"><input type="url" placeholder="Or paste a URL you found…" data-url-input="${seg.hash}" /><button class="act" data-url-add="${seg.hash}">Cite</button></div>`}
          </div>`;
        }).join("");

        const emptyMsg = statusKind === "offline"
          ? "Start the Tracely server — or add an API key in Tracely options — then try again."
          : enabled
            ? "Nothing flagged. Checking every 10s while this field is focused."
            : "Nothing sent yet. “Check once” reviews this field — or turn on auto-check for this site.";

        panelHtml = `
        <div class="panel">
          <div class="head" id="dragHead">
            <span class="plane">${PLANE_SVG}</span>
            <span class="name">Tracely</span>
            <label class="autosrc" title="Run automatic checks on this site every 10s. Off: nothing is sent until you click."><input type="checkbox" id="siteTgl"${enabled ? " checked" : ""} /><span>Auto-check on this site</span></label>
            <span class="status ${statusKind === "error" || statusKind === "offline" ? "error" : ""}">${esc(statusMsg)}</span>
          </div>
          ${speedbarHtml(speedPos(settings.model))}
          <div class="list">
            ${cards || `<div class="empty">${emptyMsg}</div>`}
          </div>
          <div class="foot">
            <span class="foot-left">
              <span id="countdownTxt">${inflight ? "checking…" : enabled ? `next check in ${countdown}s` : "auto-check off"}</span>
              <label class="autosrc" title="Automatically look up sources for flagged claims (capped)"><input type="checkbox" id="autoSrcTgl"${settings.autoSources === true ? " checked" : ""} /><span>Auto-src</span></label>
            </span>
            <button class="act" id="checkNow">${enabled ? "Check now" : "Check once"}</button>
          </div>
        </div>`;
      }

      const prevScroll = shadow.querySelector(".list")?.scrollTop ?? 0;
      root.innerHTML = `
        ${panelHtml}
        <div class="pill${quiet ? " quiet" : ""}" id="pill">
          <span class="plane">${PLANE_SVG}</span>
          ${quiet ? "Check this field" : "Tracely"}
          ${quiet ? "" : `<span class="count ${countCls}">${countTxt}</span>`}
        </div>
      `;
      const listEl = shadow.querySelector(".list");
      if (listEl) listEl.scrollTop = prevScroll;

      shadow.getElementById("pill").addEventListener("click", () => { expanded = !expanded; render(); });
      if (expanded) {
        shadow.getElementById("siteTgl").addEventListener("change", (e) => setSiteEnabled(e.target.checked));
        wireSpeedbar(shadow, settings, saveSettings);
        shadow.getElementById("checkNow").addEventListener("click", () => { lastCheckEnd = 0; cycle(); });
        for (const btn of shadow.querySelectorAll("[data-dismiss]")) {
          btn.addEventListener("click", () => {
            dismissed.add(btn.dataset.dismiss);
            lsSet(DISMISS_KEY, JSON.stringify([...dismissed]));
            render();
          });
        }
        for (const btn of shadow.querySelectorAll("[data-field-fix]")) {
          btn.addEventListener("click", () => fixInField(btn.dataset.fieldFix));
        }
        for (const btn of shadow.querySelectorAll("[data-copy-fix]")) {
          btn.addEventListener("click", () => {
            const f = cache.get(btn.dataset.copyFix);
            if (f?.revision) { copiedFixHash = btn.dataset.copyFix; copyText(f.revision); }
          });
        }
        for (const btn of shadow.querySelectorAll("[data-sources]")) {
          btn.addEventListener("click", () => fetchSources(btn.dataset.sources));
        }
        for (const btn of shadow.querySelectorAll("[data-copy-src]")) {
          btn.addEventListener("click", () => {
            const st = sourcesMap.get(btn.dataset.copySrc);
            const src = st?.list?.[Number(btn.dataset.i)];
            if (src) copyText(formatCitation(src, settings.citationStyle || "apa").ref, btn.dataset.copySrc, src.url);
          });
        }
        shadow.getElementById("autoSrcTgl")?.addEventListener("change", (e) => {
          settings.autoSources = e.target.checked;
          saveSettings();
        });
        for (const btn of shadow.querySelectorAll("[data-url-add]")) {
          btn.addEventListener("click", () => {
            const input = shadow.querySelector(`[data-url-input="${btn.dataset.urlAdd}"]`);
            if (input?.value.trim()) citeUrlWidget(btn.dataset.urlAdd, input.value.trim());
          });
        }
        for (const input of shadow.querySelectorAll("[data-url-input]")) {
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && input.value.trim()) citeUrlWidget(input.dataset.urlInput, input.value.trim());
          });
        }
      }
    }

    function saveSettings() {
      lsSet(SETTINGS_KEY, JSON.stringify(settings));
    }

    /* ── focus tracking + loop ── */

    document.addEventListener("focusin", (e) => {
      const el = resolveEditable(e.target);
      if (el && el !== tracked) {
        tracked = el;
        segments = [];
        statusKind = "idle";
        statusMsg = siteEnabled() ? "watching this field" : "auto-check off — click to check";
        ensureWidget();
        render();
      }
      // Focus moving elsewhere (including into our widget) keeps the tracked
      // field, so panel buttons can still act on it.
    }, true);

    // Pick up a field that was already focused when we loaded.
    const initial = resolveEditable(document.activeElement);
    if (initial) {
      tracked = initial;
      ensureWidget();
      render();
    }

    setInterval(() => {
      if (tracked && !tracked.isConnected) {
        tracked = null;
        segments = [];
        scheduleMarks(); // clear any leftover underline bars
        if (widget) render();
        return;
      }
      if (!tracked || !widget) return;
      if (siteEnabled() && !inflight && !document.hidden && fieldEligible()
          && Date.now() - lastCheckEnd >= CHECK_INTERVAL_MS) {
        cycle(); // opted-in automatic path — still floored at 10s + hash cache
      } else if (expanded && !inflight) {
        const el = widget.shadow.getElementById("countdownTxt");
        if (el && siteEnabled()) el.textContent = `next check in ${Math.max(0, Math.ceil((CHECK_INTERVAL_MS - (Date.now() - lastCheckEnd)) / 1000))}s`;
      } else if (!expanded) {
        // Keep pill visibility fresh as the field grows/shrinks — no re-render.
        const show = Boolean(tracked && (fieldEligible() || segments.length > 0));
        widget.root.style.display = show ? "" : "none";
      }
    }, 1000);
    // Deliberately NO startup network calls in field mode: on a non-enabled
    // site, nothing is sent anywhere until the user clicks.
  }
})();
