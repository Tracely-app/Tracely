/**
 * Read-only audit of a Stripe account against what Tracely's server expects.
 *
 * Run it through scripts/check-stripe-setup.sh, which prompts for the key with
 * echo disabled and passes it in the ENVIRONMENT rather than argv — argv is
 * visible in `ps` to every user on the box.
 *
 * Every call here is a GET. It creates nothing, changes nothing, and charges
 * nothing, so a restricted key with read scopes is enough — and a read-only
 * key is the only kind worth having on a laptop. Missing scopes are reported
 * per check rather than failing the run, because a narrow key is the right
 * key and should not look like a broken one.
 *
 * The key is never printed, logged, or written anywhere.
 */
const KEY = (process.env.STRIPE_KEY ?? "").trim();
if (!KEY) {
  console.error("No key supplied. Run scripts/check-stripe-setup.sh instead of this file directly.");
  process.exit(1);
}

const LIVE = KEY.startsWith("sk_live") || KEY.startsWith("rk_live");
const MODE = LIVE ? "LIVE" : "TEST";

// What the server and the pricing page agree on. Student is advertised as 50%
// off $10, so $4.99 is the charge and the $10 is display only — a $10 price
// would be a real overcharge.
const WANT = {
  student: { cents: 499, label: "Student" },
  pro: { cents: 999, label: "Pro" },
};
const WEBHOOK_PATH = "/api/billing/webhook";
const WANT_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

const ok = (s) => `  \x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `  \x1b[31mFIX\x1b[0m   ${s}`;
const warn = (s) => `  \x1b[33m?\x1b[0m     ${s}`;
const skip = (s) => `  -     ${s}`;

/* Stripe echoes a partially-masked key back inside some error messages
 * ("Invalid API Key provided: rk_live_****0000"). Masked is not the same as
 * absent, and this output gets pasted into chats and issues, so no error
 * string containing a key prefix is ever printed. */
function safeMsg(error) {
  const raw = String(error?.message ?? "");
  return /\b[sprk]k_(live|test)_/.test(raw) ? (error?.code || "rejected by Stripe") : raw.slice(0, 90);
}

async function get(path, params = {}) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    denials++;
    return { error: json.error, status: res.status };
  }
  reads++;
  return { data: json };
}

const findings = [];
let reads = 0;   // how many checks actually got an answer
let denials = 0; // how many were refused outright
const push = (line, blocking = false) => findings.push({ line, blocking });

console.log(`\nTracely Stripe audit — ${MODE} mode`);
console.log("=".repeat(52));

// ── account: can it actually take money ──────────────────────────────────
console.log("\nAccount");
{
  const { data, error } = await get("account");
  if (error) {
    push(error.code === "api_key_expired" ? bad("the key was revoked — roll it and re-run") : skip(`account: ${safeMsg(error)}`), false);
    console.log(findings.at(-1).line);
  } else {
    console.log(data.charges_enabled ? ok("charges enabled") : bad("charges are NOT enabled — no card can be charged yet"));
    if (!data.charges_enabled) push(bad("enable charges: Dashboard > complete the account activation form"), true);
    console.log(data.payouts_enabled ? ok("payouts enabled") : warn("payouts not enabled — you can charge but not get paid yet"));
    const sd = data.settings?.card_payments?.statement_descriptor || data.settings?.payments?.statement_descriptor;
    if (sd) console.log(ok(`statement descriptor: "${sd}"`));
    else {
      console.log(bad("no statement descriptor — buyers see an unrecognisable line and dispute it"));
      push(bad('set a statement descriptor (Settings > Business > Public details) to something like "TRACELY"'), true);
    }
  }
}

// ── products and prices ──────────────────────────────────────────────────
console.log("\nPrices");
const priceIds = {};
{
  const { data, error } = await get("prices", { limit: 100, active: "true", "expand[]": "data.product" });
  if (error) {
    console.log(skip(`prices unreadable (${safeMsg(error)})`));
    push(skip("could not read prices — key may lack the Prices read scope"), false);
  } else {
    const live = (data.data ?? []).filter((p) => p.livemode === LIVE);
    for (const [plan, want] of Object.entries(WANT)) {
      const match = live.find((p) =>
        p.unit_amount === want.cents && p.currency === "usd" &&
        p.recurring?.interval === "month" && p.recurring?.interval_count === 1);
      if (match) {
        priceIds[plan] = match.id;
        const name = typeof match.product === "object" ? match.product.name : match.product;
        console.log(ok(`${want.label} $${(want.cents / 100).toFixed(2)}/mo — ${match.id} (${name})`));
      } else {
        const nearMiss = live.find((p) => p.unit_amount === want.cents && p.currency === "usd");
        if (nearMiss) {
          console.log(bad(`${want.label} $${(want.cents / 100).toFixed(2)} exists (${nearMiss.id}) but is NOT monthly recurring`));
          push(bad(`recreate the ${want.label} price as recurring/monthly — a one-off price charges once and never renews`), true);
        } else {
          console.log(bad(`no ${want.label} price at $${(want.cents / 100).toFixed(2)}/mo USD`));
          push(bad(`create product "Tracely ${want.label}" with a recurring monthly USD price of $${(want.cents / 100).toFixed(2)}`), true);
        }
      }
    }
    const tenDollar = live.find((p) => p.unit_amount === 1000 && p.currency === "usd");
    if (tenDollar) console.log(warn(`a $10.00 price exists (${tenDollar.id}) — the site shows $10 only as the struck-through "was" price; do not sell it`));
  }
}

// ── payment links ────────────────────────────────────────────────────────
console.log("\nPayment Links");
{
  const { data, error } = await get("payment_links", { limit: 100 });
  if (error) {
    console.log(skip(`payment links unreadable (${safeMsg(error)})`));
  } else {
    const live = (data.data ?? []).filter((l) => l.livemode === LIVE && l.active);
    if (!live.length) {
      console.log(bad("no active Payment Links — the order page buttons have nothing to open"));
      push(bad("create one Payment Link per price (Payment Links > New), then paste both URLs into order.html STRIPE_LINKS"), true);
    } else {
      for (const l of live) console.log(ok(`${l.url}`));
      if (live.length < 2) push(bad(`only ${live.length} Payment Link — you need one for Student and one for Pro`), true);
      console.log(skip("check each link is in SUBSCRIPTION mode and that 'client reference ID' passthrough is not blocked"));
    }
  }
}

// ── webhook ──────────────────────────────────────────────────────────────
console.log("\nWebhook");
{
  const { data, error } = await get("webhook_endpoints", { limit: 100 });
  if (error) {
    console.log(skip(`webhook endpoints unreadable (${safeMsg(error)})`));
  } else {
    const live = (data.data ?? []).filter((w) => w.livemode === LIVE);
    const mine = live.find((w) => String(w.url).includes(WEBHOOK_PATH));
    if (!mine) {
      console.log(bad(`no endpoint pointed at ${WEBHOOK_PATH}`));
      push(bad(`after the server is reachable, add a webhook for https://api.jointracely.com${WEBHOOK_PATH}`), true);
      push(bad("then put its whsec_... signing secret in the server's .env as STRIPE_WEBHOOK_SECRET (it differs per endpoint AND between test and live)"), true);
    } else {
      console.log(ok(`${mine.url} (${mine.status})`));
      const have = new Set(mine.enabled_events ?? []);
      const missing = WANT_EVENTS.filter((e) => !have.has(e) && !have.has("*"));
      if (missing.length) {
        console.log(bad(`missing events: ${missing.join(", ")}`));
        push(bad(`add these webhook events: ${missing.join(", ")}`), true);
      } else {
        console.log(ok("all four required events subscribed"));
      }
      if (mine.status !== "enabled") push(bad(`the webhook endpoint is "${mine.status}" — enable it`), true);
    }
  }
}

// ── customer portal: the promised cancel path ────────────────────────────
console.log("\nCustomer portal (the FAQ promises one-click cancel)");
{
  const { data, error } = await get("billing_portal/configurations", { limit: 10 });
  if (error) {
    console.log(skip(`portal config unreadable (${safeMsg(error)})`));
    push(skip("could not read the portal config — verify it by hand in Billing > Customer portal"), false);
  } else {
    const active = (data.data ?? []).filter((c) => c.active && c.livemode === LIVE);
    const canCancel = active.some((c) => c.features?.subscription_cancel?.enabled);
    if (!active.length) {
      console.log(bad("no active customer portal configuration"));
      push(bad("configure Billing > Customer portal, enable 'Cancel subscriptions', and copy the shareable login link into PORTAL_URL in extension/options.js"), true);
    } else if (!canCancel) {
      console.log(bad("portal exists but subscription cancellation is DISABLED"));
      push(bad("turn on 'Cancel subscriptions' in Billing > Customer portal — the public FAQ promises it"), true);
    } else {
      console.log(ok("portal active with cancellation enabled"));
      console.log(skip("copy the shareable login link into PORTAL_URL in extension/options.js"));
    }
  }
}

// ── what to paste ────────────────────────────────────────────────────────
if (Object.keys(priceIds).length) {
  console.log("\nPaste into the server's .env");
  if (priceIds.student) console.log(`  STRIPE_PRICE_STUDENT=${priceIds.student}`);
  if (priceIds.pro) console.log(`  STRIPE_PRICE_PRO=${priceIds.pro}`);
}

// ── summary ──────────────────────────────────────────────────────────────
const blockers = findings.filter((f) => f.blocking);
console.log("\n" + "=".repeat(52));
if (reads === 0) {
  // Every call was refused. Reporting "looks ready" here was the worst
  // possible output: an invalid or unscoped key would have read as a pass.
  console.log("Could not read ANYTHING from Stripe — every call was refused.");
  console.log("Either the key is invalid/rolled, or it is a restricted key with no read scopes.");
  console.log("Nothing above was verified. Fix the key and re-run.\n");
  process.exit(2);
}
if (denials > 0) console.log(`(${denials} check(s) could not be read — a restricted key may simply lack those scopes.)\n`);
if (!blockers.length) {
  console.log(`${MODE} mode looks ready. Rehearse one real payment before announcing.`);
} else {
  console.log(`${blockers.length} thing(s) block the first real charge:\n`);
  for (const f of blockers) console.log(f.line);
}
if (!LIVE) console.log("\nThis was a TEST-mode key. Re-run with a live key before launch — test objects do not carry over.");
console.log();
