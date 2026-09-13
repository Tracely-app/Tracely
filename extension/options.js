/* Tracely options page — the account (sign in, plan, upgrade), an API key +
   model for standalone mode, the per-site auto-check list, and a live probe of
   the local server.

   The sign-in itself lives in the background worker (it holds the token and
   the Supabase constants); this page only sends it messages. */
"use strict";

const SERVER = "http://localhost:4477";
const ORDER_URL = "https://jointracely.com/order";
const $ = (id) => document.getElementById(id);

/* ── Faster ↔ Smarter slider ↔ model mapping ─────────────────────────────── */

/* Mirrors lib/llm.js MODEL_TIERS and extension/background.js. The notes are
   written around what the stop DOES rather than which model is behind it, so
   the next model rename is one line here and no copy edits. */
const MODELS = ["gpt-5-nano", "gpt-5.4", "gpt-6-astra"];
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

   Two flags open every stop, because in both the server has already decided
   there is no plan to apply:
   • `byoKey` — standalone mode. The user's own OpenAI key pays OpenAI
     directly, so there is nothing of ours to meter.
   • `unenforced` — the local server reported `enforced: false`: no Supabase
     project is configured, so it clamps nothing. Showing an upgrade prompt
     against a server that will serve the top model on request would be a
     lie. */

const PLAN_MAX_STOP = { free: 0, student: 1, pro: 2 };
const PLAN_LABEL = { free: "Free", student: "Student", pro: "Pro" };

let account = { configured: false, signedIn: false, plan: "free", email: null, byoKey: false, unenforced: false };

function maxStop() {
  if (account.byoKey || account.unenforced) return MODELS.length - 1;
  return PLAN_MAX_STOP[account.plan] ?? 0; // unknown plan is free, always
}

function sliderHint() {
  if (account.byoKey) return "Your own API key is paying OpenAI directly, so every stop is open.";
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
    // downgrade — the widgets read this same value.
    if (MODELS[pos] !== cfg.model) chrome.storage.local.set({ model: MODELS[pos] });
  });
}

function renderAccount() {
  const signedIn = account.signedIn;
  $("signedIn").hidden = !signedIn;
  $("signedOut").hidden = signedIn;

  if (!account.configured) {
    $("acctHint").textContent = "This build has no Tracely accounts configured, so everything runs on the free tier — or on your own API key below, which has no limits at all.";
    $("signIn").disabled = true;
    return;
  }
  $("signIn").disabled = false;

  if (signedIn) {
    $("acctEmail").textContent = account.email ?? "Signed in";
    const label = PLAN_LABEL[account.plan] ?? PLAN_LABEL.free;
    $("acctPlan").textContent = label;
    $("acctPlan").className = account.plan === "free" ? "plan" : "plan paid";
    $("manageLink").textContent = account.plan === "free" ? "Upgrade" : "Manage subscription";
    $("acctHint").textContent = account.plan === "free"
      ? "You're signed in on the free plan. Upgrading unlocks the smarter models everywhere Tracely runs."
      : "Your plan applies to the extension and the Tracely desktop app — one account covers both.";
  } else {
    $("acctHint").textContent = "Sign in to use the plan you pay for. Not required: without an account Tracely runs on the free tier, and an API key below skips accounts entirely.";
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
    if (r?.ok) account = { configured: Boolean(r.configured), signedIn: Boolean(r.signedIn), plan: r.plan ?? "free", email: r.email ?? null, byoKey: Boolean(r.byoKey), unenforced: Boolean(r.unenforced) };
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
  chrome.storage.local.get({ apiKey: "", enabledSites: [] }, (cfg) => {
    $("apiKey").value = cfg.apiKey;
    renderSites(cfg.enabledSites);
  });
  refreshAccount(); // sets the slider position too, once the ceiling is known
}

let savedTimer = null;
function flashSaved(text) {
  $("keySaved").textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $("keySaved").textContent = ""; }, 2500);
}

$("saveKey").addEventListener("click", () => {
  const apiKey = $("apiKey").value.trim();
  chrome.storage.local.set({ apiKey }, () => {
    flashSaved(apiKey ? "Saved — standalone mode is ready when the server is off." : "Key removed — Tracely will use the local server only.");
    probe(); // status line may change wording now that a key is (un)set
    refreshAccount(); // a key can open the slider (standalone bills the user, not us)
  });
});
$("apiKey").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("saveKey").click();
});

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
  try {
    const res = await fetch(`${SERVER}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json().catch(() => ({}));
    wrap.className = "status on";
    text.textContent = s.docsBridge
      ? "Local server: online — all features, Docs write-back ready"
      : "Local server: online — all features (web-search sources, URL citing)";
    noteServerState(true);
  } catch {
    chrome.storage.local.get({ apiKey: "" }, (cfg) => {
      wrap.className = "status off";
      text.textContent = cfg.apiKey
        ? "Local server: offline — standalone mode active (your API key, checks + sources)"
        : "Local server: offline — add an API key above to use Tracely standalone";
      noteServerState(false);
    });
  }
}

// The honour-system Pro code this replaced. Dropping the key is the whole
// migration: whoever typed one is a free user until they sign in, which is
// the correct answer — it never entitled them to anything.
chrome.storage.local.remove("proCode");

load();
probe();
setInterval(probe, 4000);
