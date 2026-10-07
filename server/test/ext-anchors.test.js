/* The slicing markers are test fixtures. Thirty test files find a region of
 * extension/content.js with indexOf("  function esc(") and friends; rename or
 * re-indent one of those lines and every slice silently moves. This test
 * names the marker that moved, so the failure says what to restore. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHORS, sliceBetween } from "./helpers/anchors.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every anchor the suite slices by occurs exactly once in its file", () => {
  for (const [file, list] of Object.entries(ANCHORS)) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    for (const anchor of list) {
      const first = src.indexOf(anchor);
      assert.ok(first >= 0, `${file}: anchor missing — ${JSON.stringify(anchor)}. A test slices by this line; restore it or update server/test/helpers/anchors.js together with that test.`);
      assert.equal(src.indexOf(anchor, first + 1), -1, `${file}: anchor is no longer unique — ${JSON.stringify(anchor)}`);
    }
  }
});

test("sliceBetween names the missing anchor instead of returning the wrong region", () => {
  const src = "aaa\n  function esc(s) {}\nbbb\n  function wireChrome(x) {}\nccc";
  assert.equal(sliceBetween(src, "  function esc(", "  function wireChrome("), "  function esc(s) {}\nbbb\n");
  assert.throws(() => sliceBetween(src, "  function nope("), /anchor not found: "  function nope\(/);
  assert.throws(() => sliceBetween(src, "  function esc(", "  function nope("), /anchor not found after/);
  assert.throws(() => sliceBetween(src + "\n  function esc(", "  function esc("), /not unique/);
});
