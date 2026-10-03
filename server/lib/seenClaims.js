/**
 * Would a shared source cache have answered this search? A yes/no per call,
 * counted before anyone builds the cache.
 *
 * Why a counter and not a cache: PRIVACY.md promises no record of the text a
 * student checks, and a cache of search results keyed on a claim is a record
 * of which claims were searched. The judgement that decides it — how often
 * two people search the same claim — needs no such record: a SHA-256 of the
 * normalised claim, kept in memory for a fortnight, says whether this claim
 * has been seen without saying what it was. Nothing here touches the disk,
 * and a restart forgets everything.
 *
 * The log line on /api/sources carries `wouldHit=1|0`; the ratio over a few
 * weeks is the cache's expected hit rate, the whole case for or against it.
 */
import { createHash } from "node:crypto";

export const SEEN_TTL_MS = 14 * 24 * 3600_000;
export const SEEN_MAX = 20_000;

const seen = new Map(); // hash → last seen (ms)

// Quotes dropped, anything but letters, digits, % $ and the decimal point
// becomes a space, runs of space collapse, and the sentence's own final
// period goes — "…is 100%." and "…is 100%" are one claim.
export const normalizeClaim = (claim) => String(claim ?? "").toLowerCase().replace(/[“”"'‘’]/g, "").replace(/[^\p{L}\p{N}%.$ ]+/gu, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
export const claimHash = (claim) => createHash("sha256").update(normalizeClaim(claim)).digest("hex").slice(0, 32);

/** Records the claim as seen now; returns whether it had been seen within SEEN_TTL_MS. */
export function noteClaimSeen(claim, now = Date.now()) {
  const h = claimHash(claim);
  const last = seen.get(h);
  const hit = last != null && now - last < SEEN_TTL_MS;
  seen.delete(h); // re-insert so Map order is least-recent first
  seen.set(h, now);
  if (seen.size > SEEN_MAX) {
    for (const [k, t] of seen) {
      if (seen.size <= SEEN_MAX && now - t < SEEN_TTL_MS) break;
      seen.delete(k);
    }
  }
  return hit;
}

export function seenSize() { return seen.size; }
export function resetSeen() { seen.clear(); }
