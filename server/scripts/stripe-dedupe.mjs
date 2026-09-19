/**
 * Find and archive duplicate Tracely products in Stripe.
 *
 * Run through scripts/stripe-dedupe.sh. DRY RUN by default; --apply archives.
 *
 * Stripe will not DELETE a product that has a price, so duplicates are
 * ARCHIVED (active:false) instead. Archived products disappear from the
 * catalogue and cannot be bought, which is what we want; nothing is destroyed,
 * so a mistake here is reversible from the Dashboard.
 *
 * It keeps the OLDEST of each name and archives the rest. Oldest, not newest,
 * because the first one created is the one most likely to be referenced
 * somewhere already — a Payment Link, a .env, a note in a chat.
 *
 * A product with any SUBSCRIPTION attached is never touched, and the run
 * reports it: archiving a product someone is paying for would be a very
 * expensive tidy-up.
 */
const KEY = (process.env.STRIPE_KEY ?? "").trim();
const APPLY = process.argv.includes("--apply");
if (!KEY) { console.error("No key supplied. Run scripts/stripe-dedupe.sh instead."); process.exit(1); }

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const safe = (e) => { const m = String(e?.message ?? ""); return /\b[sprk]k_(live|test)_/.test(m) ? (e?.code || "rejected") : m.slice(0, 140); };

async function api(method, path, params) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  const opts = { method, headers: { Authorization: `Bearer ${KEY}` } };
  if (params && method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (params && method !== "GET") {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(params);
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw Object.assign(new Error(safe(json.error)), { code: json.error.code });
  return json;
}

const TRACELY = /^Tracely (Student|Pro)$/;

let products;
try {
  products = (await api("GET", "products", { limit: 100, active: "true" })).data ?? [];
} catch (e) {
  console.log(r(`\nCannot read products: ${e.message}`));
  console.log("This needs a key with READ scope on Products, Prices and Subscriptions.\n");
  process.exit(3);
}

const mine = products.filter((p) => TRACELY.test(p.name)).sort((a, b) => a.created - b.created);
const byName = new Map();
for (const p of mine) (byName.get(p.name) ?? byName.set(p.name, []).get(p.name)).push(p);

console.log(`\nTracely product cleanup${APPLY ? "" : "  (DRY RUN — nothing will change)"}`);
console.log("=".repeat(56));

let toArchive = [];
for (const [name, list] of byName) {
  console.log(`\n${name} — ${list.length} product(s)`);
  for (const [i, p] of list.entries()) {
    const when = new Date(p.created * 1000).toISOString().slice(0, 16).replace("T", " ");
    let subs = 0;
    try {
      const prices = (await api("GET", "prices", { product: p.id, limit: 100 })).data ?? [];
      for (const pr of prices) {
        const s = await api("GET", "subscriptions", { price: pr.id, status: "all", limit: 1 });
        subs += (s.data ?? []).length;
      }
    } catch { subs = -1; } // unknown — treated as "do not touch"
    const keep = i === 0;
    const blocked = subs !== 0;
    const mark = keep ? g("KEEP  ") : blocked ? r("BLOCKED") : y("ARCHIVE");
    console.log(`  ${mark} ${p.id}  created ${when}  tax_code=${p.tax_code ?? "none"}  subs=${subs < 0 ? "?" : subs}`);
    if (!keep && !blocked) toArchive.push(p);
    if (!keep && blocked) console.log(`          not touched — ${subs < 0 ? "could not check subscriptions" : `${subs} subscription(s) attached`}`);
  }
}

console.log("\n" + "=".repeat(56));
if (!toArchive.length) {
  console.log(g("Nothing to archive."));
} else if (!APPLY) {
  console.log(`Would archive ${toArchive.length} duplicate product(s):`);
  for (const p of toArchive) console.log(`  ${p.id}  ${p.name}`);
  console.log("\nArchiving hides them from the catalogue; it does not delete anything");
  console.log("and is reversible from the Dashboard. Re-run with --apply.");
} else {
  for (const p of toArchive) {
    await api("POST", `products/${p.id}`, { active: "false" });
    console.log(g(`  archived ${p.id}  ${p.name}`));
  }
  console.log(`\nArchived ${toArchive.length}. Re-run scripts/stripe-setup.sh --apply to finish setup.`);
}
console.log();
