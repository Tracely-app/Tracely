/**
 * The mark system — decided ONCE, here, and sent to every surface.
 * Three colours, not eight: the palette is the product's vocabulary.
 * A claim's state maps to an ordered list of problem kinds; the mark takes its
 * colour from the first. The underline and the card must never disagree, so
 * both derive from this module (served to the browser at /shared/marks.js and
 * imported by the server).
 *
 * claimState shape (all fields optional unless noted):
 * {
 *   status: "pending" | "checked",            // required
 *   claimType: "factual"|"statistic"|"causal"|"opinion"|"prediction",
 *   confidence: 0..1,
 *   hasOwnCitation: boolean,                   // sentence carries its own citation (incl. prose attribution)
 *   citationDefects: string[],                 // shape defects, decidable free & instant
 *   searched: boolean,                         // evidence retrieval has completed
 *   sources: { count, aboveFloor, citableAboveFloor, providers: string[] },
 *   outsideIndex: boolean,                     // claim's domain not covered by the indexes searched
 *   strength: { score: 0..100, metric: "lexical"|"dense" } | null,
 *   critique: {                                // resolved LLM critique, null until it lands
 *     verdict: "contradicted"|"fabricated"|"overstated"|"well-supported"|
 *              "partially-supported"|"weak"|"unsupported",
 *     citationFix: string | null,              // corrected reference when the one given is malformed
 *   } | null,
 * }
 *
 * THE VERDICT VOCABULARY IS THE RELAY'S, and has been since the desktop's
 * five-pass critique moved into this server (lib/prompts/critique.js). It used
 * to be this server's own six — contradicted / citationFix / fabricated / weak
 * / unsupported / sound — plus an `overstated` boolean. The mapping, so old
 * reasoning below still reads:
 *   sound                 -> well-supported
 *   overstated: true      -> verdict "overstated"
 *   verdict "citationFix" -> the citationFix FIELD (the corrected reference)
 *   (new)                    partially-supported
 * "sound" and a boolean `overstated` are still accepted, so a critique cached
 * or held in memory from before the change still draws correctly.
 */

export const COLORS = {
  red: "#d93636",
  amber: "#ffb800",
  orange: "#ff5900",
  grey: "#9a9ba1",
};

// Ranked. Order is the product decision — do not re-sort at a call site.
// The rank order follows the production problemKind.ts SEVERITY list:
//  - fabricated above everything — an invented source is the one failure the
//    reader of the finished essay cannot catch;
//  - citation-defect directly under it — the same class of problem, caught
//    earlier and cheaper (decidable from shape, no model involved);
//  - cited-unverified directly under contradicted — a claim whose own citation
//    does not support it is the one error a reader has no prompt to check;
//  - outside-index LAST of the real findings — everything above it is
//    something established about the sentence, this reports what could not be
//    established, and it must never push a contradicted fact down the list.
export const PROBLEM_KINDS = [
  { kind: "fabricated-citation",     label: "Source not found — may be fabricated", color: "red" },
  { kind: "citation-defect",         label: "Citation is incomplete",               color: "amber" },
  { kind: "contradicted-claim",      label: "Contradicted — check this fact",       color: "red" },
  { kind: "cited-unverified",        label: "Citation may not support this",        color: "amber" },
  { kind: "unsupported-by-evidence", label: "Evidence does not carry this",         color: "orange" },
  { kind: "overstated-claim",        label: "Overstated — narrow this",             color: "amber" },
  { kind: "unverified-statistic",    label: "Unverified statistic",                 color: "orange" },
  { kind: "no-sources",              label: "No supporting sources",                color: "orange" },
  { kind: "weak-evidence",           label: "Evidence is weak",                     color: "orange" },
  { kind: "partial-evidence",        label: "Partially supported",                  color: "orange" },
  { kind: "missing-citation",        label: "Missing citation",                     color: "amber" },
  { kind: "outside-index",           label: "Not in these databases",               color: "amber" },
  { kind: "searching",               label: "Checking…",                            color: "grey" },
];

const BY_KIND = new Map(PROBLEM_KINDS.map((p) => [p.kind, p]));
export function kindInfo(kind) {
  return BY_KIND.get(kind) ?? null;
}

const CITATION_NEEDING_TYPES = new Set(["factual", "statistic", "causal"]);
export const RELEVANCE_FLOOR_LEXICAL = 0.18; // lexical metric floor; dense would need its own
export const WEAK_STRENGTH_BELOW = 35;
export const PARTIAL_STRENGTH_BELOW = 60;

/**
 * Pure. Returns the ordered list of problem kinds for a claim state.
 * Two rules that took real damage to learn are enforced here:
 *  1. Never flag a correctly cited sentence on retrieval's say-so — retrieval
 *     kinds are suppressed while hasOwnCitation and the critique hasn't resolved.
 *  2. "Searched and found nothing" is an empty state, not a 0-score finding,
 *     when the sentence carries its own citation.
 */
export function problemsFor(state) {
  if (!state || state.status === "pending") return ["searching"];

  const out = [];
  const critique = state.critique ?? null;
  const defects = state.citationDefects ?? [];
  const sources = state.sources ?? { count: 0, aboveFloor: 0, citableAboveFloor: 0, providers: [] };
  const cited = Boolean(state.hasOwnCitation);
  const critiqueResolved = critique != null;
  // Retrieval may only speak about uncited sentences, or once critique opened the cited work.
  const retrievalMaySpeak = !cited || critiqueResolved;
  const needsCitation = CITATION_NEEDING_TYPES.has(state.claimType) && (state.confidence ?? 0) >= 0.55;

  // Is this `unsupported` verdict a statement about the CLAIM, or about the
  // SEARCH? The critique reaches `unsupported` two ways: it read on-topic
  // evidence that does not carry the claim (a judgement about the sentence),
  // or it was handed nothing relevant and had nothing to read (a report on
  // retrieval, phrased as a verdict on the sentence). Only the first is
  // something we know about the writing — the retrieval kinds below report
  // the second honestly as "no sources" instead of as an accusation.
  // (Ported from the production problemKind.ts `isRetrievalMiss`.)
  const retrievalMiss = state.searched && sources.aboveFloor === 0;

  const verdict = critique?.verdict ?? null;
  // "The claim holds" in either vocabulary. The critique read the evidence and
  // it carries the sentence, so retrieval-side findings that it overrules
  // (an unverified statistic, a missing citation) stay quiet.
  const supported = verdict === "well-supported" || verdict === "sound";
  // The critique read the evidence and it does NOT carry the claim as phrased.
  // (The desktop's WEAK_VERDICTS.) `overstated` is deliberately not here: it is
  // a finding about the sentence's quantifier, not its source.
  const doubted = verdict === "weak" || verdict === "unsupported";

  if (verdict === "fabricated") out.push("fabricated-citation");
  // A shape defect needs no verdict and no citation gate: a placeholder author
  // is wrong the moment it is typed, and waiting for a paid critique to say so
  // in prose is a worse version of the same finding. A critique that returned
  // a corrected reference has found the same thing, a paid call later.
  if (defects.length > 0 || critique?.citationFix || verdict === "citationFix") out.push("citation-defect");
  if (verdict === "contradicted") out.push("contradicted-claim");
  // The writer named a source, the critique read it, and it does not carry the
  // claim. This subsumes the plain evidence bands for a cited sentence: "thin
  // support" is the wrong advice to someone who has already named a source.
  if (cited && doubted) out.push("cited-unverified");
  if (verdict === "unsupported" && !retrievalMiss && !cited) out.push("unsupported-by-evidence");
  // The relay reports overstatement as its own verdict, with a narrowed
  // revision. This used to be inferred from `weak` at confidence >= 0.85 —
  // a proxy for a server whose prompt had no overstated verdict — and keeping
  // that proxy now would turn "the evidence does not carry this" into "narrow
  // this word", which the critique has explicitly not said.
  if (verdict === "overstated" || critique?.overstated === true) out.push("overstated-claim");

  // The three empty-retrieval kinds are mutually exclusive, worst-fit first:
  // emitting two of them prints "No supporting sources" underneath "these
  // databases do not hold this kind of claim", which is the accusation the
  // second line exists to withdraw.
  // "Nothing that speaks to this claim came back", not "no rows returned":
  // providers return a merged list for nearly any query, so a raw-count test
  // is close to unreachable — the relevance floor is the real question.
  // (The production problemKind.ts made exactly this correction.)
  const outsideIndexFires = state.searched && state.outsideIndex && sources.aboveFloor === 0;
  const unverifiedStatFires =
    state.claimType === "statistic" &&
    !supported &&
    retrievalMaySpeak &&
    state.searched &&
    sources.citableAboveFloor === 0 &&
    !outsideIndexFires;
  if (outsideIndexFires) out.push("outside-index");
  if (unverifiedStatFires) out.push("unverified-statistic");
  if (
    retrievalMaySpeak && state.searched && sources.aboveFloor === 0 &&
    !state.outsideIndex && !cited && !unverifiedStatFires
  ) out.push("no-sources");

  if (verdict === "weak" && !cited) out.push("weak-evidence");
  else if (
    retrievalMaySpeak && state.searched && !cited && !supported && verdict !== "partially-supported" &&
    sources.aboveFloor > 0 && (state.strength?.score ?? 100) < WEAK_STRENGTH_BELOW
  ) out.push("weak-evidence");
  // "Partially supported" is a verdict now, not only a retrieval band. The
  // critique read the evidence and it carries part of the claim.
  if (verdict === "partially-supported") out.push("partial-evidence");
  if (
    retrievalMaySpeak && state.searched && !cited && verdict !== "weak" && !supported &&
    sources.aboveFloor > 0 &&
    (state.strength?.score ?? 100) >= WEAK_STRENGTH_BELOW &&
    (state.strength?.score ?? 100) < PARTIAL_STRENGTH_BELOW
  ) out.push("partial-evidence");
  // "Well supported, but the sentence is unattributed" — the strength gate is
  // the shipped refinement: while the evidence sits in the weak or partial
  // band the card already names that problem, and "add a citation" on top of
  // it points the writer at the wrong repair.
  if (
    needsCitation && !cited && state.searched && sources.citableAboveFloor > 0 &&
    !supported &&
    (state.strength?.score ?? 0) >= PARTIAL_STRENGTH_BELOW
  ) {
    out.push("missing-citation");
  }

  // dedupe, preserve rank order
  const seen = new Set();
  return PROBLEM_KINDS.map((p) => p.kind).filter((k) => out.includes(k) && !seen.has(k) && seen.add(k));
}

/** The mark shown over the sentence: first problem kind, or null for clean. */
export function markFor(state) {
  const kinds = problemsFor(state);
  if (kinds.length === 0) return null;
  const info = kindInfo(kinds[0]);
  return { kind: info.kind, label: info.label, color: info.color, hex: COLORS[info.color], allKinds: kinds };
}
