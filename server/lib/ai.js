/**
 * The custom-rubric grader — the one AI call here with no desktop equivalent.
 *
 * This file held six pipeline calls: claim detection, critique, grading,
 * structure, tracer and this one. The first five were this server's own
 * prompts, and they are gone: the desktop app's versions (the retired relay's,
 * with its five-pass critique and its rubric grader) replaced them in
 * lib/reasoning.js, so Tracely has one implementation of each instead of two.
 * What is left is the pasted-rubric grader, which the relay never had: a
 * teacher's own rubric cannot be graded by a prompt written against the
 * owner's.
 *
 *   gradeWithCustomRubric({ text, rubric, level, model }) → { components, custom, model, usage }
 *
 * MOCK MODE (TRACELY_MOCK=1) returns deterministic canned output.
 */
import { CheckError } from "./errors.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, structuredCall as llmCall } from "./llm.js";
import { GUARDS } from "../shared/guards.js";
import { MAX_CUSTOM_COMPONENTS, normalizeCustomComponents } from "../shared/rubric.js";

const DEFAULT_EFFORT = "low";
const isMock = () => process.env.TRACELY_MOCK === "1";
const chooseModel = (model) => (ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL);
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


function mockSentencesOf(text) {
  return (text.match(/[^.!?\n]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

