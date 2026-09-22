// target.mjs — which Doc a dev driver may EDIT, decided before a browser starts.
//
// No driver that edits has a default Doc. The Doc is named explicitly:
//
//   --doc <url>  (or --doc=<url>)     wins over
//   TRACELY_EDIT_DOC_URL              a Doc you own
//
// PUBLIC_DOC_ID below is someone else's public Doc, editable by anyone. It is
// here so the drivers can REFUSE it: an edit run against it is allowed only
// with --severed, and then only in a driver that severs the network and
// proves the cut (canaries fail, zero upstream sockets, traffic was proxied)
// before the first edit event — the drivers abort otherwise. Read-only
// scripts (verify.mjs) may still load it by default.
//
// Pure (no Playwright, no network): server/test/ext-docs-edit.test.js
// imports it.
export const PUBLIC_DOC_ID = "1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo";
export const PUBLIC_DOC_URL = `https://docs.google.com/document/d/${PUBLIC_DOC_ID}/edit`;

// --doc <url> | --doc=<url>, --severed; everything else is positional.
export function parseArgs(argv) {
  const out = { doc: "", severed: false, rest: [], error: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--severed") out.severed = true;
    else if (a === "--doc") {
      const v = argv[i + 1];
      if (v == null || String(v).startsWith("--")) out.error = "--doc needs a URL";
      else { out.doc = String(v); i++; }
    } else if (a.startsWith("--doc=")) out.doc = a.slice(6);
    else if (a.startsWith("--")) out.error = `unknown option ${a}`;
    else out.rest.push(a);
  }
  return out;
}

// A URL names the public Doc if its id appears anywhere in it, in any
// spelling (/d/<id>/edit, /u/0/d/<id>, ?id=<id>, percent-encoded).
export function isPublicDoc(url) {
  const s = String(url);
  let dec = s;
  try { dec = decodeURIComponent(s); } catch { /* keep the raw form */ }
  return s.includes(PUBLIC_DOC_ID) || dec.includes(PUBLIC_DOC_ID);
}

// The decision, as data: { ok, url, severed, isPublic, source, rest } or
// { ok: false, error }. severed = this run must sever the network and prove
// it before editing (always true for the public Doc).
export function editTarget({ argv = process.argv.slice(2), env = process.env } = {}) {
  const a = parseArgs(argv);
  if (a.error) return { ok: false, error: a.error };
  const url = a.doc || String(env.TRACELY_EDIT_DOC_URL || "");
  const source = a.doc ? "--doc" : "TRACELY_EDIT_DOC_URL";
  if (!url) {
    return { ok: false, error: "no Doc to edit: pass --doc <url> or set TRACELY_EDIT_DOC_URL (a Doc you own). There is no default." };
  }
  if (!/^https:\/\/docs\.google\.com\/document\//.test(url)) {
    return { ok: false, error: `${source} is not a Google Docs document URL` };
  }
  const pub = isPublicDoc(url);
  if (pub && !a.severed) {
    return {
      ok: false,
      error: "refusing to edit someone else's public Doc: rerun with --severed, and the run will cut the network and prove the cut before the first edit (then run node verify.mjs)",
    };
  }
  return { ok: true, url, severed: a.severed || pub, isPublic: pub, source, rest: a.rest };
}

// For the drivers: the decision, or exit 2 with the reason before anything runs.
export function requireEditTarget(script, opts) {
  const t = editTarget(opts);
  if (!t.ok) {
    console.error(`${script}: ${t.error}`);
    process.exit(2);
  }
  return t;
}
