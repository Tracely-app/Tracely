import test from "node:test";
import assert from "node:assert/strict";
import { noteClaimSeen, claimHash, normalizeClaim, resetSeen, seenSize, SEEN_TTL_MS, SEEN_MAX } from "../lib/seenClaims.js";

test("the same claim, differently punctuated or cased, is one hash; a different claim is another; nothing stored is the text", () => {
  resetSeen();
  assert.equal(normalizeClaim("  Finland’s literacy rate is 100%!  "), "finlands literacy rate is 100%");
  assert.equal(claimHash("Finland's literacy rate is 100%."), claimHash("finland's  LITERACY rate is 100%"));
  assert.notEqual(claimHash("Finland's literacy rate is 100%."), claimHash("Finland's literacy rate is 99%."));
  assert.match(claimHash("x"), /^[0-9a-f]{32}$/);
  assert.equal(noteClaimSeen("Finland's literacy rate is 100%."), false, "first time");
  assert.equal(noteClaimSeen("finland's literacy rate is 100%"), true, "second time, normalised");
  assert.equal(noteClaimSeen("Finland's literacy rate is 99%."), false);
});

test("a claim is forgotten after the TTL, and the table never grows past its cap", () => {
  resetSeen();
  const t0 = 1_000_000;
  assert.equal(noteClaimSeen("old claim", t0), false);
  assert.equal(noteClaimSeen("old claim", t0 + SEEN_TTL_MS - 1), true);
  assert.equal(noteClaimSeen("old claim", t0 + 2 * SEEN_TTL_MS), false, "expired");
  resetSeen();
  for (let i = 0; i < SEEN_MAX + 500; i++) noteClaimSeen(`claim number ${i}`, t0 + i);
  assert.ok(seenSize() <= SEEN_MAX, `size ${seenSize()}`);
  assert.equal(noteClaimSeen(`claim number ${SEEN_MAX + 499}`, t0 + SEEN_MAX + 600), true, "the most recent survives");
  assert.equal(noteClaimSeen("claim number 0", t0 + SEEN_MAX + 601), false, "the oldest was evicted");
});
