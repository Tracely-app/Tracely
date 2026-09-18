/**
 * Creates Tracely's Stripe billing objects, idempotently.
 *
 * Run through scripts/stripe-setup.sh, which prompts for the key with echo
 * disabled and passes it in the ENVIRONMENT rather than argv (argv is visible
 * in `ps`). The key is never printed, logged, or written anywhere.
 *
 * DRY RUN BY DEFAULT. It prints exactly what it would create and changes
 * nothing until you pass --apply. Re-running with --apply is safe: every step
 * looks for an existing object first and reuses it, so a half-finished run
 * resumes instead of duplicating. Duplicate live products with different
 * price ids is the specific mess this guards against — Stripe's own
 * "Copy to live mode" will do it to you silently.
 *
 * Use a RESTRICTED key with write scopes on exactly: Products, Prices,
 * Payment Links, Webhook endpoints, Billing portal configurations. Not an
 * sk_live. Nothing here needs charge, refund, payout or customer access.
 *
 * What it cannot do, because Stripe's API does not expose it for your own
 * platform account: the statement descriptor, public business details, and
 * receipt emails. Those are printed as a short manual list at the end.
 */
const KEY = (process.env.STRIPE_KEY ?? "").trim();
const APPLY = process.argv.includes("--apply");

if (!KEY) {
  console.error("No key supplied. Run scripts/stripe-setup.sh rather than this file directly.");
  process.exit(1);
}
const LIVE = KEY.startsWith("sk_live") || KEY.startsWith("rk_live");
const MODE = LIVE ? "LIVE" : "TEST";

/* The pricing page is the source of truth: Student is advertised at $4.99 with
 * $10 shown struck through, so $4.99 is the charge and $10 must never become a
 * price object. Two SEPARATE products, not two prices on one product — the
 * customer portal's Switch plan cannot list two prices that share a product
 * and a recurring interval, and Switch plan is what stops a Student who opens
 * the Pro link being billed for both. */
const PLANS = [
  { key: "student", product: "Tracely Student", cents: 499, env: "STRIPE_PRICE_STUDENT",
    blurb: "Unlimited checking and sources for one writer." },
  { key: "pro", product: "Tracely Pro", cents: 999, env: "STRIPE_PRICE_PRO",
    blurb: "Tracely's most thorough checking, everywhere." },
];
const WEBHOOK_URL = "https://api.jointracely.com/api/billing/webhook";
// Four, not three. lib/billing.js:174 handles customer.subscription.created
// even though BILLING.md's prose lists only three.
const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;

function safeMsg(e) {
  const m = String(e?.message ?? "");
  return /\b[sprk]k_(live|test)_/.test(m) ? (e?.code || "rejected by Stripe") : m.slice(0, 140);
}

async function api(method, path, params) {
  const url = `https://api.stripe.com/v1/${path}`;
  const opts = { method, headers: { Authorization: `Bearer ${KEY}` } };
  if (params) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x, i) => body.append(`${k}[${i}]`, String(x)));
      else if (v !== undefined && v !== null) body.append(k, String(v));
    }
    opts.body = body;
  }
  const res = await fetch(method === "GET" && params ? `${url}?${new URLSearchParams(params)}` : url, opts);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw Object.assign(new Error(safeMsg(json.error)), { code: json.error.code, status: res.status });
  return json;
}
const get = (p, q) => api("GET", p, q);
const post = (p, b) => api("POST", p, b);

const plan = [];   // what --apply would do
const done = [];   // what already existed or was created
const manual = []; // what the API cannot reach

function note(kind, line) {
  (kind === "plan" ? plan : kind === "done" ? done : manual).push(line);
}

console.log(`\nTracely Stripe setup — ${MODE} mode${APPLY ? "" : "  (DRY RUN — nothing will change)"}`);
console.log("=".repeat(62));

// ── 0. can this key do the job at all ───────────────────────────────────
let acct;
try {
  acct = await get("account");
} catch (e) {
  console.log(r(`\nCannot read the account: ${e.message}`));
  console.log("The key is invalid, rolled, or lacks even read scope. Nothing was attempted.\n");
  process.exit(2);
}
if (!acct.charges_enabled) {
  console.log(r("\nThis account cannot accept charges yet."));
  console.log("Finish activation in the Dashboard first — creating prices against an");
  console.log("unactivated account produces objects you cannot sell.\n");
  process.exit(2);
}
console.log(g("\nAccount can accept charges") + (acct.payouts_enabled ? g(" and receive payouts") : y(" but payouts are NOT enabled")));

// ── 1. tax behaviour, before any price exists ───────────────────────────
/* A price's tax_behavior is IMMUTABLE once set to inclusive or exclusive.
 * Leaving each price unset and letting the account default govern keeps this a
 * settings change forever; baking it in means new price ids, re-edited links
 * and re-edited .env if you change your mind. */
try {
  const t = await get("tax/settings");
  const behavior = t?.defaults?.tax_behavior;
  if (behavior && behavior !== "inferred_by_currency") {
    console.log(g(`Tax default already set: ${behavior}`));
  } else {
    note("manual", "Settings > Tax: set the default tax behavior and a SaaS/digital product tax code. Do it BEFORE --apply: a price's tax_behavior cannot be changed later.");
  }
} catch {
  note("manual", "Settings > Tax: confirm the account default tax behavior (key lacks Tax read scope, so this could not be checked).");
}

// ── 2. products and prices ──────────────────────────────────────────────
console.log("\nProducts and prices");
const priceIds = {};
const existingProducts = await get("products", { limit: 100, active: "true" }).catch(() => ({ data: [] }));
const existingPrices = await get("prices", { limit: 100, active: "true" }).catch(() => ({ data: [] }));

for (const p of PLANS) {
  let product = (existingProducts.data ?? []).find((x) => x.name === p.product);
  let price = (existingPrices.data ?? []).find((x) =>
    x.unit_amount === p.cents && x.currency === "usd" &&
    x.recurring?.interval === "month" && x.recurring?.interval_count === 1 &&
    (product ? x.product === product.id : false));

  if (price) {
    priceIds[p.env] = price.id;
    console.log(`  ${g("exists")}  ${p.product} $${(p.cents / 100).toFixed(2)}/mo — ${price.id}`);
    continue;
  }
  if (!APPLY) {
    note("plan", `create product "${p.product}"${product ? " (product already exists, price missing)" : ""} + a recurring monthly USD price of $${(p.cents / 100).toFixed(2)}`);
    console.log(`  ${y("would create")}  ${p.product} $${(p.cents / 100).toFixed(2)}/mo`);
    continue;
  }
  if (!product) {
    product = await post("products", { name: p.product, description: p.blurb });
    console.log(`  ${g("created")}  product ${p.product} — ${product.id}`);
  }
  // tax_behavior deliberately omitted: the account default governs, and that
  // stays changeable. See the note above.
  price = await post("prices", {
    product: product.id, currency: "usd", unit_amount: p.cents,
    "recurring[interval]": "month", "recurring[interval_count]": 1,
  });
  priceIds[p.env] = price.id;
  console.log(`  ${g("created")}  price $${(p.cents / 100).toFixed(2)}/mo — ${price.id}`);
}

// ── 3. payment links ────────────────────────────────────────────────────
console.log("\nPayment Links");
const existingLinks = await get("payment_links", { limit: 100 }).catch(() => ({ data: [] }));
const linkUrls = {};
for (const p of PLANS) {
  const pid = priceIds[p.env];
  if (!pid) {
    // In a dry run the price does not exist yet, so there is nothing to match
    // a link against. Saying "skipped" here made the dry run UNDER-REPORT:
    // the plan list never mentioned the links at all, so you could approve a
    // run without knowing it would create them.
    if (!APPLY) {
      note("plan", `create a Payment Link for ${p.product} (after its price exists)`);
      console.log(`  ${y("would create")}  ${p.product} — after its price`);
    } else {
      console.log(`  ${y("skipped")}  ${p.product} — price creation failed above`);
    }
    continue;
  }
  const found = (existingLinks.data ?? []).find((l) => l.active && (l.line_items?.data ?? []).some((li) => li.price?.id === pid));
  if (found) { linkUrls[p.key] = found.url; console.log(`  ${g("exists")}  ${p.product} — ${found.url}`); continue; }
  if (!APPLY) { note("plan", `create a Payment Link for ${p.product}`); console.log(`  ${y("would create")}  ${p.product}`); continue; }
  const link = await post("payment_links", {
    "line_items[0][price]": pid, "line_items[0][quantity]": 1,
    // Metadata carries the PRICE, never a user id: a link's metadata is one
    // static value copied onto every session, so a user id there would map
    // every paying customer onto one account.
    "metadata[price_id]": pid,
    "after_completion[type]": "redirect",
    "after_completion[redirect][url]": "https://jointracely.com/order?paid=1",
  });
  linkUrls[p.key] = link.url;
  console.log(`  ${g("created")}  ${p.product} — ${link.url}`);
}

// ── 4. webhook ──────────────────────────────────────────────────────────
console.log("\nWebhook");
let whsec = null;
const existingHooks = await get("webhook_endpoints", { limit: 100 }).catch(() => ({ data: [] }));
const hook = (existingHooks.data ?? []).find((w) => w.url === WEBHOOK_URL);
if (hook) {
  const missing = EVENTS.filter((e) => !(hook.enabled_events ?? []).includes(e) && !(hook.enabled_events ?? []).includes("*"));
  if (missing.length && APPLY) {
    await post(`webhook_endpoints/${hook.id}`, { enabled_events: [...new Set([...(hook.enabled_events ?? []), ...EVENTS])] });
    console.log(`  ${g("updated")}  added ${missing.join(", ")}`);
  } else if (missing.length) {
    note("plan", `add missing webhook events: ${missing.join(", ")}`);
    console.log(`  ${y("would update")}  missing ${missing.join(", ")}`);
  } else {
    console.log(`  ${g("exists")}  ${hook.url} (${hook.status}) with all four events`);
  }
  note("manual", "The signing secret is only shown at creation. Reveal it at Developers > Webhooks > this endpoint > Signing secret, and put it in the server's .env as STRIPE_WEBHOOK_SECRET.");
} else if (!APPLY) {
  note("plan", `create the webhook endpoint at ${WEBHOOK_URL} with all four events`);
  console.log(`  ${y("would create")}  ${WEBHOOK_URL}`);
} else {
  const made = await post("webhook_endpoints", { url: WEBHOOK_URL, enabled_events: EVENTS, description: "Tracely plan sync" });
  whsec = made.secret ?? null;
  console.log(`  ${g("created")}  ${made.url}`);
}

// ── 5. customer portal ──────────────────────────────────────────────────
console.log("\nCustomer portal (the cancel path)");
const cfgs = await get("billing_portal/configurations", { limit: 10 }).catch(() => ({ data: [] }));
const active = (cfgs.data ?? []).find((c) => c.active && c.is_default);
const wantSwitch = Object.values(priceIds).filter(Boolean);
if (active?.features?.subscription_cancel?.enabled) {
  console.log(`  ${g("exists")}  cancellation enabled (${active.id})`);
} else if (!APPLY) {
  note("plan", "configure the customer portal with cancellation at period end and plan switching");
  console.log(`  ${y("would configure")}  cancel at period end, switch plan on, manage downgrades OFF`);
} else {
  const body = {
    "features[customer_update][enabled]": "true",
    "features[customer_update][allowed_updates]": undefined,
    "features[customer_update][allowed_updates][0]": "email",
    "features[customer_update][allowed_updates][1]": "address",
    "features[invoice_history][enabled]": "true",
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    // At period end, matching both lib/billing.js's entitlement logic and the
    // pricing-page copy ("you keep access until the end of the billing period").
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_cancel][cancellation_reason][enabled]": "true",
    "features[subscription_cancel][cancellation_reason][options][0]": "too_expensive",
    "features[subscription_cancel][cancellation_reason][options][1]": "missing_features",
    "features[subscription_cancel][cancellation_reason][options][2]": "unused",
    "features[subscription_cancel][cancellation_reason][options][3]": "other",
    "business_profile[headline]": "Manage your Tracely subscription",
  };
  // Switch plan needs both products listed. Manage downgrades is left OFF
  // deliberately: enabling it attaches a subscription schedule, and a customer
  // with a scheduled update CANNOT cancel until it resolves — which would
  // silently revoke the cancel path the pricing page promises.
  if (wantSwitch.length === 2) {
    body["features[subscription_update][enabled]"] = "true";
    body["features[subscription_update][default_allowed_updates][0]"] = "price";
    body["features[subscription_update][proration_behavior]"] = "create_prorations";
    wantSwitch.forEach((pid, i) => {
      body[`features[subscription_update][products][${i}][product]`] = (existingPrices.data ?? []).find((x) => x.id === pid)?.product
        ?? (existingProducts.data ?? []).find((x) => x.name === PLANS[i].product)?.id;
      body[`features[subscription_update][products][${i}][prices][0]`] = pid;
    });
  }
  const cfg = await post("billing_portal/configurations", body);
  console.log(`  ${g("created")}  ${cfg.id}`);
  note("manual", "Billing > Customer portal > 'Ways to get started' > Activate link, then copy the https://billing.stripe.com/p/login/... URL into PORTAL_URL in extension/options.js. The login link is Dashboard-only; the API configures the portal but does not mint that URL.");
}

// ── output ──────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(62));
if (!APPLY) {
  if (!plan.length) {
    console.log(g("Nothing to do — everything this script manages already exists."));
  } else {
    console.log("Would make these changes:\n");
    plan.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
    console.log("\nRe-run with --apply to make them. Safe to re-run: every step reuses");
    console.log("what already exists rather than creating a second copy.");
  }
} else {
  const envLines = Object.entries(priceIds).filter(([, v]) => v);
  if (envLines.length || whsec) {
    console.log("Paste into the server's .env:\n");
    for (const [k, v] of envLines) console.log(`  ${k}=${v}`);
    if (whsec) console.log(`  STRIPE_WEBHOOK_SECRET=${whsec}`);
    console.log("\n  ssh root@45.56.92.67   then edit /srv/tracely/app/.env");
    console.log("  It is re-read on every request, so nothing needs restarting.");
    if (whsec) console.log(r("\n  The signing secret above is shown ONCE. Save it now."));
  }
  if (linkUrls.student || linkUrls.pro) {
    console.log("\nPaste into order.html (and order/index.html) STRIPE_LINKS:\n");
    console.log(`  student: "${linkUrls.student ?? ""}",`);
    console.log(`  pro:     "${linkUrls.pro ?? ""}",`);
    console.log(y("\n  Do NOT paste these until the webhook secret is in .env."));
    console.log(y("  Until then a payment charges the card and grants nothing."));
  }
}
if (manual.length) {
  console.log("\nDashboard-only — the API cannot set these for your own account:\n");
  manual.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  console.log("  " + (manual.length + 1) + ". Settings > Public details: statement descriptor TRACELY (the prefix field is 2-10 chars, so not TRACELY.APP). An unrecognised line on a $4.99 charge is the top driver of disputes.");
  console.log("  " + (manual.length + 2) + ". Settings > Customer emails: turn receipts ON. Off by default, and per-mode.");
}
console.log("\nVerify with: sh scripts/check-stripe-setup.sh (read-only key is enough)\n");
