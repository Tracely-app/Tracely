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
    blurb: "No daily check limit, 100 source searches a month and auto-sources for one writer." },
  { key: "pro", product: "Tracely Pro", cents: 999, env: "STRIPE_PRICE_PRO",
    blurb: "Everything in Student plus Thorough explanations from Tracely's largest model and 250 source searches a month." },
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
  const qs = new URL(`https://api.stripe.com/v1/${path}`);
  const opts = { method, headers: { Authorization: `Bearer ${KEY}` } };

  /* A GET carries its parameters in the QUERY STRING and must not have a body.
   * An earlier version built the form body first and attached it regardless of
   * method; fetch rejects that outright with "Request with GET/HEAD method
   * cannot have body." Every existence check therefore threw before reaching
   * Stripe, the caller read that as "nothing exists", and the script created
   * duplicate products in a LIVE account.
   *
   * It survived the test suite because the stub replaced globalThis.fetch with
   * a function that ignored the body — a stub more permissive than the real
   * API, which is a stub that certifies bugs. The stub now enforces this. */
  if (params) {
    if (method === "GET") {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.searchParams.set(k, String(v));
      }
    } else {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x, i) => body.append(`${k}[${i}]`, String(x)));
        else if (v !== undefined && v !== null) body.append(k, String(v));
      }
      opts.body = body;
    }
  }
  const res = await fetch(qs, opts);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw Object.assign(new Error(safeMsg(json.error)), { code: json.error.code, status: res.status });
  return json;
}
const get = (p, q) => api("GET", p, q);
const post = (p, b) => api("POST", p, b);

/* A create-if-missing script must never treat "I could not check" as "it does
 * not exist". An earlier version answered a failed list call with { data: [] },
 * and on a key with write-but-not-read scope that turned idempotency into
 * DUPLICATION: it re-created products and prices that were already there, in a
 * live account. Reads are now fatal, and they all happen before any write. */
async function mustRead(path, params, scopeName) {
  try {
    return await get(path, params);
  } catch (e) {
    console.log(r(`\nCannot read ${scopeName.toLowerCase()}: ${e.message}`));
    console.log(`\nThis key can write but not read ${scopeName}. That combination is`);
    console.log("dangerous here: without reading, the script cannot tell what already");
    console.log("exists and would create a SECOND copy of everything.");
    console.log(`\nAdd READ scope for ${scopeName} to the restricted key and re-run.`);
    console.log("Nothing was created by this run.\n");
    process.exit(3);
  }
}

const plan = [];   // what --apply would do
const done = [];   // what already existed or was created
const manual = []; // what the API cannot reach

function note(kind, line) {
  (kind === "plan" ? plan : kind === "done" ? done : manual).push(line);
}

/* A failure partway through leaves real objects behind. The script is written
 * to resume, but a bare stack trace does not tell you that — and "did it half
 * create something?" is exactly the question you do not want to answer by
 * clicking around a live account. */
const explainPartial = (err) => {
  console.error(`\n\x1b[31mFailed partway through.\x1b[0m ${err?.message ?? err}`);
  console.error("\nAnything already created above is kept. This script is idempotent:");
  console.error("re-run the same command and it reuses what exists rather than duplicating.\n");
  process.exit(1);
};
// A throw out of top-level await surfaces as uncaughtException, not
// unhandledRejection — registering only the latter printed a raw stack trace
// and told the operator nothing about whether half an account had been built.
process.on("uncaughtException", explainPartial);
process.on("unhandledRejection", explainPartial);

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
let TAX_ON = false;
try {
  const t = await get("tax/settings");
  TAX_ON = Boolean(t?.defaults?.tax_behavior) || t?.status === "active";
  const behavior = t?.defaults?.tax_behavior;
  if (behavior && behavior !== "inferred_by_currency") {
    console.log(g(`Tax default already set: ${behavior}`));
  } else {
    note("manual", "Settings > Tax: set the default tax behavior and a SaaS/digital product tax code. Do it BEFORE --apply: a price's tax_behavior cannot be changed later.");
  }
} catch {
  // Cannot tell whether Tax is on. Assume it IS: the cost of assuming wrongly
  // is one extra flag on the command line; the cost of assuming the other way
  // is products created that no Payment Link can use.
  TAX_ON = true;
  note("manual", "Settings > Tax: confirm the account default tax behavior (this key cannot read Tax settings).");
}

/* Stripe Tax, once enabled, refuses to build a Payment Link for a product with
 * no tax_code: "Invalid line_items[0]: the product tax code is missing". The
 * products create fine without one, so the failure lands two steps later, on
 * an account that already has objects in it.
 *
 * The id is LOOKED UP rather than hardcoded. Stripe's catalogue has several
 * plausible SaaS codes and guessing the wrong one is a tax decision, not a
 * formatting one — and a hardcoded id that gets retired fails the same way
 * this did. Preference order matches what Tracely actually is: a subscription
 * to a hosted service used by individuals. */
async function resolveTaxCode() {
  // An explicit code wins: it is the escape hatch when the key cannot read
  // /v1/tax_codes, and it keeps the choice the operator's rather than a guess.
  const forced = (process.env.TRACELY_TAX_CODE ?? "").trim();
  if (forced) return { id: forced, name: "supplied via TRACELY_TAX_CODE" };
  let codes;
  try {
    codes = (await get("tax_codes", { limit: 100 })).data ?? [];
  } catch {
    return null; // no Tax scope on the key; caller degrades gracefully
  }
  const pick = (re) => codes.find((c) => re.test(c.name) || re.test(c.description ?? ""));
  const chosen =
    pick(/software as a service.*personal/i) ||
    pick(/software as a service/i) ||
    pick(/\bSaaS\b/i) ||
    pick(/electronically supplied services/i) ||
    pick(/digital (goods|services)/i);
  return chosen ?? null;
}

// ── 2. products and prices ──────────────────────────────────────────────
console.log("\nProducts and prices");
const taxCode = await resolveTaxCode();
if (taxCode) {
  console.log(`  tax code: ${taxCode.id} — ${taxCode.name}`);
} else if (TAX_ON) {
  /* Stripe Tax is enabled, so Payment Links WILL reject a product without a
   * tax code. Creating products first and discovering that two steps later is
   * how this script previously left half-built objects behind — so it stops
   * before writing anything instead. */
  console.log(r("\n  No tax code could be resolved, and Stripe Tax is enabled on this account."));
  console.log("  Payment Links reject a product with no tax code, so creating the");
  console.log("  products now would fail two steps later and leave them behind.\n");
  console.log("  Either add READ scope for Tax to the key, or pass the code directly:");
  console.log("      TRACELY_TAX_CODE=txcd_10103001 sh scripts/stripe-setup.sh --apply");
  console.log("  (txcd_10103001 is Stripe's 'Software as a service (SaaS) - personal use';");
  console.log("   confirm the right one for you at stripe.com/docs/tax/tax-codes)\n");
  console.log("  Nothing was created by this run.\n");
  process.exit(4);
}
const priceIds = {};
const existingProducts = await mustRead("products", { limit: 100, active: "true" }, "Products");
const existingPrices = await mustRead("prices", { limit: 100, active: "true" }, "Prices");

for (const p of PLANS) {
  let product = (existingProducts.data ?? []).find((x) => x.name === p.product);
  let price = (existingPrices.data ?? []).find((x) =>
    x.unit_amount === p.cents && x.currency === "usd" &&
    x.recurring?.interval === "month" && x.recurring?.interval_count === 1 &&
    (product ? x.product === product.id : false));

  /* The tax-code backfill has to happen BEFORE the early return for an
     existing price. A run that created the products and then failed at the
     Payment Link step leaves exactly that state — product and price present,
     tax code absent — and skipping the backfill makes the SECOND run fail
     identically to the first. Which it did. */
  if (product && taxCode && !product.tax_code) {
    if (APPLY) {
      await post(`products/${product.id}`, { tax_code: taxCode.id });
      console.log(`  ${g("updated")}  ${p.product} — added tax code ${taxCode.id}`);
      product.tax_code = taxCode.id;
    } else {
      note("plan", `add tax code ${taxCode.id} to the existing product "${p.product}" (Payment Links reject a product without one)`);
      console.log(`  ${y("would update")}  ${p.product} — missing tax code`);
    }
  }

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
    const body = { name: p.product, description: p.blurb };
    if (taxCode) body.tax_code = taxCode.id;
    product = await post("products", body);
    console.log(`  ${g("created")}  product ${p.product} — ${product.id}${taxCode ? ` (tax code ${taxCode.id})` : ""}`);
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
/* The one genuinely optional step. The portal's shareable LOGIN LINK is
 * Dashboard-only whatever happens, so that screen has to be visited either
 * way — which means a key that cannot reach this resource should print an
 * instruction rather than abort a run that has already done everything else. */
let cfgs = null;
let portalReadable = true;
try {
  cfgs = await get("billing_portal/configurations", { limit: 10 });
} catch (e) {
  portalReadable = false;
  console.log(y(`  skipped — this key cannot reach portal configurations (${e.message})`));
  note("manual", "Billing > Customer portal: turn ON 'Cancel subscriptions' with mode 'at end of billing period', turn ON 'Switch plan' listing both prices, leave 'Manage downgrades' OFF, then 'Ways to get started' > Activate link and put the https://billing.stripe.com/p/login/... URL into PORTAL_URL in extension/options.js.");
}
const active = (cfgs?.data ?? []).find((c) => c.active && c.is_default);
const wantSwitch = Object.values(priceIds).filter(Boolean);
if (!portalReadable) {
  // nothing to do here; the manual note above carries it
} else if (active?.features?.subscription_cancel?.enabled) {
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
