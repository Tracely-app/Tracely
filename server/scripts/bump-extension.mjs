#!/usr/bin/env node
/* One command for the one line two developers fight over.
 *
 *   node server/scripts/bump-extension.mjs patch     # 2.21.24 → 2.21.25
 *   node server/scripts/bump-extension.mjs minor     # 2.21.24 → 2.22.0
 *
 * Rewrites extension/manifest.json's version, refuses if a server/test file
 * still pins the OLD literal (the pin has to move in the same PR), and prints
 * the zip names and who uploads. Run it in the LAST commit of a PR, after
 * rebasing on main, so a rebase never has two PRs claiming the same number. */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(ROOT, "extension", "manifest.json");
const kind = process.argv[2];
if (!["patch", "minor"].includes(kind)) { console.error("usage: bump-extension.mjs patch|minor"); process.exit(2); }

const raw = readFileSync(MANIFEST, "utf8");
const m = raw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/);
if (!m) { console.error("manifest.json: no x.y.z version"); process.exit(1); }
const [major, minor, patch] = m.slice(1).map(Number);
const old = `${major}.${minor}.${patch}`;
const next = kind === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;

const pins = readdirSync(path.join(ROOT, "server", "test")).filter((f) => f.endsWith(".test.js"))
  .filter((f) => new RegExp(`assert\\.equal\\([^\\n]*"${old.replace(/\./g, "\\.")}"`).test(readFileSync(path.join(ROOT, "server", "test", f), "utf8")));
if (pins.length) {
  console.error(`A test still pins the old version literal "${old}": ${pins.join(", ")}.\nPin the manifest's SHAPE (permissions, a semver regex), not its number, or move the pin in the same commit.`);
  process.exit(1);
}
writeFileSync(MANIFEST, raw.replace(m[0], `"version": "${next}"`));
console.log(`extension/manifest.json: ${old} → ${next}`);
console.log(`zips: Tracely-${next}-store.zip (Sam uploads to the Web Store), Tracely-${next}-beta.zip (testers, Load unpacked)`);
console.log(`after the merge: label the PR needs:sam-store-upload; the store row in STATUS.md moves when Sam uploads.`);
