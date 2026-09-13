/**
 * AI pipeline calls — claim detection, critique, grading, structure, tracer.
 * Every one of these funnels through lib/llm.js, the single place Tracely
 * talks to OpenAI: model allowlist, strict JSON schemas, refusal/truncation
 * handling and error mapping all live there, so this file is prompts + shape
 * validation and nothing else.
 *
 * Exports (all async, all throw CheckError on failure):
 *   detectClaims({ text, model, effort })            → { claims: [{ text, sentence, start, end, claimType, confidence, query }], model, usage }
 *   critiqueClaim({ claim, sentence, citedRef, sources, model }) → { verdict, explanation, revision, overstated, confidence, model, usage }
 *   gradeDraft({ text, level, model })               → { components, model, usage } (counterargument may carry absent:true)
 *   gradeWithCustomRubric({ text, rubric, level, model }) → { components, custom, model, usage }
 *   classifyStructure({ text, model })               → { paragraphs: [{ index, role, faults }], model, usage }
 *   tracerReply({ messages, draft, model })          → { reply, model, usage }
 *
 * MOCK MODE (TRACELY_MOCK=1): every function returns deterministic canned
 * output with no API calls, mirroring factcheck.js.
 */
import { CheckError } from "./errors.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, structuredCall as llmCall, textCall } from "./llm.js";
import { GUARDS } from "../shared/guards.js";
import { MAX_CUSTOM_COMPONENTS, normalizeCustomComponents, RUBRIC } from "../shared/rubric.js";

const ALLOWED_EFFORT = new Set(["low", "medium", "high"]);
const DEFAULT_EFFORT = "low";

const CLAIM_TYPES = ["factual", "statistic", "causal", "opinion", "prediction"];
const VERDICTS = ["contradicted", "citationFix", "fabricated", "weak", "unsupported", "sound"];
const PARA_ROLES = ["thesis", "claim", "evidence", "counterargument", "significance", "conclusion", "other"];
const MIN_CLAIM_CONFIDENCE = 0.35;

const isMock = () => process.env.TRACELY_MOCK === "1";
const chooseModel = (model) => (ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL);
const chooseEffort = (effort) => (ALLOWED_EFFORT.has(effort) ? effort : DEFAULT_EFFORT);
const zeroUsage = () => ({ input: 0, output: 0, cached: 0 });

/* Same signature the five callers below already use; `what` doubles as the
 * json_schema name, which OpenAI requires to match /^[a-zA-Z0-9_-]+$/. */
async function structuredCall({ model, effort, maxTokens, system, user, schema, what }) {
  return llmCall({
    model,
    effort,
    maxTokens,
    system,
    user,
    schema,
    what,
    name: what.replace(/[^a-zA-Z0-9_-]+/g, "_"),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. detectClaims
// ═══════════════════════════════════════════════════════════════════════════

const DETECT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sentence: { type: "string" },
          claimType: { type: "string", enum: CLAIM_TYPES },
          confidence: { type: "number" },
          query: { type: "string" },
        },
        required: ["text", "sentence", "claimType", "confidence", "query"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

function detectSystemPrompt() {
  return `You are Tracely's claim detector inside a student writing tool. Given a draft, find every CHECKABLE claim — an assertion whose truth could in principle be verified or challenged with evidence.

For each claim return:
- "text": the claim itself, copied EXACTLY, character for character, from the draft. The claim is a SUB-SPAN of its sentence: just the assertion. A trailing reference or citation marker (e.g. "(Smith, 2019)", "[3]") sits OUTSIDE the claim text. Never paraphrase, never fix typos, never add or remove characters — the text must be findable verbatim in the draft.
- "sentence": the full containing sentence, also copied exactly from the draft (this one includes any citation).
- "claimType": one of "factual" (a fact about the world), "statistic" (a number, rate, or quantity), "causal" (X causes/leads to Y), "opinion" (a value judgment presented as assertion), "prediction" (a claim about the future).
- "confidence": 0 to 1 — how confident you are that this is a checkable claim worth verifying (not that the claim is true).
- "query": a short web-search-style query (a few keywords) that would surface evidence for or against the claim. The query MUST be self-contained: resolve every pronoun and reference from the surrounding text into its actual name ("He was famous for X" after a sentence about Einstein → "Einstein famous for X", never "he famous for X"). A query a stranger could not interpret without the draft is wrong.

Rules:
- Only extract claims that actually appear in the draft. One entry per distinct claim; a sentence can contain more than one.
- Skip questions, instructions, greetings, section headings, and clearly framed personal experience.
- Prefer the tightest span that still reads as a complete assertion.
- Return at most ${GUARDS.maxClaimsPerAnalysis} claims, preferring the most consequential; omit claims you'd rate below ${MIN_CLAIM_CONFIDENCE} confidence.`;
}

export async function detectClaims({ text, model, effort } = {}) {
  const chosenModel = chooseModel(model);
  if (typeof text !== "string" || !text.trim()) {
    throw new CheckError("bad_request", "detectClaims needs text");
  }
  const input = text.slice(0, GUARDS.maxInputChars);
  if (isMock()) return mockDetect(input, chosenModel);

  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    effort: chooseEffort(effort),
    maxTokens: 32_000, // calls stream, so a high ceiling costs nothing when unused
    system: detectSystemPrompt(),
    user: `DRAFT:\n"""\n${input}\n"""\n\nFind the checkable claims.`,
    schema: DETECT_SCHEMA,
    what: "claim detection",
  });

  const claims = [];
  for (const raw of Array.isArray(parsed.claims) ? parsed.claims : []) {
    if (claims.length >= GUARDS.maxClaimsPerAnalysis) break;
    if (!raw || typeof raw.text !== "string" || !raw.text.trim()) continue;
    const confidence = clamp01(raw.confidence);
    if (confidence < MIN_CLAIM_CONFIDENCE) continue;
    const claimText = raw.text;
    const sentenceText = typeof raw.sentence === "string" ? raw.sentence : "";
    // We compute offsets ourselves: indexOf from the sentence's position;
    // claims we cannot locate verbatim are dropped.
    const sentStart = sentenceText ? input.indexOf(sentenceText) : -1;
    let start = sentStart >= 0 ? input.indexOf(claimText, sentStart) : -1;
    if (start < 0) start = input.indexOf(claimText);
    if (start < 0) continue;
    claims.push({
      text: claimText,
      sentence: sentenceText || claimText,
      start,
      end: start + claimText.length,
      claimType: CLAIM_TYPES.includes(raw.claimType) ? raw.claimType : "factual",
      confidence,
      query: String(raw.query ?? "").slice(0, 200),
    });
  }

  return { claims, model: usedModel, usage };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. critiqueClaim
// ═══════════════════════════════════════════════════════════════════════════

const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    explanation: { type: "string" },
    revision: { type: "string" },
    overstated: { type: "boolean" },
    confidence: { type: "number" },
  },
  required: ["verdict", "explanation", "revision", "overstated", "confidence"],
  additionalProperties: false,
};

function critiqueSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Tracely's fact-checker inside a student writing tool. You receive one claim from a draft, its sentence, optionally the citation the writer attached, and optionally a list of retrieved candidate sources. Run three passes and fold them into ONE verdict:

(a) Is the claim TRUE as stated, on your own knowledge?
(b) If a cited reference is present: is that source real, and is it plausibly the kind of work that says what the sentence uses it for?
(c) Do the provided sources (titles, venues, years, abstracts) actually carry the sentence — support it, contradict it, or fail to speak to it?

Verdicts (pick exactly one):
- "contradicted": a specific fact in the claim is wrong.
- "citationFix": the citation is malformed or mismatched to the sentence, but the source itself appears real.
- "fabricated": the cited source appears NOT TO EXIST. Only use this when a citation is present and you strongly suspect it is invented — never merely because retrieval found nothing.
- "weak": the evidence only weakly supports the claim.
- "unsupported": no provided evidence carries the claim (and you cannot vouch for it yourself).
- "sound": the claim holds and the evidence situation is fine.

Also return:
- "overstated": true when the claim overshoots what the evidence supports (a narrower version would be defensible), regardless of verdict.
- "explanation": at most 30 words, concrete — name the wrong fact, the mismatch, or the gap. Empty string is not allowed; for "sound" say briefly why it holds.
- "revision": a minimal rewrite of the claim that fixes the problem while keeping the writer's voice. Empty string when the verdict is "sound".
- "confidence": 0 to 1 in your verdict.

Today's date is ${today}. If the claim depends on events after your knowledge, do not call it contradicted — prefer "weak" or "unsupported" and say why.`;
}

export async function critiqueClaim({ claim, sentence, citedRef, sources, model } = {}) {
  const chosenModel = chooseModel(model);
  if (typeof claim !== "string" || !claim.trim()) {
    throw new CheckError("bad_request", "critiqueClaim needs a claim");
  }
  if (isMock()) return mockCritique({ claim, citedRef, sources, model: chosenModel });

  const srcList = (Array.isArray(sources) ? sources : []).slice(0, 12).map((s, i) => {
    const bits = [
      `[S${i + 1}] ${String(s?.title ?? "Untitled").slice(0, 200)}`,
      s?.venue ? `venue: ${String(s.venue).slice(0, 120)}` : "",
      s?.year ? `year: ${s.year}` : "",
      s?.url ? `url: ${String(s.url).slice(0, 300)}` : "",
      s?.abstract ? `abstract: ${String(s.abstract).slice(0, 600)}` : "",
    ].filter(Boolean);
    return bits.join("\n  ");
  });

  const user =
    `CLAIM:\n${claim.slice(0, 2000)}\n\n` +
    `SENTENCE:\n${String(sentence ?? claim).slice(0, 2000)}\n\n` +
    (citedRef ? `WRITER'S CITATION:\n${String(citedRef).slice(0, 1000)}\n\n` : "WRITER'S CITATION: none\n\n") +
    (srcList.length > 0 ? `RETRIEVED SOURCES:\n${srcList.join("\n")}\n\n` : "RETRIEVED SOURCES: none\n\n") +
    "Run the three passes and return one verdict.";

  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    effort: DEFAULT_EFFORT,
    maxTokens: 16_000,
    system: critiqueSystemPrompt(),
    user,
    schema: CRITIQUE_SCHEMA,
    what: "critique",
  });

  let verdict = VERDICTS.includes(parsed.verdict) ? parsed.verdict : "unsupported";
  // Never call fabrication on retrieval absence alone — it needs a citation to accuse.
  if (verdict === "fabricated" && !citedRef) verdict = "unsupported";

  return {
    verdict,
    explanation: String(parsed.explanation ?? "").slice(0, 400),
    revision: verdict === "sound" ? "" : String(parsed.revision ?? "").slice(0, 2000),
    overstated: Boolean(parsed.overstated),
    confidence: clamp01(parsed.confidence),
    model: usedModel,
    usage,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. gradeDraft
// ═══════════════════════════════════════════════════════════════════════════

const SCORED = (extra = {}) => ({
  type: "object",
  properties: {
    score: { type: "number" },
    quote: { type: "string" },
    note: { type: "string" },
    ...extra,
  },
  required: ["score", "quote", "note", ...Object.keys(extra)],
  additionalProperties: false,
});

const GRADE_SCHEMA = {
  type: "object",
  properties: {
    thesis: SCORED(),
    governingClaims: {
      type: "object",
      properties: {
        paragraphsGoverning: { type: "integer" },
        bodyParagraphs: { type: "integer" },
        quote: { type: "string" },
        note: { type: "string" },
      },
      required: ["paragraphsGoverning", "bodyParagraphs", "quote", "note"],
      additionalProperties: false,
    },
    warrant: SCORED(),
    counterargument: SCORED({ absent: { type: "boolean" } }),
    significance: SCORED(),
    conclusion: SCORED(),
  },
  required: ["thesis", "governingClaims", "warrant", "counterargument", "significance", "conclusion"],
  additionalProperties: false,
};

function gradeSystemPrompt() {
  return `You are Tracely's grader inside a student writing tool. Grade the draft against this rubric, component by component:

- thesis (0-${RUBRIC.thesis.points}): ${RUBRIC.thesis.text}
- governingClaims: ${RUBRIC.governingClaims.text} Do NOT score this one — instead COUNT: "bodyParagraphs" (paragraphs that are neither introduction nor conclusion) and "paragraphsGoverning" (how many of those open with or are governed by a claim that advances the thesis). The score is computed from the fraction, not by you.
- warrant (0-${RUBRIC.warrant.points}): ${RUBRIC.warrant.text}
- counterargument (0-${RUBRIC.counterargument.points}): ${RUBRIC.counterargument.text} When the draft contains NO counterargument at all, set "absent": true, "score": 0, "quote": "" and say so in the note — do not score what is not there.
- significance (0-${RUBRIC.significance.points}): ${RUBRIC.significance.text}
- conclusion (0-${RUBRIC.conclusion.points}): ${RUBRIC.conclusion.text}

For every component:
- "quote": a VERBATIM quotation from the draft that grounds your judgment — an EXACT substring, copied character for character. No ellipses, no paraphrase, no stitched-together fragments; the client machine-checks that the quote exists in the draft and discards quotes that do not. Keep it short (a phrase or one sentence). For counterargument with absent:true, use "".
- "note": at most 25 words, concrete and useful to the student.
- "score": an integer within the component's range (except governingClaims, where you only report the two counts).

The scores stay anchored to the rubric regardless of grade level — level credit is applied separately. Adjust only the TONE of your notes to the student's grade level.`;
}

export async function gradeDraft({ text, level, model } = {}) {
  const chosenModel = chooseModel(model);
  if (typeof text !== "string" || !text.trim()) {
    throw new CheckError("bad_request", "gradeDraft needs text");
  }
  const input = text.slice(0, GUARDS.maxInputChars);
  const lv = Math.min(12, Math.max(3, Number(level) || 12));
  if (isMock()) return mockGrade(input, chosenModel);

  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    effort: DEFAULT_EFFORT,
    maxTokens: 16_000,
    system: gradeSystemPrompt(),
    user: `STUDENT GRADE LEVEL: ${lv}\n\nDRAFT:\n"""\n${input}\n"""\n\nGrade every component.`,
    schema: GRADE_SCHEMA,
    what: "grading",
  });

  const components = {
    thesis: scoredComponent(parsed.thesis, RUBRIC.thesis.points),
    governingClaims: governingComponent(parsed.governingClaims),
    warrant: scoredComponent(parsed.warrant, RUBRIC.warrant.points),
    counterargument: counterComponent(parsed.counterargument),
    significance: scoredComponent(parsed.significance, RUBRIC.significance.points),
    conclusion: scoredComponent(parsed.conclusion, RUBRIC.conclusion.points),
  };

  return { components, model: usedModel, usage };
}

function scoredComponent(raw, points) {
  return {
    score: clampScore(raw?.score, points),
    quote: String(raw?.quote ?? "").slice(0, 600),
    note: String(raw?.note ?? "").slice(0, 300),
  };
}

function governingComponent(raw) {
  const bodyParagraphs = Math.max(0, Math.round(Number(raw?.bodyParagraphs) || 0));
  const paragraphsGoverning = Math.min(bodyParagraphs, Math.max(0, Math.round(Number(raw?.paragraphsGoverning) || 0)));
  const fraction = bodyParagraphs > 0 ? paragraphsGoverning / bodyParagraphs : 0;
  return {
    score: Math.round(RUBRIC.governingClaims.points * fraction),
    quote: String(raw?.quote ?? "").slice(0, 600),
    note: String(raw?.note ?? "").slice(0, 300),
    paragraphsGoverning,
    bodyParagraphs,
  };
}

function counterComponent(raw) {
  if (raw?.absent) {
    return { absent: true, score: 0, quote: "", note: String(raw?.note ?? "No counterargument found.").slice(0, 300) };
  }
  return scoredComponent(raw, RUBRIC.counterargument.points);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3b. gradeWithCustomRubric — a pasted (teacher's) rubric replaces the
// built-in components wholesale. The model extracts what the rubric scores
// and judges each component; the client still does the arithmetic.
// ═══════════════════════════════════════════════════════════════════════════

const CUSTOM_GRADE_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      minItems: 0,
      maxItems: MAX_CUSTOM_COMPONENTS,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          points: { type: "integer" },
          score: { type: "integer" },
          quote: { type: "string" },
          note: { type: "string" },
        },
        required: ["title", "points", "score", "quote", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["components"],
  additionalProperties: false,
};

function customGradeSystemPrompt(rubricText) {
  return `You are Tracely's grader inside a student writing tool. A teacher's own rubric replaces the built-in one for this draft. Here it is, verbatim:

"""
${rubricText}
"""

First extract the scored components of THAT rubric: each gets a short "title" (their words, not yours) and its "points" — the maximum the rubric assigns it. If the rubric assigns no point values, weight every component equally at 10 points. At most ${MAX_CUSTOM_COMPONENTS} components; fold sub-criteria into their parent rather than dropping them. If the pasted text contains no gradable criteria at all, return an empty components array.

Then grade the draft against each component:
- "score": an integer from 0 to that component's points.
- "quote": a VERBATIM quotation from the draft that grounds your judgment — an EXACT substring, copied character for character. No ellipses, no paraphrase, no stitched-together fragments; the client machine-checks that the quote exists in the draft and discards quotes that do not. Keep it short (a phrase or one sentence). Use "" when nothing in the draft speaks to the component.
- "note": at most 25 words, concrete and useful to the student.

Judge ONLY what the rubric asks. Do not import expectations it never states, and do not skip ones it does state because they seem minor. The scores stay anchored to the rubric regardless of grade level — level credit is applied separately. Adjust only the TONE of your notes to the student's grade level.`;
}

export async function gradeWithCustomRubric({ text, rubric, level, model } = {}) {
  const chosenModel = chooseModel(model);
  if (typeof text !== "string" || !text.trim()) {
    throw new CheckError("bad_request", "gradeWithCustomRubric needs text");
  }
  if (typeof rubric !== "string" || !rubric.trim()) {
    throw new CheckError("bad_request", "gradeWithCustomRubric needs a rubric");
  }
  const input = text.slice(0, GUARDS.maxInputChars);
  const lv = Math.min(12, Math.max(3, Number(level) || 12));
  if (isMock()) return mockCustomGrade(input, rubric, chosenModel);

  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    effort: DEFAULT_EFFORT,
    maxTokens: 16_000,
    system: customGradeSystemPrompt(rubric),
    user: `STUDENT GRADE LEVEL: ${lv}\n\nDRAFT:\n"""\n${input}\n"""\n\nGrade every component of the teacher's rubric.`,
    schema: CUSTOM_GRADE_SCHEMA,
    what: "grading (custom rubric)",
  });

  const components = normalizeCustomComponents(parsed.components);
  if (components.length === 0) {
    // Honest failure over a silent fallback to the built-in rubric: the user
    // asked for THEIR rubric, and grading with a different one unannounced is
    // worse than saying this one could not be read.
    throw new CheckError("bad_request", "Could not find any scorable components in that rubric. Check the pasted text in Settings.");
  }
  return { components, custom: true, model: usedModel, usage };
}

function mockCustomGrade(text, rubric, model) {
  const sentences = mockSentencesOf(text);
  const first = sentences[0] ?? "";
  const mid = sentences[Math.floor(sentences.length / 2)] ?? first;
  // Deterministic: one component per non-empty rubric line that carries a
  // point value, else three equal-weight stand-ins.
  const lines = rubric.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const pointed = lines
    .map((l) => ({ title: l.replace(/[:(].*$/, "").trim().slice(0, 60), points: Number((l.match(/(\d+)\s*(?:points|pts)/i) ?? [])[1]) }))
    .filter((c) => c.title && Number.isFinite(c.points) && c.points > 0)
    .slice(0, MAX_CUSTOM_COMPONENTS);
  const base = pointed.length > 0 ? pointed : [
    { title: "Ideas", points: 10 },
    { title: "Organization", points: 10 },
    { title: "Conventions", points: 10 },
  ];
  const components = base.map((c, i) => ({
    ...c,
    score: Math.max(0, Math.round(c.points * 0.7) - (i % 2)),
    quote: (i === 0 ? first : mid).slice(0, 200),
    note: `Mock mode: judged against "${c.title}".`,
  }));
  return { components: normalizeCustomComponents(components), custom: true, model, usage: zeroUsage() };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. classifyStructure
// ═══════════════════════════════════════════════════════════════════════════

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          role: { type: "string", enum: PARA_ROLES },
          faults: { type: "array", items: { type: "string" } },
        },
        required: ["index", "role", "faults"],
        additionalProperties: false,
      },
    },
  },
  required: ["paragraphs"],
  additionalProperties: false,
};

function structureSystemPrompt() {
  return `You are Tracely's structure analyst inside a student writing tool. You receive a draft split into numbered paragraphs. For EVERY paragraph, return exactly one entry:

- "index": the paragraph's number as given (0-based).
- "role": the paragraph's argumentative job — one of "thesis", "claim", "evidence", "counterargument", "significance", "conclusion", or "other" when none fits.
- "faults": named reasoning faults present in the paragraph, or [] when it is clean. Use short kebab-case names such as "non-sequitur", "circular", "unsupported-leap", "restatement", "contradiction", "strawman". Only name faults you can point to; an empty list is the common case.

Judge each paragraph in the context of the whole draft. A paragraph has one primary role — pick the dominant one.`;
}

function splitParagraphs(text) {
  return String(text ?? "")
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export async function classifyStructure({ text, model } = {}) {
  const chosenModel = chooseModel(model);
  if (typeof text !== "string" || !text.trim()) {
    throw new CheckError("bad_request", "classifyStructure needs text");
  }
  const input = text.slice(0, GUARDS.maxInputChars);
  const paras = splitParagraphs(input);
  if (isMock()) return mockStructure(paras, chosenModel);
  if (paras.length === 0) return { paragraphs: [], model: chosenModel, usage: zeroUsage() };

  const numbered = paras.map((p, i) => `[${i}]\n${p}`).join("\n\n");
  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    effort: DEFAULT_EFFORT,
    maxTokens: 8_000,
    system: structureSystemPrompt(),
    user: `PARAGRAPHS:\n${numbered}\n\nReturn one entry per paragraph index, 0 through ${paras.length - 1}.`,
    schema: STRUCTURE_SCHEMA,
    what: "structure",
  });

  const byIndex = new Map();
  for (const raw of Array.isArray(parsed.paragraphs) ? parsed.paragraphs : []) {
    const idx = Math.round(Number(raw?.index));
    if (!Number.isInteger(idx) || idx < 0 || idx >= paras.length || byIndex.has(idx)) continue;
    byIndex.set(idx, {
      index: idx,
      role: PARA_ROLES.includes(raw.role) ? raw.role : "other",
      faults: (Array.isArray(raw.faults) ? raw.faults : [])
        .map((f) => String(f).slice(0, 60))
        .filter(Boolean)
        .slice(0, 6),
    });
  }
  const paragraphs = paras.map((_, i) => byIndex.get(i) ?? { index: i, role: "other", faults: [] });

  return { paragraphs, model: usedModel, usage };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. tracerReply
// ═══════════════════════════════════════════════════════════════════════════

function tracerSystemPrompt() {
  return `You are Tracer, the writing tutor inside Tracely, a credibility checker for student writing. You sit in a small chat panel beside the student's draft.

Your manner:
- Ask questions before prescribing. Understand what the student is trying to say before suggesting how to say it.
- Reference the draft concretely: quote short phrases from it (a few words in quotation marks) so the student knows exactly what you mean.
- NEVER write paragraphs, sentences, or thesis statements for the student. You may name what a stronger version would do; the student writes it.
- Keep every reply to 180 words or fewer. One or two questions or one focused suggestion per turn beats a lecture.
- Plain text only: no markdown headers, no bullet-point essays. Short paragraphs are fine.
- Be warm but honest — a good tutor names the real problem kindly.`;
}

export async function tracerReply({ messages, draft, model } = {}) {
  const chosenModel = chooseModel(model);
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (history.length > 0 && history[0].role !== "user") history.shift();
  if (history.length === 0) {
    throw new CheckError("bad_request", "tracerReply needs at least one user message");
  }
  const draftText = typeof draft === "string" ? draft.slice(0, GUARDS.maxInputChars) : "";
  if (isMock()) return mockTracer({ history, draft: draftText, model: chosenModel });

  // The draft rides in the instructions rather than the history so that an
  // unchanged draft stays a stable prefix across turns — the same reason it
  // used to carry its own cache breakpoint.
  const system = draftText.trim()
    ? `${tracerSystemPrompt()}\n\nThe student's current draft:\n"""\n${draftText}\n"""`
    : `${tracerSystemPrompt()}\n\nThe student has not shared a draft yet.`;

  const { text: reply, model: usedModel, usage } = await textCall({
    model: chosenModel,
    system,
    messages: history,
    maxTokens: 8_000,
    what: "tracer reply",
    effort: DEFAULT_EFFORT,
  });

  if (!reply) {
    // An empty turn, or output budget spent entirely on reasoning — either way
    // there is no reply to store.
    throw new CheckError("server", "The model returned an empty reply — try again.", { status: 502 });
  }

  return { reply: reply.slice(0, 4000), model: usedModel, usage };
}

// ── small shared helpers ───────────────────────────────────────────────
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function clampScore(n, points) {
  const v = Math.round(Number(n) || 0);
  return Math.min(points, Math.max(0, v));
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock mode (TRACELY_MOCK=1): deterministic canned output so the UI can be
// exercised end-to-end without an API key. Never used with a key.
// ═══════════════════════════════════════════════════════════════════════════

const MOCK_CLAIM_RULES = [
  {
    re: /[^.!?\n]*Great Wall[^.!?\n]*/i,
    claimType: "factual",
    confidence: 0.95,
    query: "Great Wall of China visible from space naked eye",
  },
  {
    re: /[^.!?\n]*Einstein[^.!?\n]*/i,
    claimType: "factual",
    confidence: 0.9,
    query: "Einstein failed math school myth",
  },
  {
    re: /[^.!?\n]*Napoleon[^.!?\n]*/i,
    claimType: "factual",
    confidence: 0.9,
    query: "Napoleon Bonaparte height average era",
  },
];

function mockDetect(text, model) {
  const claims = [];
  for (const rule of MOCK_CLAIM_RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const claimText = raw.trim();
    if (!claimText) continue;
    const start = m.index + lead;
    const end = start + claimText.length;
    const punct = /[.!?]/.test(text[end] ?? "") ? text[end] : "";
    claims.push({
      text: claimText,
      sentence: claimText + punct,
      start,
      end,
      claimType: rule.claimType,
      confidence: rule.confidence,
      query: rule.query,
    });
    if (claims.length >= GUARDS.maxClaimsPerAnalysis) break;
  }
  return { claims, model: `${model} (mock)`, usage: zeroUsage() };
}

const MOCK_CRITIQUES = [
  {
    re: /visible from space/i,
    verdict: "contradicted",
    explanation: "Astronauts report the Great Wall is not visible to the naked eye from orbit.",
    revision: "Contrary to popular belief, the Great Wall of China is not visible to the naked eye from space.",
    overstated: true,
  },
  {
    re: /einstein/i,
    verdict: "contradicted",
    explanation: "Einstein excelled at mathematics; the 'failed math' story is a myth.",
    revision: "Contrary to a popular myth, Albert Einstein excelled at mathematics from a young age.",
    overstated: false,
  },
  {
    re: /napoleon/i,
    verdict: "contradicted",
    explanation: "Napoleon was about 5'7\" — average height for his era; the myth comes from unit confusion.",
    revision: "Despite the famous myth, Napoleon was around average height for a Frenchman of his era.",
    overstated: false,
  },
];

function mockCritique({ claim, citedRef, sources, model }) {
  const base = { model: `${model} (mock)`, usage: zeroUsage(), confidence: 0.9 };
  const rule = MOCK_CRITIQUES.find((r) => r.re.test(claim));
  if (rule) {
    return { verdict: rule.verdict, explanation: rule.explanation, revision: rule.revision, overstated: rule.overstated, ...base };
  }
  if (citedRef && /imaginary|made.?up|fictitious/i.test(citedRef)) {
    return {
      verdict: "fabricated",
      explanation: "Mock mode: the cited source could not be found and looks invented.",
      revision: claim,
      overstated: false,
      ...base,
    };
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      verdict: "unsupported",
      explanation: "Mock mode: no provided evidence carries this claim.",
      revision: `${String(claim).replace(/\.$/, "")} (citation needed).`,
      overstated: false,
      ...base,
      confidence: 0.6,
    };
  }
  return { verdict: "sound", explanation: "Mock mode: claim holds against the provided sources.", revision: "", overstated: false, ...base };
}

function mockSentencesOf(text) {
  return (text.match(/[^.!?\n]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function mockGrade(text, model) {
  const sentences = mockSentencesOf(text);
  const paras = splitParagraphs(text);
  const first = sentences[0] ?? "";
  const last = sentences[sentences.length - 1] ?? "";
  const mid = sentences[Math.floor(sentences.length / 2)] ?? first;
  const counterMatch = sentences.find((s) => /however|critics|on the other hand|admittedly|some argue/i.test(s));
  const bodyParagraphs = Math.max(1, paras.length - 2);
  const paragraphsGoverning = Math.max(1, Math.ceil(bodyParagraphs * 0.75));
  const components = {
    thesis: { score: 15, quote: first.slice(0, 200), note: "Mock mode: thesis is contestable but could be sharper." },
    governingClaims: {
      score: Math.round(RUBRIC.governingClaims.points * (paragraphsGoverning / bodyParagraphs)),
      quote: mid.slice(0, 200),
      note: "Mock mode: most body paragraphs open with a claim.",
      paragraphsGoverning,
      bodyParagraphs,
    },
    warrant: { score: 13, quote: mid.slice(0, 200), note: "Mock mode: some evidence is dropped without explanation." },
    counterargument: counterMatch
      ? { score: 11, quote: counterMatch.slice(0, 200), note: "Mock mode: opposing view acknowledged; answer it more fully." }
      : { absent: true, score: 0, quote: "", note: "Mock mode: no counterargument found in the draft." },
    significance: { score: 10, quote: last.slice(0, 200), note: "Mock mode: stakes are implied but not stated outright." },
    conclusion: { score: 7, quote: last.slice(0, 200), note: "Mock mode: conclusion extends the argument slightly." },
  };
  return { components, model: `${model} (mock)`, usage: zeroUsage() };
}

function mockStructure(paras, model) {
  const lastIdx = paras.length - 1;
  const paragraphs = paras.map((p, i) => {
    let role;
    if (i === 0) role = "thesis";
    else if (i === lastIdx && paras.length > 1) role = "conclusion";
    else if (/however|critics|on the other hand|some argue/i.test(p)) role = "counterargument";
    else role = i % 2 === 1 ? "claim" : "evidence";
    const faults = /mitochondria.*stock|stock.*mitochondria/i.test(p) ? ["non-sequitur"] : [];
    return { index: i, role, faults };
  });
  return { paragraphs, model: `${model} (mock)`, usage: zeroUsage() };
}

function mockTracer({ history, draft, model }) {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const asked = (lastUser?.content ?? "").slice(0, 80);
  let reply;
  if (draft.trim()) {
    const phrase = draft.trim().split(/\s+/).slice(0, 6).join(" ");
    reply =
      `Mock mode reply. You asked: "${asked}". Looking at your draft, you open with "${phrase}..." — ` +
      "what is the one claim you most want a skeptical reader to accept? Tell me in a sentence, and we can test whether your opening actually argues it.";
  } else {
    reply =
      `Mock mode reply. You asked: "${asked}". Before I suggest anything — what are you arguing, and who needs convincing? ` +
      "Paste a draft or a rough thesis and we can start there.";
  }
  return { reply, model: `${model} (mock)`, usage: zeroUsage() };
}
