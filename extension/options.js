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


/* ── Faster ↔ Smarter slider ↔ model mapping ─────────────────────────────── */

/* Mirrors lib/llm.js MODEL_TIERS and extension/background.js. The notes are
   written around what the stop DOES rather than which model is behind it, so
   the next model rename is one line here and no copy edits. */
const MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra"];
const MODEL_NOTES = [
  "Fast — near-instant and very cheap. A full essay costs well under a cent.",
  "Balanced — a little slower, noticeably better on subtle claims.",
  "Thorough — the sharpest judgment, for high-stakes writing.",
];

function paintSlider(pos) {
  const slider = $("modelSlider");
  // orange fill up to the thumb, faint track after — matches jointracely.com
  const pct = (pos / (MODELS.length - 1)) * 100;
  slider.style.setProperty(
    "--range-fill",
    `linear-gradient(90deg, var(--orange) 0%, var(--orange-2) ${pct}%, rgba(20,16,10,0.08) ${pct}%, rgba(20,16,10,0.08) 100%)`
  );
  document.querySelectorAll(".tick").forEach((t) => t.classList.toggle("active", Number(t.dataset.i) === pos));
  $("labFaster").classList.toggle("active", pos === 0);
  $("labSmarter").classList.toggle("active", pos === MODELS.length - 1);
  $("modelNote").textContent = MODEL_NOTES[pos] ?? "";
}

/* ── the account, and what it unlocks ────────────────────────────────────────
   The plan comes from the signed-in account and is resolved by the SERVER
   (GET /api/entitlement) — this page renders that answer, it does not decide
   it. Clamping the slider here is presentation: the server re-clamps the model
   on every call against the token it was sent.

   One flag opens every stop: `unenforced` — the server reported
   `enforced: false`, meaning no Supabase project is configured and it clamps
   nothing. Showing an upgrade prompt against a server that will serve the top
   model on request would be a lie.

   There was a second, `byoKey`, for the bring-your-own-OpenAI-key mode. That
   mode is gone: it was a way to use every model without ever having a plan,
   which is the one thing a metered product cannot offer, and it was a whole
   second implementation of the checking pipeline to keep in step with the
   first. */

const PLAN_MAX_STOP = { free: 0, student: 1, pro: 2 };
const PLAN_LABEL = { free: "Free", student: "Student", pro: "Pro" };

let account = { configured: false, signedIn: false, plan: "free", email: null, userId: null, unenforced: false, beta: false, provisional: true };

function maxStop() {
  if (account.unenforced) return MODELS.length - 1;
  return PLAN_MAX_STOP[account.plan] ?? 0; // unknown plan is free, always
}

function sliderHint() {
  if (account.unenforced) return "This local server has no accounts configured, so every stop is open.";
  if (maxStop() === MODELS.length - 1) return "How hard Tracely thinks. Faster is cheaper and near-instant; Smarter catches subtler problems.";
  if (account.plan === "student") return "Student reaches Balanced. Thorough comes with Pro.";
  return "Free runs on Faster — quick and accurate for everyday checking.";
}

function applyPlanState() {
  const slider = $("modelSlider");
  const ceiling = maxStop();
  slider.disabled = ceiling === 0; // one stop: nothing to drag
  $("sliderHint").textContent = sliderHint();
  $("modelLocked").hidden = ceiling === MODELS.length - 1;
  document.querySelectorAll(".tick").forEach((t) => t.classList.toggle("locked", Number(t.dataset.i) > ceiling));

  chrome.storage.local.get({ model: MODELS[0] }, (cfg) => {
    const pos = Math.min(Math.max(0, MODELS.indexOf(cfg.model)), ceiling);
    slider.value = String(pos);
    paintSlider(pos);
    // A stale paid choice must not sit in storage looking active after a
    // downgrade — the widgets read this same value. Only on a REAL answer: a
    // provisional free (server unreachable, worker restarting) must not
    // overwrite the stop a tester or subscriber actually chose.
    if (MODELS[pos] !== cfg.model && !account.provisional) chrome.storage.local.set({ model: MODELS[pos] });
  });
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
        ? "You're signed in on the free plan. Upgrading unlocks the smarter models everywhere Tracely runs."
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
    if (r?.ok) account = { configured: Boolean(r.configured), signedIn: Boolean(r.signedIn), plan: r.plan ?? "free", email: r.email ?? null, userId: r.userId ?? null, unenforced: Boolean(r.unenforced), beta: r.beta === true, provisional: r.provisional === true };
  } catch { /* worker restarting — keep the last answer */ }
  renderAccount();
  applyPlanState();
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
  refreshAccount(); // sets the slider position too, once the ceiling is known
}

/* Any key a previous build stored is removed on load rather than left sitting
   in chrome.storage. Nothing reads it now, so keeping it would only mean an
   OpenAI credential living on in every existing install with no screen that
   can show or clear it. */
chrome.storage.local.remove("apiKey");

$("modelSlider").addEventListener("input", () => {
  const ceiling = maxStop();
  const pos = Math.min(Number($("modelSlider").value), ceiling);
  if (Number($("modelSlider").value) > ceiling) $("modelSlider").value = String(ceiling);
  paintSlider(pos);
  chrome.storage.local.set({ model: MODELS[pos] ?? MODELS[0] });
});

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
