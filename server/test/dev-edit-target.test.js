// The fix-in-doc dev drivers must never have a default Doc to EDIT, and must
// refuse someone else's public test Doc unless the run severs the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editTarget, isPublicDoc, PUBLIC_DOC_ID } from "../../extension/dev/fix-in-doc/target.mjs";

const PUB = `https://docs.google.com/document/d/${PUBLIC_DOC_ID}/edit`;
const MINE = "https://docs.google.com/document/d/1abcdefghijklmnopqrstuvwxyz0123456789ABCDE/edit";

test("no Doc named: refused (there is no default)", () => {
  const t = editTarget({ argv: [], env: {} });
  assert.equal(t.ok, false);
  assert.match(t.error, /no default/);
});

test("the public Doc is refused without --severed, in every spelling", () => {
  for (const url of [PUB, `https://docs.google.com/document/u/1/d/${PUBLIC_DOC_ID}/edit?tab=t.0`, PUB.replace(PUBLIC_DOC_ID, encodeURIComponent(PUBLIC_DOC_ID))]) {
    assert.equal(isPublicDoc(url), true);
    assert.equal(editTarget({ argv: ["--doc", url], env: {} }).ok, false);
    assert.equal(editTarget({ argv: [], env: { TRACELY_EDIT_DOC_URL: url } }).ok, false);
  }
});

test("the public Doc with --severed is allowed, and always marked severed", () => {
  const t = editTarget({ argv: ["--doc", PUB, "--severed"], env: {} });
  assert.equal(t.ok, true);
  assert.equal(t.severed, true);
  assert.equal(t.isPublic, true);
});

test("a Doc you own is allowed live; --doc wins over the env; junk is refused", () => {
  const t = editTarget({ argv: ["trialname", "--doc", MINE], env: { TRACELY_EDIT_DOC_URL: PUB } });
  assert.equal(t.ok, true);
  assert.equal(t.severed, false);
  assert.deepEqual(t.rest, ["trialname"]);
  assert.equal(editTarget({ argv: ["--doc", "https://example.com/x"], env: {} }).ok, false);
  assert.equal(editTarget({ argv: ["--doc"], env: {} }).ok, false);
  assert.equal(editTarget({ argv: ["--bogus"], env: {} }).ok, false);
});
