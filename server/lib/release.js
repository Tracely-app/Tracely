/* What is deployed, said by the server itself.
 *
 * `server/release.json` is written by the deploy runbook (server/DEPLOY.md)
 * into the snapshot right before rsync — `{ "commit": "<sha>", "deployedAt":
 * "<ISO time>" }` — and never committed. /api/status carries it as `release`
 * so either developer can answer "which commit is live?" with a curl instead
 * of an SSH key or a backup folder's name:
 *
 *   curl -s https://api.jointracely.com/api/status | node -pe 'JSON.parse(require("fs").readFileSync(0)).release'
 *   server/scripts/healthcheck.sh https://api.jointracely.com --commit <sha>
 *
 * Read once at boot. Absent, unreadable or malformed → null, and the status
 * shape is exactly what it was (the extension's frozen contract is additive).
 * A local checkout has no such file, so a laptop reports nothing. */
import { readFileSync } from "node:fs";
import path from "node:path";

export function readReleaseStamp(dir) {
  let raw;
  try { raw = readFileSync(path.join(dir, "release.json"), "utf8"); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const commit = typeof j?.commit === "string" && /^[0-9a-f]{7,40}$/i.test(j.commit.trim()) ? j.commit.trim().toLowerCase() : null;
  if (!commit) return null;
  const deployedAt = typeof j.deployedAt === "string" && !Number.isNaN(Date.parse(j.deployedAt)) ? j.deployedAt : null;
  return deployedAt ? { commit, deployedAt } : { commit };
}
