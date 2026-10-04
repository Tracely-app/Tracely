/* Typing in Google Docs must not blink the underlines (content.js
 * armAnnotationObserver). Owner, 2026-10-04: "every time I type a character
 * the underlines flicker". The observer HID a bar whenever its line's
 * annotation text changed and re-matched a frame later (up to 140 ms when
 * typing fast) — measured in a simulated annotation layer: the underline on
 * the typed line was missing at 20 of 20 keystrokes; with this, 0 of 20, for
 * both a rewritten and a replaced line node. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const obs = SRC.slice(SRC.indexOf("    function armAnnotationObserver() {"), SRC.indexOf("      annoObs.observe(target, {"));

test("a bar whose line only changed its text is not hidden — it keeps following the line", () => {
  assert.ok(obs.length > 1000, "content.js: the observer moved");
  assert.ok(!/getAttribute\("aria-label"\) !== b\.raw\) \{\s*b\.el\.style\.display = "none"/.test(obs), "the old hide-on-new-text is gone");
  assert.match(obs, /if \(b\.node\.getAttribute\("aria-label"\) !== b\.raw\) relocateNow = true;/);
});

test("anything that needs a re-match gets it in the observer callback, before the next paint", () => {
  assert.match(obs, /if \(!b\.el\.isConnected \|\| !b\.node\.isConnected\) \{\n\s+b\.el\.style\.display = "none";[^\n]*\n\s+relocateNow = true;/);
  assert.match(obs, /if \(relocateNow\) \{ requestDocsMarks\(\); return; \}/);
  assert.ok(obs.indexOf("if (relocateNow) { requestDocsMarks(); return; }") < obs.indexOf("requestAnimationFrame(() => { annoRafPending = false; fastDocsMarks(); });"), "before the frame-later path");
});
