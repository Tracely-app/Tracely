/* The try-out page (server/public/try.html + try.js) drives extension/content.js
 * from outside, through internals no other test pins. Every deploy ships the
 * content.js on main, so a routine extension change here (an isTrusted check
 * in focusin, a renamed class) would make every click say "Tracely couldn't
 * start on this page" while healthcheck.sh still sees 200s. These pins fail
 * first; change the page in the same PR when one moves. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const TRY_JS = readFileSync(path.join(ROOT, "server", "public", "try.js"), "utf8");
const TRY_HTML = readFileSync(path.join(ROOT, "server", "public", "try.html"), "utf8");
const num = (src, re, what) => { const m = re.exec(src); assert.ok(m, `${what}: not found`); return Number(m[1].replace(/_/g, "")); };

test("try.js starts content.js's field mode with a synthetic focusin", () => {
  const at = SRC.indexOf('document.addEventListener("focusin", (e) => {');
  assert.ok(at > 0, "the document-level focusin listener");
  assert.doesNotMatch(SRC.slice(at, at + 400), /isTrusted/, "a synthetic focusin must still track the field");
  assert.match(TRY_JS, /editor\.dispatchEvent\(new FocusEvent\("focusin", \{ bubbles: true \}\)\)/);
});

test("the page's click-to-check gate: field mode's loop and cycle() stand down while document.hidden", () => {
  assert.ok(SRC.includes("if (siteEnabled() && !inflight && !document.hidden && fieldEligible()"), "the field loop's gate");
  assert.ok(SRC.includes("async function cycle() {\n      if (orphaned || inflight || document.hidden) return;"), "cycle()'s gate");
  assert.match(TRY_HTML, /Object\.defineProperty\(document, "hidden"/, "the shim reports the page hidden between clicks");
});

test("the widget try.js reaches into: an open shadow root on <html>, #pill, .root, .panel", () => {
  assert.match(SRC, /attachShadow\(\{ mode: "open" \}\);\n\s*document\.documentElement\.appendChild\(host\);/);
  assert.match(SRC, /<div class="launcher" id="pill"/);
  assert.match(SRC, /root\.className = "root";/);
  assert.match(SRC, /\.root \{ position: fixed;/);
  assert.match(SRC, /\n    \.panel \{\n      position: absolute; right: 0; bottom: 70px;/, "framed placement offsets .panel from .root");
  // An underline click opens the panel in the DOCUMENT's capture phase; try.js
  // picks the framed panel's spot first, in the window's.
  assert.match(SRC, /flashCard\(h\);\n    \}, true\);/);
  assert.match(TRY_JS, /addEventListener\("mousedown", \(e\) => \{\n\s*if \(!editor\.contains/);
});

test("what the try-out hides, and the order page it never opens", () => {
  for (const sel of ['id="siteSwitch"', 'id="panelSettings"', 'class="cite-url"', 'class="deep-row"', "data-deep-plans"]) assert.ok(SRC.includes(sel), sel);
  assert.match(TRY_JS, /#siteSwitch, #panelSettings, \.cite-url, \.deep-row, \.deep-note a\[data-deep-plans\]/);
  // content.js opens ORDER_URL itself unless the worker answers ok.
  assert.ok(SRC.includes('if (!r?.ok) window.open(ORDER_URL, "_blank", "noopener,noreferrer");'));
  assert.match(TRY_HTML, /type === "tracely-open-order"\) \{ demo\.emit\("upgrade"\); return Promise\.resolve\(\{ ok: true \}\); \}/);
});

test("content.js keeps its state through localStorage's methods, which the shim keeps in memory", () => {
  assert.doesNotMatch(SRC, /localStorage\[|localStorage\.(?!getItem|setItem|removeItem)[a-z]+\s*=/, "no property-style storage the shim would miss");
  assert.match(TRY_HTML, /SP\.setItem = function/);
});

test("try.js's copies of content.js's numbers", () => {
  assert.equal(num(TRY_JS, /const MIN_CHARS = (\d+);/, "try.js MIN_CHARS"), num(SRC, /const MIN_FIELD_CHARS = (\d+);/, "MIN_FIELD_CHARS"));
  const quiet = num(TRY_JS, /\}, (\d[\d_]*)\);\n  \}\n  function stopQuietRead/, "quietRead's delay");
  assert.ok(quiet > num(SRC, /const REVIEW_IDLE_MS = ([\d_]+);/, "REVIEW_IDLE_MS"), "the quiet read must come after the review's idle wait");
});
