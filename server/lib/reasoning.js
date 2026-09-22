/**
 * The desktop app's reasoning, served by this server.
 *
 * Until now Tracely had two complete implementations of the same product: the
 * desktop called a Vercel relay (questionablepuddle/Tracely-relay) with its own
 * prompts, models and guardrails, and the extension and web app called this
 * server with different ones. They shared no code, so they judged the same
 * sentence differently and drifted further apart with every change. The
 * relay's reasoning was the developed one — a five-pass critique written after
 * measuring what went wrong on real drafts, a fabrication gate keyed on an
 * actual reference lookup, a rubric grader whose findings must quote the
 * draft — so it is the one that survives, and it lives here now.
 *
 * Each export is one relay endpoint, with the relay's REQUEST and RESPONSE
 * contract, so the desktop's existing request builders and response parsers
 * work against this server unchanged. The prompts are imported from
 * lib/prompts/, where test/prompts.test.js pins them byte-for-byte to the
 * relay source. The guardrails that lived in the relay's handlers — the
 * critique's empty-content fallback, the correction's null-forcing, the claim
 * cap — are ported with them, and two that lived in the DESKTOP
 * (normalizeCritique, verifyGrade) run here too, so every client gets them.
 *
 * What deliberately changed from the relay:
 *  - Models. The relay used gpt-4.1 / gpt-4.1-mini from env vars and ignored
 *    the plan; here the caller's plan decides (server.js appModelFor).
 *  - Output caps. The relay's max_tokens (300-3000) were sized for gpt-4.1,
 *    which does not reason. The tier models count reasoning tokens against
 *    max_output_tokens, so the relay's caps would truncate; these use the
 *    server's usual ceilings.
 *  - No temperature. The reasoning models do not accept temperature 0.
 *
 * TRACELY_MOCK=1 returns deterministic answers in the same shapes, so the
 * whole product runs keyless for shape checks and tests.
 */
import { structuredCall, textCall, webSearchStructuredCall, DEFAULT_MODEL } from "./llm.js";
import { CheckError } from "./errors.js";
import { CLAIM_DETECTION_SYSTEM_PROMPT, CLAIM_DETECTION_SCHEMA } from "./prompts/detect.js";
import { CRITIQUE_SYSTEM_PROMPT, CRITIQUE_SCHEMA } from "./prompts/critique.js";
import { CORRECTION_SYSTEM_PROMPT, CORRECTION_SCHEMA } from "./prompts/correction.js";
import { STRUCTURE_SYSTEM_PROMPT, STRUCTURE_SCHEMA } from "./prompts/structure.js";
import { GRADE_SYSTEM_PROMPT, GRADE_SCHEMA } from "./prompts/grade.js";
import { TRACER_SYSTEM_PROMPT } from "./prompts/tracer.js";
import { SOURCE_SEARCH_SYSTEM_PROMPT, SOURCE_SEARCH_SCHEMA } from "./prompts/sources.js";
import { normalizeCritique } from "../shared/normalizeCritique.js";
import { verifyGrade, buildGradePrompt } from "../shared/gradedDraft.js";
import { splitSentences } from "../shared/sentenceSplit.js";
import { argumentParagraphs } from "../shared/structureText.js";

const isMock = () => process.env.TRACELY_MOCK === "1";

/* ── limits, from the relay's lib/limits.ts unless noted ──────────────── */
export const LIMITS = {
  detectInputChars: 6000,
  claimsPerAnalysis: 8,
  evidenceSummaryChars: 4000,
  referenceCheckChars: 1200, // longer is a 400, as it was on the relay
  structureInputChars: 8000,
  structureParagraphs: 24,
  gradeParagraphs: 40,
  gradeInputChars: 16000,
  tracerMessageChars: 2000,
  tracerHistory: 12,
  tracerContextChars: 5000,
  sourceClaimChars: 600,
  sourceContextChars: 1200,
  correctionPassages: 4,
  // Not on the relay, which had no cap here at all. A claim is a sentence.
  claimTextChars: 2000,
};

/* Output ceilings for the reasoning models (see the header for why these are
 * not the relay's numbers). */
const MAX_OUTPUT = { detect: 16_000, critique: 16_000, correction: 8_000, structure: 8_000, grade: 16_000, tracer: 8_000, sources: 16_000 };

/* ── numbering: the ONE format the prompts read ─────────────────────────
 * Sentences for detection are "[1] First. [2] Second." — joined by a space,
 * exactly as the desktop's claimDetection.ts builds them. Paragraphs for
 * structure are one per line; for grading, one per blank line, via the ported
 * buildGradePrompt. A `draft` from the web app is split and numbered here with
 * the desktop's own splitters (server/shared/*, mirror-tested against src/). */
export function numberSentences(sentences) {
  return sentences.map((s, i) => `[${i + 1}] ${s}`).join(" ");
}

/** Recover the units of a numbered prompt: "[1] a\n\n[2] b" -> ["a", "b"]. */
export function unnumber(text, separator) {
  return String(text)
    .split(separator)
    .map((u) => u.replace(/^\s*\[\d+\]\s?/, "").trim())
    .filter(Boolean);
}

/**
 * Does this `text` follow the numbered contract?
 *
 * A compatibility net, not the switch. Clients that send a raw draft should
 * send it as `draft` — that field is how the web app says "split this for
 * me". But the desktop renderer's browser bridge and anything older send raw
 * text as `text`, and a raw draft read as numbered input gives the model no
 * [n] markers to cite, so every claim comes back pointing at nothing and is
 * silently dropped. A numbered prompt always opens with "[1]" because the
 * builders that make it always start at one; a real draft that opens with
 * "[1]" is vanishingly rare, and the cost of guessing wrong there is a draft
 * numbered twice rather than a feature that quietly returns nothing.
 */
export function isNumbered(text) {
  return /^\s*\[1\]\s/.test(String(text ?? ""));
}

/* ── detect-claims ─────────────────────────────────────────────────────── */

/**
 * @param {{ text: string, model?: string, effort?: string }} req  numbered sentences
 * @returns {{ claims: Array<{sentenceIndices:number[], claimType:string, confidence:number, searchQuery:string}>, model, usage }}
 */
export async function detectClaims({ text, model, effort }) {
  const input = String(text).trim().slice(0, LIMITS.detectInputChars);
  if (!input) throw new CheckError("bad_request", "text required");
  if (isMock()) return mockDetect(input, model);
  const { parsed, model: used, usage } = await structuredCall({
    model, effort, maxTokens: MAX_OUTPUT.detect,
    system: CLAIM_DETECTION_SYSTEM_PROMPT, user: input,
    schema: CLAIM_DETECTION_SCHEMA.schema, name: CLAIM_DETECTION_SCHEMA.name,
    what: "claim detection",
  });
  const claims = Array.isArray(parsed?.claims) ? parsed.claims.slice(0, LIMITS.claimsPerAnalysis) : [];
  return { claims, model: used, usage };
}

/**
 * The web app's form: a raw draft in, the relay's claims out — plus, per
 * claim, the sentence text and its offsets in the draft, which is what the web
 * app's editor anchors marks with. The desktop never takes this path; it
 * splits and reconstructs on its own side.
 */
export async function detectClaimsInDraft({ draft, model, effort }) {
  const clipped = String(draft).slice(0, LIMITS.detectInputChars);
  const spans = splitSentences(clipped);
  if (spans.length === 0) return { claims: [], sentences: [], model: null, usage: zeroUsage() };
  const result = await detectClaims({ text: numberSentences(spans.map((s) => s.text)), model, effort });
  const sentences = spans.map((s, i) => ({ index: i + 1, text: s.text, start: s.start, end: s.end }));
  const claims = [];
  for (const c of result.claims) {
    const picked = (Array.isArray(c.sentenceIndices) ? c.sentenceIndices : [])
      .filter((i) => Number.isInteger(i) && i >= 1 && i <= sentences.length)
      .map((i) => sentences[i - 1]);
    if (picked.length === 0) continue; // an index to nothing is a claim about nothing
    const start = Math.min(...picked.map((s) => s.start));
    const end = Math.max(...picked.map((s) => s.end));
    const sentenceText = clipped.slice(start, end).trim();
    claims.push({
      ...c,
      text: sentenceText,
      sentence: sentenceText,
      start,
      end,
      query: c.searchQuery ?? "",
    });
  }
  return { claims, sentences, model: result.model, usage: result.usage };
}

/* ── critique ──────────────────────────────────────────────────────────── */

/** The relay's answer when the model returned nothing (api/critique.ts:95-107). */
const EMPTY_CRITIQUE = Object.freeze({
  critique: "Unable to generate a critique right now.",
  verdict: "unsupported",
  suggestedRevision: null,
  citationFix: null,
});

export const NO_EVIDENCE_SUMMARY = "No supporting evidence was found.";

/**
 * @param {{ claimText: string, strengthScore: number|null, evidenceSummary: string, referenceCheck?: string, model?, effort? }} req
 * @returns {{ critique, verdict, suggestedRevision, citationFix, model, usage }}
 */
export async function critique({ claimText, strengthScore, evidenceSummary, referenceCheck, model, effort, maxTokens = undefined }) {
  const claim = String(claimText ?? "").trim().slice(0, LIMITS.claimTextChars);
  if (!claim) throw new CheckError("bad_request", "claimText required");
  if (strengthScore !== null && typeof strengthScore !== "number") {
    throw new CheckError("bad_request", "strengthScore must be a number or null");
  }
  if (typeof evidenceSummary !== "string") throw new CheckError("bad_request", "evidenceSummary must be a string");
  if (referenceCheck != null && (typeof referenceCheck !== "string" || referenceCheck.length > LIMITS.referenceCheckChars)) {
    throw new CheckError("bad_request", `referenceCheck must be a string of at most ${LIMITS.referenceCheckChars} characters`);
  }
  const summary = evidenceSummary.slice(0, LIMITS.evidenceSummaryChars);
  // Byte-for-byte the relay's user message (api/critique.ts:61-64). The
  // "Reference lookup" heading is load-bearing: Pass 2(c) may only return
  // "fabricated" when it is PRESENT, so it is omitted — never sent empty —
  // when no lookup ran.
  const user =
    `Claim: "${claim}"\nEvidence strength score: ${strengthScore ?? "not yet computed"}/100\n\nTop evidence:\n${summary}` +
    (referenceCheck ? `\n\nReference lookup:\n${referenceCheck}` : "");

  let raw, used = model, usage = zeroUsage();
  if (isMock()) {
    raw = mockCritique(claim, summary);
    used = mockModel(model);
  } else {
    const out = await structuredCall({
      // `maxTokens`: server.js passes 4,000 on the thorough model (shared/plan.js THOROUGH_MAX_TOKENS).
      model, effort, maxTokens: maxTokens ?? MAX_OUTPUT.critique,
      system: CRITIQUE_SYSTEM_PROMPT, user,
      schema: CRITIQUE_SCHEMA.schema, name: CRITIQUE_SCHEMA.name,
      what: "critique",
    });
    raw = out.parsed;
    used = out.model;
    usage = out.usage;
  }
  if (!raw || typeof raw !== "object" || !raw.verdict) return { ...EMPTY_CRITIQUE, model: used, usage };
  // The desktop's guardrail, now run for every client: a revision may only
  // narrow, "overstated" needs a surviving revision, and "fabricated" is
  // withdrawn when no reference lookup ran.
  const normalized = normalizeCritique(raw, claim, { referenceLookupRan: Boolean(referenceCheck) });
  return { ...normalized, model: used, usage };
}

/**
 * The web app's (and the watch loop's) critique request, turned into the
 * relay's. They send raw sources, not a summary, and run no reference lookup —
 * so `referenceCheck` is absent, which is exactly what keeps "fabricated"
 * unreachable for them (Pass 2(c)).
 */
export function critiqueInputFromSources({ claim, sentence, sources }) {
  const list = (Array.isArray(sources) ? sources : []).slice(0, 4);
  const lines = list.map((s, i) => {
    const title = String(s?.title ?? "").slice(0, 200) || "Untitled source";
    const year = s?.year == null || s.year === "" ? "" : ` (${s.year})`;
    const abstract = s?.abstract ? ` — ${String(s.abstract).slice(0, 900)}` : "";
    return `${i + 1}. ${title}${year}${abstract}`;
  });
  return {
    claimText: String(sentence || claim || ""),
    strengthScore: null,
    evidenceSummary: lines.length ? lines.join("\n") : NO_EVIDENCE_SUMMARY,
  };
}

/* ── correction ────────────────────────────────────────────────────────── */

export async function correction({ claimText, contradictingPassages, model, effort }) {
  const claim = String(claimText ?? "").trim().slice(0, LIMITS.claimTextChars);
  if (!claim) throw new CheckError("bad_request", "claimText required");
  const passages = Array.isArray(contradictingPassages) ? contradictingPassages.filter((p) => typeof p === "string" && p.trim()) : [];
  if (passages.length < 1 || passages.length > LIMITS.correctionPassages) {
    throw new CheckError("bad_request", `contradictingPassages must hold 1 to ${LIMITS.correctionPassages} passages`);
  }
  // The budget is SHARED across passages, as on the relay (api/correction.ts:63-66).
  const per = Math.floor(LIMITS.evidenceSummaryChars / passages.length);
  const block = passages.map((p, i) => `[${i + 1}] ${p.slice(0, per)}`).join("\n\n");
  const user = `Claim as the student wrote it: "${claim}"\n\nPassages flagged as contradicting it:\n${block}`;

  let raw, used = model, usage = zeroUsage();
  if (isMock()) {
    raw = { contradicted: false, correction: null, reason: "Mock: the passages do not contradict the claim." };
    used = mockModel(model);
  } else {
    const out = await structuredCall({
      model, effort, maxTokens: MAX_OUTPUT.correction,
      system: CORRECTION_SYSTEM_PROMPT, user,
      schema: CORRECTION_SCHEMA.schema, name: CORRECTION_SCHEMA.name,
      what: "correction",
    });
    raw = out.parsed; used = out.model; usage = out.usage;
  }
  if (!raw || typeof raw !== "object") throw new CheckError("server", "Empty response from model", { status: 502 });
  const contradicted = raw.contradicted === true;
  // The relay's guard (api/correction.ts:101-103): no correction unless the
  // passages really contradict the claim.
  return {
    contradicted,
    correction: contradicted && typeof raw.correction === "string" && raw.correction.trim() ? raw.correction.trim() : null,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    model: used,
    usage,
  };
}

/* ── structure ─────────────────────────────────────────────────────────── */

export async function classifyStructure({ text, model, effort }) {
  const input = String(text).trim().slice(0, LIMITS.structureInputChars);
  if (!input) return { paragraphs: [], model: null, usage: zeroUsage() };
  if (isMock()) return { paragraphs: mockStructure(unnumber(input, /\n+/)), model: mockModel(model), usage: zeroUsage() };
  const { parsed, model: used, usage } = await structuredCall({
    model, effort, maxTokens: MAX_OUTPUT.structure,
    system: STRUCTURE_SYSTEM_PROMPT, user: input,
    schema: STRUCTURE_SCHEMA.schema, name: STRUCTURE_SCHEMA.name,
    what: "structure classification",
  });
  const paragraphs = Array.isArray(parsed?.paragraphs) ? parsed.paragraphs.slice(0, LIMITS.structureParagraphs) : [];
  return { paragraphs, model: used, usage };
}

/** The web app's form: a raw draft, split with the desktop's splitter. */
export function structurePromptFromDraft(draft) {
  const paras = argumentParagraphs(String(draft)).slice(0, LIMITS.structureParagraphs).map((p) => p.text);
  return paras.map((p, i) => `[${i + 1}] ${p}`).join("\n");
}

/* ── grade ─────────────────────────────────────────────────────────────── */

/**
 * @param {{ text: string }} req  numbered paragraphs, as buildGradePrompt makes them
 * @returns the relay's graded draft, VERIFIED: findings whose quote is not in
 *   the paragraphs sent, whose paragraph does not exist, or whose rubric
 *   section is not the owner's are dropped (the desktop's verifyGrade).
 */
export async function gradeDraft({ text, model, effort }) {
  const input = String(text).trim().slice(0, LIMITS.gradeInputChars);
  const paragraphTexts = unnumber(input, /\n\s*\n/);
  if (paragraphTexts.length === 0) throw new CheckError("bad_request", "text required");
  let raw, used = model, usage = zeroUsage();
  if (isMock()) {
    raw = mockGrade(paragraphTexts);
    used = mockModel(model);
  } else {
    const out = await structuredCall({
      model, effort, maxTokens: MAX_OUTPUT.grade,
      system: GRADE_SYSTEM_PROMPT, user: input,
      schema: GRADE_SCHEMA.schema, name: GRADE_SCHEMA.name,
      what: "grading",
    });
    raw = out.parsed; used = out.model; usage = out.usage;
  }
  // Quotes are located against exactly what the model was shown.
  const verified = verifyGrade(raw, paragraphTexts.join("\n\n"), paragraphTexts.length);
  if (!verified) throw new CheckError("server", "Model returned an unusable grade.", { status: 502 });
  const { dropped, ...grade } = verified;
  if (dropped.length) console.warn(`[grade] dropped ${dropped.length} finding(s): ${dropped.map((d) => d.reason).join("; ")}`);
  // Back to the relay's shape: `span` is the verifier's working, and the
  // desktop re-locates quotes against the full document on its own side.
  grade.findings = grade.findings.map(({ span, ...f }) => f);
  return { ...grade, model: used, usage };
}

/** The web app's form: a raw draft, split and capped exactly as the desktop does. */
export function gradePromptFromDraft(draft) {
  const paras = argumentParagraphs(String(draft)).map((p) => p.text);
  return {
    prompt: buildGradePrompt(paras, { maxParagraphs: LIMITS.gradeParagraphs, maxInputChars: LIMITS.gradeInputChars }),
    paragraphTexts: paras,
  };
}

/* ── tracer ────────────────────────────────────────────────────────────── */

/**
 * Stateless, as on the relay: the client sends the history it holds.
 * `context` goes in as its own system-role message ahead of the history, and
 * TRACER_SYSTEM_PROMPT stays the byte-constant instructions, so the prompt
 * prefix caches across every conversation.
 */
export async function tracerReply({ message, history, context, model, effort }) {
  const msg = String(message ?? "").trim().slice(0, LIMITS.tracerMessageChars);
  if (!msg) throw new CheckError("bad_request", "message required");
  const turns = (Array.isArray(history) ? history : [])
    .slice(-LIMITS.tracerHistory)
    .filter((h) => h && (h.role === "user" || h.role === "tracer" || h.role === "assistant"))
    .map((h) => ({ role: h.role === "user" ? "user" : "assistant", content: String(h.content ?? "").slice(0, LIMITS.tracerMessageChars) }));
  const ctx = String(context ?? "").trim().slice(0, LIMITS.tracerContextChars);
  const messages = [
    ...(ctx ? [{ role: "system", content: `Context on what the student is working on:\n\n${ctx}` }] : []),
    ...turns,
    { role: "user", content: msg },
  ];
  if (isMock()) return { reply: mockTracer(msg, turns.length), model: mockModel(model), usage: zeroUsage() };
  const out = await textCall({ model, effort, system: TRACER_SYSTEM_PROMPT, messages, maxTokens: MAX_OUTPUT.tracer, what: "tracer" });
  const reply = String(out.text ?? "").trim();
  if (!reply) throw new CheckError("server", "Tracer did not return a reply. Try asking again.", { status: 502 });
  return { reply, model: out.model, usage: out.usage };
}

/* ── find-sources ──────────────────────────────────────────────────────── */

export async function findSources({ claim, context, model, effort }) {
  const c = String(claim ?? "").trim().slice(0, LIMITS.sourceClaimChars);
  if (!c) throw new CheckError("bad_request", "claim required");
  const ctx = typeof context === "string" ? context.trim().slice(0, LIMITS.sourceContextChars) : "";
  // The relay's user message (api/find-sources.ts:80-82).
  const user = ctx
    ? `CLAIM TO SOURCE:\n${c}\n\nTHE DRAFT THIS IS FROM (for context — do not source these):\n${ctx}`
    : `CLAIM TO SOURCE:\n${c}`;
  if (isMock()) return { ...mockSources(c), model: mockModel(model), usage: zeroUsage() };
  const out = await webSearchStructuredCall({
    model, effort, maxTokens: MAX_OUTPUT.sources,
    system: SOURCE_SEARCH_SYSTEM_PROMPT, user,
    schema: SOURCE_SEARCH_SCHEMA.schema, name: SOURCE_SEARCH_SCHEMA.name,
    what: "source search",
  });
  return { ...out.parsed, model: out.model, usage: out.usage, webSearchCalls: out.webSearchCalls };
}

/* ── mocks: deterministic, same shapes, no key ─────────────────────────── */

function zeroUsage() {
  return { input: 0, output: 0, cached: 0 };
}
const mockModel = (model) => `${model ?? DEFAULT_MODEL} (mock)`;

function mockDetect(input, model) {
  // Every sentence carrying a digit, capitalised name or causal word is a claim.
  const units = [...input.matchAll(/\[(\d+)\]\s([^[]*)/g)].map((m) => ({ i: Number(m[1]), s: m[2].trim() }));
  const claims = units
    .filter((u) => /\d|because|causes?|leads? to|[A-Z][a-z]+ [A-Z]/.test(u.s))
    .slice(0, LIMITS.claimsPerAnalysis)
    .map((u) => ({
      sentenceIndices: [u.i],
      claimType: /\d/.test(u.s) ? "statistic" : /because|cause|lead/.test(u.s) ? "causal" : "factual",
      confidence: 0.8,
      searchQuery: u.s.split(/\s+/).slice(0, 6).join(" "),
    }));
  return { claims, model: mockModel(model), usage: zeroUsage() };
}

function mockCritique(claim, summary) {
  const absolute = /\b(always|never|every|all|100%|proves?)\b/i.test(claim);
  const noEvidence = summary.trim() === NO_EVIDENCE_SUMMARY;
  if (absolute) {
    return {
      critique: "Mock: the claim is phrased more absolutely than evidence could support.",
      verdict: "overstated",
      suggestedRevision: claim.replace(/\b(always|never|every|all|100%)\b/i, "often"),
      citationFix: null,
    };
  }
  return {
    critique: noEvidence
      ? "Mock: nothing in the evidence speaks to this claim."
      : "Mock: the evidence supports the claim as written.",
    verdict: noEvidence ? "unsupported" : "well-supported",
    suggestedRevision: null,
    citationFix: null,
  };
}

function mockStructure(paragraphs) {
  const n = paragraphs.length;
  return paragraphs.slice(0, LIMITS.structureParagraphs).map((_, i) => ({
    index: i + 1,
    role: i === 0 ? "thesis" : i === n - 1 && n > 2 ? "conclusion" : "claim",
    hasWarrant: true,
    statesClaim: i !== n - 1,
    reasoningFailure: "none",
  }));
}

function mockGrade(paragraphs) {
  const first = paragraphs[0] ?? "";
  const quote = first.split(/(?<=[.!?])\s+/)[0] ?? "";
  const comp = (score, reason) => ({ score, quote, reason });
  return {
    paragraphs: paragraphs.map((_, i) => ({
      index: i + 1,
      role: i === 0 ? "thesis" : i === paragraphs.length - 1 && paragraphs.length > 2 ? "conclusion" : "claim",
      statesClaim: true,
      hasWarrant: true,
      reasoningFailure: "none",
    })),
    components: {
      thesis: comp(16, "Mock: an arguable position is stated."),
      governingClaims: comp(15, "Mock: most body paragraphs govern a claim."),
      warrant: comp(14, "Mock: the evidence is explained."),
      counterargument: comp(8, "Mock: a counterargument is raised briefly."),
      significance: comp(10, "Mock: the stakes are named."),
      conclusion: comp(7, "Mock: the conclusion draws on the body."),
    },
    counterargumentApplicable: true,
    findings: [],
    summary: "Mock grade.",
  };
}

function mockTracer(message, priorTurns) {
  return `Mock Tracer (${priorTurns} earlier turn${priorTurns === 1 ? "" : "s"}): what is the strongest evidence you have for "${message.slice(0, 60)}"?`;
}

function mockSources(claim) {
  return {
    searchesRun: [claim.slice(0, 60)],
    assertions: [claim.slice(0, 120)],
    sources: [{
      title: "Mock source",
      url: "https://example.org/mock-source",
      publisher: "Example Institute",
      year: 2024,
      kind: "institutional",
      authors: [],
      supports: `Mock: states that ${claim.slice(0, 80)}`,
      echoes: null,
      strength: "direct",
    }],
    claimProblem: null,
    revisedClaim: null,
    disputed: false,
    note: "Mock source search.",
  };
}
