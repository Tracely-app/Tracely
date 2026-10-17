/* Tracely's Settings page (options.html), one section at a time, chosen in
   the sidebar like the desktop's Settings. Since 2026-10-16 (owner: "revamp
   settings to include more that typical settings has"):
     General          on / paused / off, Google Docs, the auto-check sites,
                      the button's corner, the panel on open, the shortcut
     Checking         what is flagged, how strict, the usual kind of writing,
                      the automatic evidence search, the edit preview,
                      Review all typing; the model, evidence recommendations
     Citations        the style, the list's heading, links and access dates,
                      the sources suggested (2.21.63)
     Documents        each Doc checked here, and its own style, kind,
                      never-check, reset and dismissed notes (2.21.64)
     Memory           what is kept here, clearing each part, and the
                      sentences never to flag again (2.21.64)
     Account and billing   sign-in, the plan card, what's been used
     Privacy and data what leaves the browser, export, clear saved checks,
                      delete the account
     Help             what's new, the keys, diagnostics
   and a live probe of the server in the sidebar.

   The sign-in itself lives in the background worker (it holds the token and
   the Supabase constants); this page only sends it messages. */
"use strict";

/* BOTH servers, in the order background.js tries them.
   This was `const SERVER = "http://localhost:4477"` — the options page probed
   localhost and nothing else, while the background worker had been falling
   back to the hosted server for weeks. So on any machine with no local server
   the page reported "Local server: offline — add an API key above to use
   Tracely standalone" over an extension that was checking claims perfectly
   well against api.jointracely.com. Wrong, and wrong in the direction of
   telling the reader to go and buy an OpenAI key. Merrick hit it on a clean
   install and reported the whole extension as an outdated build.

   Kept as its own list rather than asked of the worker, because this page has
   to say something truthful before the worker has finished waking up. */
const SERVERS = [
  { base: "http://localhost:4477", local: true },
  { base: "https://api.jointracely.com", local: false },
];
const ORDER_URL = "https://jointracely.com/order";

/* Stripe Customer Portal login link — Billing > Customer portal > "Share a
   link to the customer portal" in the Stripe dashboard. No server code and no
   API call needed: the customer enters their email and Stripe emails them in.

   This MUST be filled before subscriptions go on sale. The public FAQ promises
   "cancel in one click", and until this is set a paying subscriber has no way
   to cancel at all — the Manage subscription link pointed at the PRICING page,
   which shows someone trying to leave the plans they are already on. Card
   networks also expect a subscription business to offer a cancellation path.

   Empty is handled honestly below rather than silently: the link becomes an
   email to support instead of pretending to be self-service. */
const PORTAL_URL = "https://billing.stripe.com/p/login/5kQ3cv2Sy5gw4XY49P4gg00";
const SUPPORT_EMAIL = "hello@jointracely.com";
const $ = (id) => document.getElementById(id);

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


/* ── what the server runs ────────────────────────────────────────────────
   The two model ids the server serves (lib/llm.js MODEL_TIERS: fast and
   thorough), pinned to it by test/models.test.js. Nothing on this page
   CHOOSES one any more — the Faster↔Smarter slider is gone, and the server
   picks the model and effort per route (shared/plan.js modelForRoute): the
   fast model for every check, detection, flow and source search on every
   plan, the thorough one for desktop critiques while Pro's monthly allowance
   lasts. The extension's "Explain in depth" is off (owner, 2026-10-13), so
   this page no longer shows the Thorough meter.

   They are still named here because this page is what a reader checks to see
   what they are buying, and a rename that misses this file is exactly how
   the slider ended up naming three Anthropic models the extension could no
   longer call. */
const MODELS = { fast: "gpt-5.6-luna", thorough: "gpt-6-astra" };
// Plans with evidence recommendations: content.js RECOMMEND_PLANS, every paid plan.
const RECOMMEND_PLANS = ["student", "pro"];

// "2026-10-01" -> "Oct 1" (shared/plan.js monthDayLabel, mirrored).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthDayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "the 1st";
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/* ── the account, and what it unlocks ────────────────────────────────────────
   The plan comes from the signed-in account and is resolved by the SERVER
   (GET /api/entitlement) — this page renders that answer, it does not decide
   it. Every number below is the server's own metering, relayed by the
   background worker (entitlementExtras): this page states allowances, it
   never computes one.

   One flag turns the gating off: `unenforced` — the server reported
   `enforced: false`, meaning no Supabase project is configured and it meters
   nothing. Showing an upgrade prompt against a server that will answer
   anything would be a lie.

   There was a second, `byoKey`, for the bring-your-own-OpenAI-key mode. That
   mode is gone: it was a way to use every model without ever having a plan,
   which is the one thing a metered product cannot offer, and it was a whole
   second implementation of the checking pipeline to keep in step with the
   first. */

const PLAN_LABEL = { free: "Free", student: "Student", pro: "Pro" };

let account = {
  configured: false, signedIn: false, plan: "free", email: null, userId: null,
  unenforced: false, beta: false, provisional: true,
  limits: null, usage: null, thorough: null, fairUse: null,
};

/* Whether this account gets evidence recommendations (content.js
   canRecommend). Owner, 2026-10-13: Starter helps with mistakes only;
   Student and Pro also recommend evidence that would make the writing
   better. */
function hasRecommendations() {
  return account.unenforced || account.beta === true || RECOMMEND_PLANS.includes(account.plan);
}

/* The "Checking model" section: one hint everybody gets, then either the
   evidence-recommendations tile or the locked line, then the source-search
   and fair-use lines. Anything the server did not report stays hidden —
   a local server meters nothing and must not be made to look as if it does. */
function renderPlanState() {
  const paid = hasRecommendations();
  $("recommendPlan").hidden = !paid;
  $("recommendLocked").hidden = paid;
  renderIncludes();
  renderUsage(); // (the bars replace the line of source-search counts)
  renderFairUseLine();
}

/* What's been used, as bars: the server's own counts against the plan's own
   limits (entitlementExtras relays the source searches). A server that
   meters nothing reports neither, and the tile stays hidden. */
function renderUsage() {
  const l = account.limits?.sources, u = account.usage?.sources;
  const rows = [];
  if (l && u && !account.unenforced) {
    if (Number.isFinite(l.day)) rows.push(["Source searches today", u.today, l.day]);
    if (Number.isFinite(l.month)) rows.push(["Source searches this month", u.month, l.month]);
  }
  $("usage").innerHTML = rows.map(([label, used, of]) => {
    const pct = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 100;
    return `<div class="usage-row"><div class="usage-head"><span>${escHtml(label)}</span><span>${used} of ${of}</span></div>`
      + `<span class="meter" role="meter" aria-valuemin="0" aria-valuemax="${of}" aria-valuenow="${used}" aria-label="${escHtml(label)}"><span class="meter-fill${used >= of ? " full" : ""}" style="width:${pct}%"></span></span></div>`;
  }).join("");
  $("usageTile").hidden = rows.length === 0;
}

/* What the plan card lists under the plan's name — the desktop's "includes"
   — from the server's own limits, never a copy of the price page: a check
   allowance, the source searches, and evidence recommendations where they
   come with the plan. A server that meters nothing reports no limits, and
   the list stays hidden. */
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function renderIncludes() {
  const list = $("planIncludes");
  const l = account.limits;
  const items = [];
  if (l && !account.unenforced) {
    if (l.checksPerDay === null) items.push("No daily check limit");
    else if (Number.isFinite(l.checksPerDay)) items.push(`${l.checksPerDay} checks a day`);
    const s = l.sources;
    if (s && (s.day != null || s.month != null)) {
      items.push(s.month == null ? `${s.day} source searches a day`
        : s.day == null ? `${s.month} source searches a month`
          : `${s.month} source searches a month, up to ${s.day} a day`);
    }
  }
  if (items.length && hasRecommendations()) items.push("Evidence recommendations");
  list.innerHTML = items.map((t) => `<li>${escHtml(t)}</li>`).join("");
  list.hidden = items.length === 0;
}

function renderFairUseLine() {
  const line = $("fairUseLine");
  const state = account.fairUse?.state;
  if (state !== "day" && state !== "month") {
    line.hidden = true;
    return;
  }
  const until = state === "month" ? monthDayLabel(account.fairUse.resetsOn) : "midnight";
  line.hidden = false;
  line.textContent = `You've reached ${state === "month" ? "this month's" : "today's"} fair-use limit, so Tracely is running at Starter limits until ${until}. Your plan and billing are unchanged.`;
}

function renderAccount() {
  const signedIn = account.signedIn;
  $("signedIn").hidden = !signedIn;
  $("signedOut").hidden = signedIn;

  /* The team's test build (beta.json + Load unpacked): the server serves it as
     Pro whether or not anyone signs in, and says so with `beta`. A tester is
     shown the plan they are on and is never offered one to BUY — so the badge
     appears signed out too, and "See plans" is hidden. A signed-in tester
     keeps "Manage subscription": the server reports Pro for every beta
     caller, so this page cannot tell a free tester from one who really pays,
     and a paying one must still be able to reach the portal and cancel.
     Without `beta` none of this changes anything. */
  const beta = account.beta === true;
  // The plan card names the plan whether or not anyone is signed in: a tester
  // signed out is on Pro too, and the Beta badge says why.
  $("acctPlan").textContent = PLAN_LABEL[account.plan] ?? (beta ? PLAN_LABEL.pro : PLAN_LABEL.free);
  $("acctBeta").hidden = !beta;
  // One link on the card: See plans signed out (never for a tester), and
  // signed in the account's own — Upgrade, or the subscription.
  $("seePlans").hidden = beta || signedIn;
  $("manageLink").hidden = !signedIn;
  $("deleteRow").hidden = !signedIn;

  if (!account.configured) {
    $("acctHint").textContent = "This build has no Tracely accounts configured, so everything runs unmetered against whichever server answered.";
    $("signIn").disabled = true;
    return;
  }
  $("signIn").disabled = false;

  if (signedIn) {
    $("acctEmail").textContent = account.email ?? "Signed in";
    $("acctAvatar").textContent = String(account.email ?? "").trim().charAt(0).toUpperCase() || "T";
    // Three states, because two of them used to render as the same wrong link:
    // upgrading (go to pricing), managing a real subscription (go to the
    // portal), and managing one with no portal configured yet (say so, rather
    // than sending a subscriber to the pricing page).
    const manage = $("manageLink");
    manage.className = account.plan === "free" ? "btn btn-primary" : "btn";
    if (account.plan === "free") {
      manage.textContent = "Upgrade";
      manage.href = orderUrl(account.userId);
    } else if (PORTAL_URL) {
      manage.textContent = "Manage subscription";
      // Pre-fill the email when we know it. Stripe's no-code portal starts by
      // asking for one and then mailing a login link, so skipping that field
      // removes a step from a flow that is already four steps long — and it
      // removes the commonest way it goes wrong, which is a customer typing a
      // different address from the one they paid with and being told no
      // subscription exists.
      manage.href = account.email
        ? `${PORTAL_URL}?prefilled_email=${encodeURIComponent(account.email)}`
        : PORTAL_URL;
    } else {
      manage.textContent = "Email us to cancel";
      manage.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Cancel my Tracely subscription")}`;
    }
    // Billing: what the subscription page holds, where there is one to manage.
    $("billingNote").textContent = account.plan !== "free" && PORTAL_URL
      ? "Receipts, your payment method, changing plan and cancelling are all on the subscription page: Manage subscription. Nothing on this page charges you."
      : "Plans are bought and cancelled on jointracely.com. Nothing on this page charges you.";
    $("acctHint").textContent = beta
      ? "This is a Tracely test build, so you're on Pro while the beta lasts. If you also pay for a plan, Manage subscription still reaches it."
      : account.plan === "free"
        ? "You're on Starter, which flags mistakes and helps you fix them. Student and Pro also recommend evidence that would make your writing stronger, with more source searches."
        : "Your plan applies to the extension and the Tracely desktop app — one account covers both.";
  } else if (beta) {
    $("acctHint").textContent = "This is a Tracely test build, so every check runs on Pro while the beta lasts — no account and nothing to buy. Signing in is optional.";
  } else {
    $("acctHint").textContent = "Sign in to use the plan you pay for. Not required — without an account Tracely runs on the free tier.";
  }
}

let acctStatusTimer = null;
function acctStatus(text, warn) {
  $("acctStatus").textContent = text;
  $("acctStatus").className = warn ? "saved warn" : "saved";
  clearTimeout(acctStatusTimer);
  if (text) acctStatusTimer = setTimeout(() => { $("acctStatus").textContent = ""; }, 6000);
}

// Never rejects and never answers above free: an unreachable worker leaves the
// page on the free tier rather than blank.
async function refreshAccount(force) {
  try {
    const r = await chrome.runtime.sendMessage({ type: "tracely-entitlement", force: force === true });
    if (r?.ok) {
      account = {
        configured: Boolean(r.configured), signedIn: Boolean(r.signedIn), plan: r.plan ?? "free",
        email: r.email ?? null, userId: r.userId ?? null, unenforced: Boolean(r.unenforced),
        beta: r.beta === true, provisional: r.provisional === true,
        // The server's own metering, or null where it reported none.
        limits: r.limits ?? null, usage: r.usage ?? null, thorough: r.thorough ?? null, fairUse: r.fairUse ?? null,
      };
    }
  } catch { /* worker restarting — keep the last answer */ }
  renderAccount();
  renderPlanState();
}

$("signIn").addEventListener("click", async () => {
  $("signIn").disabled = true;
  acctStatus("Opening sign-in…");
  try {
    const r = await chrome.runtime.sendMessage({ type: "tracely-signIn" });
    if (!r?.ok) throw new Error(r?.message ?? "Sign-in failed");
    acctStatus("Signed in.");
  } catch (err) {
    acctStatus(err?.message ?? String(err), true);
  }
  $("signIn").disabled = false;
  await refreshAccount(true);
});

$("signOut").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "tracely-signOut" });
  } catch { /* the worker clears the token; if it never woke, nothing changed */ }
  acctStatus("Signed out — back on the free tier.");
  await refreshAccount(true);
});

/* ── load + save ─────────────────────────────────────────────────────────── */

function load() {
  chrome.storage.local.get({ enabledSites: [], docsEnabled: false, prefs: {} }, (cfg) => {
    renderSites(cfg.enabledSites);
    $("docsTgl").checked = cfg.docsEnabled === true;
    prefs = readPrefs(cfg.prefs);
    renderPrefs();
  });
  refreshAccount(); // fills the plan meters too, once the server has answered
  renderShortcut();
  renderWhatsNew();
  loadMemory(); // Documents and Memory
  // Which section to show: the address's #section (a reload, a bookmark), or
  // the one the widget asked for (background.js "tracely-openSettings"),
  // else General.
  const asked = typeof location !== "undefined" ? location.hash.replace(/^#/, "") : "";
  showSection(asked || "general");
  chrome.storage.local.get({ settingsOpenAt: null }, (cfg) => takeOpenAt(cfg.settingsOpenAt));
  const version = typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest()?.version : null;
  if (version) $("buildVersion").textContent = `Version ${version}`;
}

/* ── sections: the sidebar, like the desktop's Settings ──────────────────
   One panel at a time. The address carries the section (#account …), so a
   reload or a bookmark comes back to it, and the widget's gear can open the
   page at the section it is about. */
const SECTIONS = ["general", "checking", "citations", "documents", "memory", "account", "privacy", "help"];
// Sections a bookmark or an older widget may still name: Google Docs and Sites are in General now.
const SECTION_MOVED = { docs: "general", sites: "general" };
function showSection(id) {
  const want = SECTIONS.includes(id) ? id : SECTION_MOVED[id] ?? "general";
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== want;
  for (const item of document.querySelectorAll("[data-nav]")) {
    const on = item.dataset.nav === want;
    item.classList.toggle("active", on);
    if (on) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  if (typeof history !== "undefined" && typeof location !== "undefined" && location.hash !== `#${want}`) {
    history.replaceState(null, "", `#${want}`);
  }
  return want;
}
for (const item of document.querySelectorAll("[data-nav]")) {
  item.addEventListener("click", () => showSection(item.dataset.nav));
}
if (typeof window !== "undefined") window.addEventListener("hashchange", () => showSection(location.hash.replace(/^#/, "")));
// The widget's request, once: a fresh one (the last minute) moves the page,
// and it is cleared either way so a later visit opens where it was.
function takeOpenAt(req) {
  if (!req || typeof req !== "object") return;
  if (Date.now() - Number(req.at) < 60_000) showSection(req.section);
  chrome.storage.local.remove("settingsOpenAt");
}
// The same switch the first Doc asks for (content.js renderDocsConsent).
$("docsTgl").addEventListener("change", (e) => chrome.storage.local.set({ docsEnabled: e.target.checked === true }));

/* ── General: on, paused or off, and the button ──────────────────────────
   chrome.storage "prefs", which content.js reads (its PREF_DEFAULTS: the
   same names and defaults). pausedUntil is 0 running, a time paused until
   then, -1 off until turned back on. */
const PREF_DEFAULTS = {
  pausedUntil: 0, launcherSide: "right", panelOpen: false, clearedAt: 0,
  showEvidence: true, showCitations: true, strictness: "balanced", usualKind: "", autoEvidence: true, previewEdits: true, reviewTyping: true,
  citeStyle: "match", listHeading: "", citeLinks: true, citeAccessed: false, citableOnly: false, avoidSites: [],
  undismissedAt: 0,
};
let prefs = { ...PREF_DEFAULTS };
// What storage holds, over the defaults; a list that isn't one (an older build, a bad write) reads as empty.
function readPrefs(stored) {
  const p = { ...PREF_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  if (!Array.isArray(p.avoidSites)) p.avoidSites = [];
  return p;
}
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  chrome.storage.local.set({ prefs });
  renderPrefs();
}
// "4:30 PM", or "midnight" for a pause for today.
function untilLabel(t) {
  const d = new Date(t);
  return d.getHours() === 0 && d.getMinutes() === 0 ? "midnight" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
let resumeTimer = null;
function renderGeneral() {
  const off = prefs.pausedUntil === -1;
  const paused = !off && prefs.pausedUntil > Date.now();
  $("onTgl").checked = !off;
  $("pauseLine").textContent = off ? "Off: nothing is checked or sent until you turn it back on."
    : paused ? `Paused until ${untilLabel(prefs.pausedUntil)}: nothing is checked or sent until then.`
      : "Checking wherever you've turned it on.";
  $("pauseHour").hidden = off || paused;
  $("pauseToday").hidden = off || paused;
  $("resumeNow").hidden = !paused;
  for (const b of document.querySelectorAll("[data-side]")) b.setAttribute("aria-pressed", String(b.dataset.side === prefs.launcherSide));
  $("panelOpenTgl").checked = prefs.panelOpen === true;
  // The page says "running" again when a pause ends, without a reload.
  clearTimeout(resumeTimer);
  if (paused) resumeTimer = setTimeout(renderGeneral, Math.min(prefs.pausedUntil - Date.now() + 100, 2 ** 31 - 1));
}
$("onTgl").addEventListener("change", (e) => savePrefs({ pausedUntil: e.target.checked ? 0 : -1 }));
$("pauseHour").addEventListener("click", () => savePrefs({ pausedUntil: Date.now() + 60 * 60 * 1000 }));
$("pauseToday").addEventListener("click", () => { const d = new Date(); d.setHours(24, 0, 0, 0); savePrefs({ pausedUntil: d.getTime() }); });
$("resumeNow").addEventListener("click", () => savePrefs({ pausedUntil: 0 }));
for (const b of document.querySelectorAll("[data-side]")) b.addEventListener("click", () => savePrefs({ launcherSide: b.dataset.side === "left" ? "left" : "right" }));
$("panelOpenTgl").addEventListener("change", (e) => savePrefs({ panelOpen: e.target.checked === true }));

function renderPrefs() {
  renderGeneral();
  renderChecking();
  renderCitations();
}

/* ── Checking: what is flagged, how sure, how fixes go in ────────────────
   content.js reads each in "Settings → the widget" (flagShown's kindShown,
   kindWithUsual, autoFindSources, runDocEdit's preview, Review all). */
const STRICT_LINE = {
  clear: "Shows only what Tracely is sure of, so you may miss a real mistake.",
  balanced: "Shows everything Tracely finds.",
  thorough: "Also asks for a source for general statements, and for a figure a later citation in its paragraph might cover.",
};
// The kinds a writer most often writes, named as the widget's header names them (content.js WRITING_KINDS; a test keeps them equal).
const KIND_CHOICES = [
  ["essay", "Essay"], ["argumentative", "Argumentative essay"], ["informative", "Informative essay"], ["literary", "Literary analysis"],
  ["rhetorical", "Rhetorical analysis"], ["research", "Research paper"], ["lab", "Lab report"], ["dbq", "DBQ essay"],
  ["synthesis", "Synthesis essay"], ["speech", "Speech"], ["news", "News article"], ["blog", "Blog post"],
  ["personal", "Personal essay"], ["college", "College or scholarship essay"],
];
// `none` names the first choice: Tracely decides (Checking), or the Doc follows Settings (Documents).
const kindOptionsHtml = (none, picked = "") => [["", none], ...KIND_CHOICES]
  .map(([k, label]) => `<option value="${k}"${k === picked ? " selected" : ""}>${escHtml(label)}</option>`).join("");
const CHECK_SWITCHES = ["showEvidence", "showCitations", "autoEvidence", "previewEdits", "reviewTyping"];
function renderChecking() {
  for (const id of CHECK_SWITCHES) $(id).checked = prefs[id] !== false;
  const strict = STRICT_LINE[prefs.strictness] ? prefs.strictness : "balanced";
  for (const b of document.querySelectorAll("[data-strict]")) b.setAttribute("aria-pressed", String(b.dataset.strict === strict));
  $("strictLine").textContent = STRICT_LINE[strict];
  const usual = $("usualKind");
  if (!usual.innerHTML) usual.innerHTML = kindOptionsHtml("Let Tracely tell");
  usual.value = KIND_CHOICES.some(([k]) => k === prefs.usualKind) ? prefs.usualKind : "";
}
for (const id of CHECK_SWITCHES) $(id).addEventListener("change", (e) => savePrefs({ [id]: e.target.checked === true }));
for (const b of document.querySelectorAll("[data-strict]")) b.addEventListener("click", () => savePrefs({ strictness: b.dataset.strict }));
$("usualKind").addEventListener("change", (e) => savePrefs({ usualKind: e.target.value }));

/* ── Citations: the style, the list's heading, the entries, the sources ── */
const MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]; // content.js CITE_MLA_MONTHS
function renderCitations() {
  $("citeStyle").value = ["match", "mla", "apa", "chicago"].includes(prefs.citeStyle) ? prefs.citeStyle : "match";
  $("listHeading").value = ["Works Cited", "References", "Bibliography"].includes(prefs.listHeading) ? prefs.listHeading : "";
  $("citeLinks").checked = prefs.citeLinks !== false;
  $("citeAccessed").checked = prefs.citeAccessed === true;
  $("citableOnly").checked = prefs.citableOnly === true;
  const d = new Date();
  $("accessedLine").textContent = `Adds the day you read a web page, which some teachers ask for. In MLA: “Accessed ${d.getDate()} ${MLA_MONTHS[d.getMonth()]} ${d.getFullYear()}.”`;
  renderAvoidSites(prefs.avoidSites);
}
$("citeStyle").addEventListener("change", (e) => savePrefs({ citeStyle: e.target.value }));
$("listHeading").addEventListener("change", (e) => savePrefs({ listHeading: e.target.value }));
for (const id of ["citeLinks", "citeAccessed", "citableOnly"]) $(id).addEventListener("change", (e) => savePrefs({ [id]: e.target.checked === true }));
/* A site as content.js compares it (credHost): the host, lower case, without
   "www." — "https://www.Example.org/page" is example.org. Null when it isn't one. */
function siteOf(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  try { host = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { return null; }
  host = host.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}
function renderAvoidSites(sites) {
  const ul = $("avoidList");
  ul.textContent = "";
  for (const site of Array.isArray(sites) ? sites : []) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "origin";
    span.textContent = site;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", () => savePrefs({ avoidSites: prefs.avoidSites.filter((s) => s !== site) }));
    li.append(span, btn);
    ul.appendChild(li);
  }
}
$("avoidForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const site = siteOf($("avoidInput").value);
  if (!site) { $("citationsStatus").textContent = "That isn't a site. Try one like wikipedia.org."; return; }
  $("avoidInput").value = "";
  $("citationsStatus").textContent = "";
  if (!prefs.avoidSites.includes(site)) savePrefs({ avoidSites: [...prefs.avoidSites, site] });
});

/* ── Documents: each Doc Tracely has checked, and its own settings ───────
   content.js (Docs mode) writes a line per Doc ("doc.<id>": title, url,
   counts, checkedAt, bytes, noteDocIndex) and reads "docPrefs" (docPref).
   This page can't reach the Doc's own storage, so a reset or the dismissed
   notes brought back are marks the Doc takes the next time it is open. */
let docs = [];    // [{ id, title, url, counts, checkedAt, bytes }], newest first
let docPrefs = {};
const DOC_ID_RE = /^[\w-]{10,}$/;
const DOC_KEEP = 100; // lines kept; the oldest beyond go when the page opens
function readDocs(all) {
  const out = [];
  for (const [k, v] of Object.entries(all ?? {})) {
    const id = k.startsWith("doc.") ? k.slice(4) : "";
    if (!DOC_ID_RE.test(id) || !v || typeof v !== "object") continue;
    out.push({
      id, title: typeof v.title === "string" && v.title.trim() ? v.title.trim() : "Untitled document",
      // Only a Google Docs address is ever a link here.
      url: typeof v.url === "string" && v.url.startsWith("https://docs.google.com/document/") ? v.url : "",
      counts: v.counts && typeof v.counts === "object" ? v.counts : {}, checkedAt: Number(v.checkedAt) || 0, bytes: Number(v.bytes) || 0,
    });
  }
  return out.sort((a, b) => b.checkedAt - a.checkedAt);
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function countsLine(c) {
  const parts = [];
  if (c.wrong > 0) parts.push(plural(c.wrong, "factual error", "factual errors"));
  if (c.check > 0) parts.push(`${c.check} ${c.check === 1 ? "needs" : "need"} evidence`);
  if (c.cite > 0) parts.push(plural(c.cite, "citation issue", "citation issues"));
  return parts.length ? parts.join(" · ") : "Nothing open";
}
function agoLine(t) {
  if (!t) return "";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "checked just now";
  if (min < 60) return `checked ${min} min ago`;
  if (min < 24 * 60) return `checked ${Math.round(min / 60)} h ago`;
  return `checked ${new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
const STYLE_CHOICES = [["", "Citation style: as in Settings"], ["mla", "MLA"], ["apa", "APA"], ["chicago", "Chicago"]];
function renderDocs() {
  const list = docs.slice(0, 50);
  $("noDocs").hidden = list.length > 0;
  $("docList").innerHTML = list.map((d) => {
    const p = docPrefs[d.id] && typeof docPrefs[d.id] === "object" ? docPrefs[d.id] : {};
    const title = d.url ? `<a class="doc-title" href="${escHtml(d.url)}" target="_blank" rel="noopener noreferrer">${escHtml(d.title)}</a>` : `<span class="doc-title">${escHtml(d.title)}</span>`;
    const styles = STYLE_CHOICES.map(([k, label]) => `<option value="${k}"${(p.style ?? "") === k ? " selected" : ""}>${escHtml(label)}</option>`).join("");
    return `<div class="tile" data-doc-row="${d.id}">
      <div class="row">
        <div class="grow">${title}<div class="row-sub">${escHtml(p.never === true ? "Never checked" : [countsLine(d.counts), agoLine(d.checkedAt)].filter(Boolean).join(" · "))}</div></div>
        <label class="doc-check">Check it<input type="checkbox" class="switch" data-doc-check="${d.id}"${p.never === true ? "" : " checked"} aria-label="Check ${escHtml(d.title)}" /></label>
      </div>
      <div class="doc-controls">
        <select class="select" data-doc-style="${d.id}" aria-label="Citation style for ${escHtml(d.title)}">${styles}</select>
        <select class="select" data-doc-kind="${d.id}" aria-label="Kind of writing for ${escHtml(d.title)}">${kindOptionsHtml("Kind: Tracely decides", p.kind ?? "")}</select>
        <button class="btn btn-sm" data-doc-act="reset" data-doc="${d.id}">Reset saved checks</button>
        <button class="btn btn-sm" data-doc-act="undismiss" data-doc="${d.id}">Bring back dismissed notes</button>
        <button class="btn btn-sm btn-ghost" data-doc-act="forget" data-doc="${d.id}">Remove</button>
      </div>
    </div>`;
  }).join("");
}
function saveDocPref(id, patch) {
  docPrefs = { ...docPrefs, [id]: { ...(docPrefs[id] ?? {}), ...patch } };
  chrome.storage.local.set({ docPrefs });
  renderDocs();
}
const docTitle = (id) => docs.find((d) => d.id === id)?.title ?? "that document";
$("docList").addEventListener("change", (e) => {
  const t = e.target, ds = t?.dataset ?? {};
  if (DOC_ID_RE.test(ds.docCheck ?? "")) saveDocPref(ds.docCheck, { never: t.checked !== true });
  else if (DOC_ID_RE.test(ds.docStyle ?? "")) saveDocPref(ds.docStyle, { style: t.value });
  else if (DOC_ID_RE.test(ds.docKind ?? "")) saveDocPref(ds.docKind, { kind: t.value });
});
$("docList").addEventListener("click", (e) => {
  const ds = e.target?.dataset ?? {};
  const id = ds.doc;
  if (!DOC_ID_RE.test(id ?? "") || !ds.docAct) return;
  if (ds.docAct === "reset") {
    saveDocPref(id, { resetAt: Date.now() });
    $("docsStatus").textContent = `“${docTitle(id)}” forgets its saved checks the next time it is open.`;
  } else if (ds.docAct === "undismiss") {
    saveDocPref(id, { undismissAt: Date.now() });
    $("docsStatus").textContent = `“${docTitle(id)}” shows its dismissed notes again the next time it is open.`;
  } else if (ds.docAct === "forget") {
    const { [id]: _gone, ...rest } = docPrefs;
    docPrefs = rest;
    chrome.storage.local.remove(`doc.${id}`);
    chrome.storage.local.set({ docPrefs });
    docs = docs.filter((d) => d.id !== id);
    renderDocs();
    renderMemory();
    $("docsStatus").textContent = "Removed from the list. It comes back, with Settings' defaults, the next time it is checked.";
  }
});

/* ── Memory: what Tracely keeps in this browser, and clearing each part ── */
let ignoreList = [];
let diagCount = 0;
const kb = (bytes) => (bytes < 1024 ? "under 1 KB" : `about ${Math.round(bytes / 1024)} KB`);
function renderMemory() {
  const checked = docs.reduce((n, d) => n + d.bytes, 0);
  $("memChecks").textContent = docs.length
    ? `The checks, sources and reviews kept with each document and site, so nothing is checked twice. ${plural(docs.length, "Google Doc", "Google Docs")}: ${kb(checked)}; other sites keep their own.`
    : "The checks, sources and reviews kept with each document and site, so nothing is checked twice.";
  $("memDocs").textContent = `${plural(docs.length, "document", "documents")} under Documents, and each one's own settings.`;
  $("memDiag").textContent = `What the last ${diagCount || "few"} edits in a Doc answered, for Help's Copy diagnostics.`;
  const ul = $("ignoreList");
  ul.innerHTML = ignoreList.map((text, i) => `<li><span class="origin">${escHtml(text)}</span><button data-ignore-i="${i}">Remove</button></li>`).join("");
  $("noIgnore").hidden = ignoreList.length > 0;
  $("clearIgnore").hidden = ignoreList.length === 0;
  if (typeof chrome.storage.local.getBytesInUse === "function") {
    chrome.storage.local.getBytesInUse(null, (n) => { $("storageTotal").textContent = `Tracely's own storage in this browser: ${kb(n ?? 0)}.`; });
  }
}
// Everything this page lists comes from one read of the extension's storage.
function loadMemory() {
  chrome.storage.local.get(null, (all) => {
    docs = readDocs(all);
    for (const d of docs.slice(DOC_KEEP)) chrome.storage.local.remove(`doc.${d.id}`);
    docs = docs.slice(0, DOC_KEEP);
    docPrefs = all?.docPrefs && typeof all.docPrefs === "object" && !Array.isArray(all.docPrefs) ? all.docPrefs : {};
    ignoreList = Array.isArray(all?.ignoreList) ? all.ignoreList.filter((t) => typeof t === "string" && t.trim()) : [];
    diagCount = Array.isArray(all?.diag?.edits) ? all.diag.edits.length : 0;
    renderDocs();
    renderMemory();
  });
}
$("ignoreList").addEventListener("click", (e) => {
  const i = Number(e.target?.dataset?.ignoreI);
  if (!Number.isInteger(i) || !ignoreList[i]) return;
  ignoreList = ignoreList.filter((_t, j) => j !== i);
  chrome.storage.local.set({ ignoreList });
  renderMemory();
});
$("clearIgnore").addEventListener("click", () => {
  if (!confirm("Let Tracely flag all of these sentences again?")) return;
  ignoreList = [];
  chrome.storage.local.set({ ignoreList });
  renderMemory();
});
$("memClearChecks").addEventListener("click", () => {
  if (!confirm("Clear the checks, sources and reviews Tracely saved on this device? Your settings and sign-in stay.")) return;
  savePrefs({ clearedAt: Date.now() });
  $("memoryStatus").textContent = "Cleared. An open document clears now; others when you next open them.";
});
$("memUndismiss").addEventListener("click", () => {
  savePrefs({ undismissedAt: Date.now() });
  $("memoryStatus").textContent = "Dismissed notes come back in each document the next time it is open.";
});
$("memClearDocs").addEventListener("click", () => {
  if (!confirm("Clear the document list and each document's own settings?")) return;
  chrome.storage.local.remove([...docs.map((d) => `doc.${d.id}`), "docPrefs"]);
  docs = [];
  docPrefs = {};
  renderDocs();
  renderMemory();
  $("memoryStatus").textContent = "The document list is cleared.";
});
$("memClearDiag").addEventListener("click", () => {
  chrome.storage.local.remove("diag");
  diagCount = 0;
  renderMemory();
  $("memoryStatus").textContent = "Diagnostics cleared.";
});
// Back to how Tracely starts, but never undoing a clear the pages are still to take.
$("memResetPrefs").addEventListener("click", () => {
  if (!confirm("Put every setting on these pages back to how Tracely starts?")) return;
  savePrefs({ ...PREF_DEFAULTS, clearedAt: prefs.clearedAt, undismissedAt: prefs.undismissedAt });
  $("memoryStatus").textContent = "Settings are back to how Tracely starts.";
});

/* The keyboard shortcut (manifest "commands": toggle-panel). Chrome owns the
   key: this page shows the one set, and Change opens Chrome's own page. */
function renderShortcut() {
  if (typeof chrome.commands?.getAll !== "function") return;
  chrome.commands.getAll((cmds) => {
    const key = (cmds ?? []).find((c) => c.name === "toggle-panel")?.shortcut || "Not set";
    $("shortcutNow").textContent = key;
    $("shortcutKey").textContent = key;
  });
}
$("changeShortcut").addEventListener("click", () => {
  try { chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); }
  catch { $("generalStatus").textContent = "Open chrome://extensions/shortcuts to change it."; }
});

/* ── Privacy and data ──────────────────────────────────────────────────── */
// What this browser's extension storage holds, as a file: the sign-in's tokens left out.
const EXPORT_LEAVE_OUT = ["authToken", "refreshToken"];
$("exportData").addEventListener("click", () => {
  chrome.storage.local.get(null, (all) => {
    const data = { ...(all ?? {}) };
    for (const k of EXPORT_LEAVE_OUT) delete data[k];
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), tracely: data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tracely-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    $("dataStatus").textContent = "Exported.";
  });
});
// Every page Tracely runs on clears its own saved checks when it sees this mark (content.js clearTracelyStore).
$("clearChecks").addEventListener("click", () => {
  if (!confirm("Clear the checks, sources and dismissed notes Tracely saved on this device? Your settings and sign-in stay.")) return;
  savePrefs({ clearedAt: Date.now() });
  chrome.storage.local.remove("diag");
  $("dataStatus").textContent = "Cleared. An open document clears now; others when you next open them.";
});

/* ── Help ──────────────────────────────────────────────────────────────── */
// What changed lately, in the words the testers' notes used (newest first).
const WHATS_NEW = [
  ["2.21.65", "Signed out, Find a source asks you to sign in first instead of coming back empty. Out of searches, it says so and shows the plans that give more."],
  ["2.21.64", "Settings → Documents lists the Docs Tracely has checked, each with its own style, kind and switch; Memory shows what is kept and clears it. Cards have Never flag this."],
  ["2.21.63", "Settings for what Tracely flags and how strict it is, your usual kind of writing, citation style, links and access dates, and sources to leave out."],
  ["2.21.62", "A new Settings: pause or turn Tracely off, move its button, a keyboard shortcut, your usage, export and clear your data, and this Help."],
  ["2.21.61", "Review all never cuts a suggestion off, says how many are out of view, and stops with one press (or Esc)."],
  ["2.21.60", "A source named but not cited is flagged; names in capitals like UNESCO count as names."],
  ["2.21.59", "Apply fix waits for Google Docs to settle a selection instead of refusing."],
  ["2.21.57", "Tracely tells 56 kinds of writing apart, and names one only when it is sure."],
];
function renderWhatsNew() {
  $("whatsNew").innerHTML = WHATS_NEW.map(([v, t]) => `<div class="change"><span class="change-v">${escHtml(v)}</span><span class="change-t">${escHtml(t)}</span></div>`).join("");
}
/* Diagnostics: what a report needs to say what happened — the version, the
   browser, the server and plan, the settings, and what the last in-doc
   edits answered (content.js noteDiag) — never a word of anyone's writing. */
function diagnostics(cfg) {
  const version = typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest()?.version : null;
  return {
    version, browser: typeof navigator !== "undefined" ? navigator.userAgent : null,
    server: $("serverStatusText").textContent, plan: account.plan, signedIn: account.signedIn, beta: account.beta,
    docsEnabled: cfg.docsEnabled === true, autoCheckSites: (cfg.enabledSites ?? []).length, prefs: cfg.prefs ?? {},
    lastEdits: cfg.diag?.edits ?? [],
  };
}
$("copyDiag").addEventListener("click", () => {
  chrome.storage.local.get({ docsEnabled: false, enabledSites: [], prefs: {}, diag: null }, async (cfg) => {
    const text = JSON.stringify(diagnostics(cfg), null, 2);
    try { await navigator.clipboard.writeText(text); $("helpStatus").textContent = "Copied. Paste it into your message."; }
    catch { $("helpStatus").textContent = "Couldn't reach the clipboard — try again."; }
    // The email carries it too, cut to what a mail link can hold.
    $("emailUs").href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Tracely problem")}&body=${encodeURIComponent(`What happened:\n\n\n---\n${text}`.slice(0, 1800))}`;
  });
});
$("emailUs").href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Tracely problem")}`;

/* Account deletion: the server purges what it keeps for this account and
   deletes the sign-in account itself, then the worker forgets the session.
   Refused while a paid plan is active — cancel it first, or the card keeps
   being charged for an account that no longer exists. */
$("deleteAccount").addEventListener("click", async () => {
  if (!confirm("Delete your Tracely account and everything kept with it (usage counts, payment record, sign-in)? This cannot be undone.")) return;
  $("deleteAccount").disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: "tracely-deleteAccount" });
    if (r?.ok) { acctStatus("Your account and its data have been deleted."); await refreshAccount(true); }
    else acctStatus(r?.message || "Could not delete the account — try again.", true);
  } catch { acctStatus("Could not reach the Tracely worker — try again.", true); }
  $("deleteAccount").disabled = false;
});

/* Any key a previous build stored is removed on load rather than left sitting
   in chrome.storage. Nothing reads it now, so keeping it would only mean an
   OpenAI credential living on in every existing install with no screen that
   can show or clear it. */
chrome.storage.local.remove("apiKey");

/* ── per-site auto-check list ────────────────────────────────────────────── */

function renderSites(sites) {
  const ul = $("sites");
  ul.textContent = "";
  const list = Array.isArray(sites) ? sites : [];
  $("noSites").style.display = list.length ? "none" : "";
  for (const origin of list) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "origin";
    span.textContent = origin;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      chrome.storage.local.get({ enabledSites: [] }, (cfg) => {
        chrome.storage.local.set({ enabledSites: (cfg.enabledSites ?? []).filter((o) => o !== origin) });
      });
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabledSites) renderSites(changes.enabledSites.newValue ?? []);
  // Resumed or turned on from the widget's own card while this page is open.
  if (changes.prefs) { prefs = readPrefs(changes.prefs.newValue); renderPrefs(); }
  if (changes.docsEnabled) $("docsTgl").checked = changes.docsEnabled.newValue === true;
  // A Doc checked, a card's "Never flag this", or another tab: Documents and Memory read again.
  if (Object.keys(changes).some((k) => k.startsWith("doc.") || k === "docPrefs" || k === "ignoreList" || k === "diag")) loadMemory();
  // The widget's gear while this page is already open in a tab.
  if (changes.settingsOpenAt?.newValue) takeOpenAt(changes.settingsOpenAt.newValue);
  // The worker refreshes the entitlement cache on its own schedule; a plan
  // that changed after a checkout should land here without a reload.
  if (changes.entitlement) refreshAccount();
});

/* ── live server probe ───────────────────────────────────────────────────── */

let serverWasUp = null;
// The server going up or down flips which engine serves a check, and with it
// whether the plan applies at all — so the account panel is re-read on the
// transition rather than on every 4s tick.
function noteServerState(up) {
  if (serverWasUp === up) return;
  serverWasUp = up;
  refreshAccount();
}

async function probe() {
  const wrap = $("serverStatus");
  const text = $("serverStatusText");

  for (const { base, local } of SERVERS) {
    let status;
    try {
      const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      status = await res.json().catch(() => ({}));
    } catch {
      continue; // not reachable — try the next
    }
    wrap.className = "status on";
    // Docs write-back is a local-server capability, so only the local branch
    // is allowed to promise it.
    text.textContent = !local
      ? "Tracely server: online — checks run on your plan"
      : status.docsBridge
        ? "Local server: online — all features, Docs write-back ready"
        : "Local server: online — all features (web-search sources, URL citing)";
    noteServerState(true);
    return;
  }

  // With the bring-your-own-key mode gone there is no longer a fallback to
  // suggest, so this says what is wrong instead of what to buy.
  wrap.className = "status off";
  text.textContent = "Tracely server: unreachable — checks will not run until it is back. Check your connection.";
  noteServerState(false);
}

// The honour-system Pro code this replaced. Dropping the key is the whole
// migration: whoever typed one is a free user until they sign in, which is
// the correct answer — it never entitled them to anything.
chrome.storage.local.remove("proCode");

load();
probe();
setInterval(probe, 4000);
