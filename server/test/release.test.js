import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReleaseStamp } from "../lib/release.js";

test("the release stamp is read when present and well-formed, and is nothing otherwise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tracely-release-"));
  try {
    assert.equal(readReleaseStamp(dir), null, "no file → nothing (a laptop)");
    writeFileSync(path.join(dir, "release.json"), "{not json");
    assert.equal(readReleaseStamp(dir), null, "malformed → nothing, never a crash at boot");
    writeFileSync(path.join(dir, "release.json"), JSON.stringify({ commit: "nope", deployedAt: "2026-10-09T02:00:00Z" }));
    assert.equal(readReleaseStamp(dir), null, "a commit that is not a sha → nothing");
    writeFileSync(path.join(dir, "release.json"), JSON.stringify({ commit: "A71E4AA", deployedAt: "not a time" }));
    assert.deepEqual(readReleaseStamp(dir), { commit: "a71e4aa" }, "a bad time is dropped, the commit kept, lower-cased");
    writeFileSync(path.join(dir, "release.json"), JSON.stringify({ commit: "a71e4aa0f9c2b1d3e4f5a6b7c8d9e0f1a2b3c4d5", deployedAt: "2026-10-09T02:00:00Z" }));
    assert.deepEqual(readReleaseStamp(dir), { commit: "a71e4aa0f9c2b1d3e4f5a6b7c8d9e0f1a2b3c4d5", deployedAt: "2026-10-09T02:00:00Z" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
