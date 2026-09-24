/**
 * Stripe → Supabase: turning a paid subscription into a plan on the account.
 *
 * Everything in here is either pure or a single fetch, deliberately: the
 * orchestration (raw body → verify → dedupe → resolve user → write → record)
 * lives in server.js next to the route, so this file stays loadable by a test
 * without opening the database.
 *
 * Two rules run through the whole file.
 *
 * 1. **The signature is checked over the RAW body.** JSON.parse followed by
 *    JSON.stringify produces a byte sequence Stripe never signed — key order
 *    and number formatting are not preserved — so a re-serialized body does
 *    not fail loudly, it fails *always*, and the usual debugging instinct
 *    (log the parsed event) hides the cause. The route reads the body as a
 *    string first and parses only after verifying.
 *
 * 2. **An unrecognised price is not a downgrade.** On the read path, "unknown
 *    ⇒ free" is right and fail-closed. On this write path the same rule would
 *    mean an unset STRIPE_PRICE_PRO silently revokes every Pro account the
 *    next time their subscription renews. So planForPrice answers `null` for
 *    a price it does not recognise and the caller writes nothing. A plan is
 *    only ever taken away by an event that actually says so — a deletion, or
 *    a subscription that has stopped being active.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizePlan, isPlan, DEFAULT_PLAN } from "../shared/plan.js";

/** Stripe's own recommendation, and the replay window this server accepts. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

const ADMIN_TIMEOUT_MS = 8_000;

export function webhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * Returns `{ ok }` plus a `reason` when it fails, so the route can log which
 * check failed without telling the caller (a precise rejection reason is a
 * signing oracle).
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]` — more than one v1
 * appears during a secret rotation, and rejecting the second one would break
 * exactly the deploy that is trying to be careful.
 */
export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), toleranceMs = SIGNATURE_TOLERANCE_MS } = {}) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (typeof rawBody !== "string" || typeof header !== "string" || !header) return { ok: false, reason: "malformed" };

  let timestamp = null;
  const candidates = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || candidates.length === 0) return { ok: false, reason: "malformed" };

  // Stripe's t is in SECONDS. Treating it as milliseconds makes every live
  // event look ~55 years stale and every check fail for the wrong reason.
  const ageMs = Math.abs(now - Number(timestamp) * 1000);
  if (ageMs > toleranceMs) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  for (const candidate of candidates) {
    if (!/^[0-9a-fA-F]+$/.test(candidate)) continue;
    const given = Buffer.from(candidate, "hex");
    // timingSafeEqual throws on a length mismatch, which is itself a leak-free
    // early out — but it must be a comparison we chose, not an exception.
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature" };
}

/**
 * A Stripe price id → the plan it sells, or null for a price that is not ours.
 * Env is a parameter so the mapping is testable without touching process.env.
 */
export function planForPrice(priceId, env = process.env) {
  if (typeof priceId !== "string" || !priceId) return null;
  if (env.STRIPE_PRICE_STUDENT && priceId === env.STRIPE_PRICE_STUDENT) return "student";
  if (env.STRIPE_PRICE_PRO && priceId === env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

/** Statuses that still entitle. Anything else — canceled, unpaid, expired — does not. */
const ENTITLING_STATUSES = new Set(["active", "trialing", "past_due"]);

function firstPriceId(subscription) {
  const item = subscription?.items?.data?.[0];
  return item?.price?.id ?? item?.plan?.id ?? null;
}

/**
 * The plan a subscription object represents right now.
 * A subscription that has stopped being active IS a downgrade to free, even
 * when its price is one we recognise — that is the renewal that lapsed.
 */
export function planForSubscription(subscription, env = process.env) {
  if (!subscription || typeof subscription !== "object") return null;
  if (!ENTITLING_STATUSES.has(subscription.status)) return DEFAULT_PLAN;
  return planForPrice(firstPriceId(subscription), env);
}

/**
 * The Supabase user a Stripe object points at, if it says.
 *
 * `client_reference_id` is the field Checkout carries for exactly this, and it
 * is what the website's checkout link must set. The metadata keys are the
 * fallbacks a hand-made session or a subscription created by the Dashboard
 * might use instead.
 */
export function supabaseUserIdFrom(object) {
  if (!object || typeof object !== "object") return null;
  const meta = object.metadata ?? {};
  for (const value of [object.client_reference_id, meta.supabase_user_id, meta.supabase_id, meta.user_id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function emailFrom(object) {
  const candidates = [object?.customer_details?.email, object?.customer_email, object?.metadata?.email];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  return null;
}

function customerIdFrom(object) {
  const c = object?.customer;
  if (typeof c === "string" && c) return c;
  if (c && typeof c === "object" && typeof c.id === "string") return c.id;
  return null;
}

/**
 * What one webhook event means, as data: who it is about, and which plan (if
 * any) it asks us to write.
 *
 * `plan: null` is a real answer — "record this, learn the customer mapping,
 * write nothing". checkout.session.completed usually lands there: Stripe does
 * not expand line items on the event, so the session often carries no price at
 * all. It is still the most valuable event we get, because it is the only one
 * that carries the Supabase user id; the customer.subscription.updated that
 * follows a moment later is what actually sets the plan.
 */
export function planChangeForEvent(event, env = process.env) {
  const type = event?.type;
  const object = event?.data?.object;
  if (!type || !object || typeof object !== "object") return null;

  const base = { type, userId: supabaseUserIdFrom(object), customerId: customerIdFrom(object), email: emailFrom(object) };

  if (type === "checkout.session.completed") {
    // `metadata.plan` / `metadata.price_id` are HINTS, and they are only safe
    // because a Checkout Session's metadata can be set by whoever creates the
    // session and nobody else — a server-created session or a Dashboard
    // Payment Link. If the order page ever starts building metadata from
    // something the browser supplied (a query param, a form field), this stops
    // being a hint and becomes a free upgrade: drop these two and let the
    // customer.subscription.* event, which carries the real price, do the work
    // it already does. `client_reference_id` is different — it names WHO paid,
    // never WHAT they bought, so it grants nothing on its own.
    const hinted = object.metadata?.plan;
    const plan = planForPrice(object.metadata?.price_id ?? object.line_items?.data?.[0]?.price?.id, env)
      ?? (isPlan(normalizePlan(hinted)) && normalizePlan(hinted) !== DEFAULT_PLAN ? normalizePlan(hinted) : null);
    return { ...base, plan };
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.created") {
    return { ...base, plan: planForSubscription(object, env) };
  }
  if (type === "customer.subscription.deleted") {
    return { ...base, plan: DEFAULT_PLAN };
  }
  return null; // an event type we do not act on
}

/**
 * Write the plan onto the Supabase user's app_metadata with the service role
 * key. app_metadata and not user_metadata: shared/plan.js trusts app_metadata
 * precisely because only this key can write it, so writing anywhere else
 * would produce a plan the account holder could have set themselves.
 *
 * PATCH merges top-level metadata keys, so other app_metadata (provider,
 * providers) survives.
 */
export async function writePlanToSupabase(userId, plan) {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key || !userId) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ app_metadata: { plan: normalizePlan(plan) } }),
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/**
 * Turn one plan change into what happens to the account — with every store
 * and every remote write handed in, so this stays loadable and testable
 * without a database or a Supabase.
 *
 * The order of events is not ours to choose. Stripe routinely delivers
 * customer.subscription.created (which names the price) BEFORE the
 * checkout.session.completed that carries the account id, and a checkout
 * made from the website while signed out never names an account at all.
 * So a purchase that cannot be placed is not an error and not a retry: it is
 * recorded as UNCLAIMED, keyed on the Stripe customer, and placed the moment
 * anything links that customer to a user — a later event, or the payer's
 * email signing in (claimPendingForUser). Before this, an unplaced event
 * was answered 500 to buy Stripe's ~3-day retry schedule, and a payer who
 * signed in on day four had paid and stayed on Free.
 *
 * Outcomes:
 *   applied           the plan is on the account
 *   pending           recorded against the customer, waiting for its account
 *   no_plan           the event names no price we know — nothing to write
 *   unclaimed_ended   a never-claimed subscription ended: the record is dropped
 *   no_user           no account, no customer, nothing to key on — retryable
 *   failed:<reason>   the Supabase write failed — retryable
 */
export async function settleChange(change, deps) {
  const { link, lookup, findByEmail, writePlan, pendingGet, pendingPut, pendingDelete, forget = () => {} } = deps;
  link(change); // learn customer → email/user first: later events carry a customer and nothing else
  const known = change.customerId ? lookup(change.customerId) : null;
  let userId = change.userId ?? known?.user_id ?? null;
  const email = change.email ?? known?.email ?? null;
  if (!userId && email) userId = await findByEmail(email);
  // A checkout that names the account but not the price adopts the plan the
  // subscription event already recorded for this customer.
  const pending = change.customerId ? pendingGet(change.customerId) : null;
  const plan = change.plan ?? (userId && pending ? pending.plan : null);
  if (plan == null) return { outcome: "no_plan", userId, plan: null };
  if (!userId) {
    if (!change.customerId) return { outcome: "no_user", userId: null, plan };
    if (plan === DEFAULT_PLAN) {
      pendingDelete(change.customerId);
      return { outcome: "unclaimed_ended", userId: null, plan };
    }
    pendingPut({ customerId: change.customerId, email, plan, eventId: change.eventId ?? null });
    return { outcome: "pending", userId: null, plan };
  }
  const written = await writePlan(userId, plan);
  if (!written.ok) return { outcome: `failed:${written.reason}`, userId, plan };
  link({ customerId: change.customerId, userId, email });
  if (change.customerId) pendingDelete(change.customerId);
  forget(); // an upgrade must not wait out the plan cache
  return { outcome: "applied", userId, plan };
}

/**
 * The other half of an unclaimed purchase: a user has just signed in (or
 * been resolved) and holds no plan. If the email they signed in with paid
 * for one, it is theirs — Google verified the address, which is the same
 * trust findUserIdByEmail already extends the other way round. Returns the
 * plan written, or null when there was nothing to claim or the write failed
 * (the record stays; the next resolve tries again).
 */
export async function claimPendingForUser({ userId, email }, deps) {
  const { pendingByEmail, writePlan, link, pendingDelete, forget = () => {} } = deps;
  if (!userId || !email) return null;
  const row = pendingByEmail(email);
  if (!row?.plan || row.plan === DEFAULT_PLAN) return null;
  const written = await writePlan(userId, row.plan);
  if (!written.ok) return null;
  link({ customerId: row.customer_id, userId, email });
  pendingDelete(row.customer_id);
  forget();
  return row.plan;
}

/**
 * Last-resort user lookup by email, for an event that carries no user id and
 * no customer we have seen before (a Dashboard-created subscription, mostly).
 *
 * Bounded on purpose: this pages through the admin user list, which is O(all
 * users). The mapping learned at checkout is the real path — if this fallback
 * is doing the work, the checkout link is missing its client_reference_id.
 */
export async function findUserIdByEmail(email, { maxPages = 5, perPage = 200 } = {}) {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!base || !key || !email) return null;
  const wanted = email.trim().toLowerCase();
  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${base}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const users = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
      if (users.length === 0) return null;
      const hit = users.find((u) => typeof u?.email === "string" && u.email.toLowerCase() === wanted);
      if (hit?.id) return hit.id;
      if (users.length < perPage) return null;
    }
    return null;
  } catch {
    return null;
  }
}
