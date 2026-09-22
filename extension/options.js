/* Tracely options page — the account (sign in, plan, upgrade), the model
   stop, the per-site auto-check list, and a live probe of the server.

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
   plan, the thorough one for Pro's "Explain in depth" and desktop critiques
   while the monthly allowance lasts.

   They are still named here because this page is what a reader checks to see
   what they are buying, and a rename that misses this file is exactly how
   the slider ended up naming three Anthropic models the extension could no
   longer call. */
const MODELS = { fast: "gpt-5.6-luna", thorough: "gpt-6-astra" };
// Plans with a Thorough allowance (shared/plan.js THOROUGH_MONTHLY_USD).
const DEEP_PLANS = ["pro"];

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

// Whether this account is offered Thorough explanations at all.
function hasThorough() {
  return account.unenforced || account.beta === true || DEEP_PLANS.includes(account.plan);
}

/* The "Checking model" section: one hint everybody gets, then either the Pro
   Thorough block with its meter or the locked line, then the source-search
   and fair-use lines. Anything the server did not report stays hidden —
   a local server meters nothing and must not be made to look as if it does. */
function renderPlanState() {
  const pro = hasThorough();
  $("thoroughPro").hidden = !pro;
  $("thoroughLocked").hidden = pro;
  renderThoroughMeter();
  renderSourcesLine();
  renderFairUseLine();
}

function renderThoroughMeter() {
  const t = account.thorough;
  const meter = $("thoroughMeter");
  const text = $("thoroughMeterText");
  if (!hasThorough() || !t) {
    meter.hidden = true;
    text.hidden = true;
    return;
  }
  const left = Math.max(0, Math.min(100, Math.round(t.remainingPct)));
  const on = monthDayLabel(t.resetsOn);
  meter.hidden = false;
  $("thoroughFill").style.width = `${left}%`;
  text.hidden = false;
  text.textContent = left > 0
    ? `${left}% of this month's Thorough allowance left · resets ${on}`
    : `This month's Thorough allowance is used up. Explanations use the standard model until ${on}.`;
}

function renderSourcesLine() {
  const line = $("sourcesLine");
  const limits = account.limits?.sources;
  const used = account.usage?.sources;
  if (!limits || !used || (limits.day === null && limits.month === null)) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  // Free (and any account metered at Free's numbers under fair use) has a
  // daily allowance; a paid one is sold by the month, with the day as a burst.
  const metered = account.limits?.checksPerDay !== null || account.plan === "free";
  const leftToday = limits.day === null ? null : Math.max(0, limits.day - used.today);
  line.textContent = metered && limits.day !== null
    ? `Source searches: ${used.today} of ${limits.day} today · ${used.month} of ${limits.month} this month.`
    : `Source searches: ${used.month} of ${limits.month} this month${leftToday === null ? "" : ` (${leftToday} left today)`}.`;
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
  $("betaPlanOut").hidden = !(beta && !signedIn);
  $("betaPlanLabel").textContent = PLAN_LABEL[account.plan] ?? PLAN_LABEL.pro;
  $("seePlans").hidden = beta;
  $("acctBeta").hidden = !beta;

  if (!account.configured) {
    $("acctHint").textContent = "This build has no Tracely accounts configured, so everything runs unmetered against whichever server answered.";
    $("signIn").disabled = true;
    return;
  }
  $("signIn").disabled = false;

  if (signedIn) {
    $("acctEmail").textContent = account.email ?? "Signed in";
    const label = PLAN_LABEL[account.plan] ?? PLAN_LABEL.free;
    $("acctPlan").textContent = label;
    $("acctPlan").className = account.plan === "free" ? "plan" : "plan paid";
    // Three states, because two of them used to render as the same wrong link:
    // upgrading (go to pricing), managing a real subscription (go to the
    // portal), and managing one with no portal configured yet (say so, rather
    // than sending a subscriber to the pricing page).
    const manage = $("manageLink");
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
    $("acctHint").textContent = beta
      ? "This is a Tracely test build, so you're on Pro while the beta lasts. If you also pay for a plan, Manage subscription still reaches it."
      : account.plan === "free"
        ? "You're on Starter. Student removes the daily check limit and adds 100 source searches a month and auto-sources; Pro adds Thorough explanations."
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
  chrome.storage.local.get({ enabledSites: [] }, (cfg) => renderSites(cfg.enabledSites));
  refreshAccount(); // fills the plan meters too, once the server has answered
}

/* Any key a previous build stored is removed on load rather than left sitting
   in chrome.storage. Nothing reads it now, so keeping it would only mean an
   OpenAI credential living on in every existing install with no screen that
   can show or clear it. */
chrome.storage.local.remove("apiKey");

/* The retired Faster↔Smarter default stop. Nothing reads it since 2.20.0 —
   the server picks the model — so it is dropped rather than left behind in
   every existing install's storage. */
chrome.storage.local.remove("model");

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
