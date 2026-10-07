/**
 * The relay's prompts, held to the byte.
 *
 * server/lib/prompts/ is a port of the Vercel relay's lib/prompts.ts,
 * lib/gradePrompt.ts and lib/sourceSearchPrompt.ts (the relay is retired;
 * nothing new ships there). The desktop app's parsing was tuned against those
 * exact words, and the critique prompt's prefix-cache saving (measured at 36%
 * of an eight-claim run) only exists while the bytes never change. A drifted
 * prompt fails in the worst way available: every request still succeeds, and
 * the answers quietly get worse or dearer.
 *
 * So every prompt string is pinned by SHA-256 below. Editing a prompt is
 * allowed and should be a decision: re-measure (eval/models/FINDINGS.md), then
 * update the hash here in the same PR. The schemas are also checked to be the
 * BARE shape structuredCall wants (assertStrictSchema), and the grade prompt to
 * be built from the rubric it claims.
 *
 * Until 2026-10 a second half compared each prompt against a relay checkout
 * ($RELAY_SRC) and skipped without one — which was every run, everywhere.
 */
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertStrictSchema } from "../lib/llm.js";
import { RUBRIC_SECTIONS, RUBRIC_TEXT } from "../shared/rubricText.js";
import * as detect from "../lib/prompts/detect.js";
import * as critique from "../lib/prompts/critique.js";
import * as correction from "../lib/prompts/correction.js";
import * as structure from "../lib/prompts/structure.js";
import * as tracer from "../lib/prompts/tracer.js";
import * as grade from "../lib/prompts/grade.js";
import * as sources from "../lib/prompts/sources.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** [port export, the port's value, relay file, relay export name] */
const PROMPTS = [
  ["CLAIM_DETECTION_SYSTEM_PROMPT", detect.CLAIM_DETECTION_SYSTEM_PROMPT, "prompts", "CLAIM_DETECTION_SYSTEM_PROMPT"],
  ["CRITIQUE_SYSTEM_PROMPT", critique.CRITIQUE_SYSTEM_PROMPT, "prompts", "CRITIQUE_SYSTEM_PROMPT"],
  ["CORRECTION_SYSTEM_PROMPT", correction.CORRECTION_SYSTEM_PROMPT, "prompts", "CORRECTION_SYSTEM_PROMPT"],
  ["STRUCTURE_SYSTEM_PROMPT", structure.STRUCTURE_SYSTEM_PROMPT, "prompts", "STRUCTURE_SYSTEM_PROMPT"],
  ["TRACER_SYSTEM_PROMPT", tracer.TRACER_SYSTEM_PROMPT, "prompts", "TRACER_SYSTEM_PROMPT"],
  ["GRADE_SYSTEM_PROMPT", grade.GRADE_SYSTEM_PROMPT, "gradePrompt", "GRADE_SYSTEM_PROMPT"],
  ["SOURCE_SEARCH_SYSTEM_PROMPT", sources.SOURCE_SEARCH_SYSTEM_PROMPT, "sourceSearchPrompt", "SOURCE_SEARCH_SYSTEM_PROMPT"],
];

const SCHEMAS = [
  ["CLAIM_DETECTION_SCHEMA", detect.CLAIM_DETECTION_SCHEMA, "prompts", "CLAIM_DETECTION_JSON_SCHEMA"],
  ["CRITIQUE_SCHEMA", critique.CRITIQUE_SCHEMA, "prompts", "CRITIQUE_JSON_SCHEMA"],
  ["CORRECTION_SCHEMA", correction.CORRECTION_SCHEMA, "prompts", "CORRECTION_JSON_SCHEMA"],
  ["STRUCTURE_SCHEMA", structure.STRUCTURE_SCHEMA, "prompts", "STRUCTURE_JSON_SCHEMA"],
  ["GRADE_SCHEMA", grade.GRADE_SCHEMA, "gradePrompt", "GRADE_JSON_SCHEMA"],
  ["SOURCE_SEARCH_SCHEMA", sources.SOURCE_SEARCH_SCHEMA, "sourceSearchPrompt", "SOURCE_SEARCH_JSON_SCHEMA"],
];

/* ── this tree alone ──────────────────────────────────────────────────── */

for (const [what, prompt] of PROMPTS) {
  test(`${what} is a non-empty string with no unresolved interpolation`, () => {
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 500, `${what} is suspiciously short (${prompt.length} chars)`);
    // Converting a template literal to a plain string by hand is how a
    // literal "${RUBRIC_TEXT}" ends up in front of the model.
    assert.ok(!prompt.includes("${"), `${what} contains a literal "\${"`);
  });
}

for (const [what, exported] of SCHEMAS) {
  test(`${what} is exported as { name, schema } with the bare schema`, () => {
    assert.deepEqual(Object.keys(exported).sort(), ["name", "schema"]);
    // OpenAI's rule for a response-format name.
    assert.match(exported.name, /^[a-zA-Z0-9_-]{1,64}$/);
    // The wrapper assertStrictSchema cannot see: handed { name, strict, schema }
    // it finds no `type` at the root, walks nothing, and passes — then OpenAI
    // 400s. So the bare shape is asserted directly rather than trusted to it.
    assert.equal(exported.schema.type, "object", `${what}.schema is not the bare schema`);
    assert.equal(exported.schema.strict, undefined);
    assert.equal(exported.schema.name, undefined);
  });

  test(`${what} passes assertStrictSchema`, () => {
    assert.equal(assertStrictSchema(exported.schema, what), exported.schema);
  });

  // assertStrictSchema walks only nodes whose `type` IS "object" or "array".
  // The relay's nullable fields are written type: ['string','null'], which
  // OpenAI strict mode accepts and the walker simply skips. That is safe only
  // while no union contains an object or an array: one that did would never
  // be checked for additionalProperties:false, and would 400 in production.
  test(`${what} has no union type the strict-schema walker would skip over`, () => {
    const walk = (node, at) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.type)) {
        assert.ok(
          !node.type.includes("object") && !node.type.includes("array"),
          `${what}: ${at} is a ${JSON.stringify(node.type)} union, which assertStrictSchema does not walk`
        );
      }
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${at}.${k}`);
      if (node.items) walk(node.items, `${at}[]`);
    };
    walk(exported.schema, "root");
  });
}

test("assertStrictSchema accepts a ['string','null'] union and still rejects what it should", () => {
  const nullable = {
    type: "object",
    properties: { note: { type: ["string", "null"] } },
    required: ["note"],
    additionalProperties: false,
  };
  assert.doesNotThrow(() => assertStrictSchema(nullable, "nullable"));
  assert.throws(() => assertStrictSchema({ ...nullable, required: [] }, "nullable"), /missing note/);
});

test("the grade prompt is built from the rubric it claims, exactly once", () => {
  const at = grade.GRADE_SYSTEM_PROMPT.indexOf(RUBRIC_TEXT);
  assert.ok(at > 0, "RUBRIC_TEXT does not appear in GRADE_SYSTEM_PROMPT");
  assert.equal(grade.GRADE_SYSTEM_PROMPT.indexOf(RUBRIC_TEXT, at + 1), -1);
});

test("a finding can only cite a rubric section the rubric has", () => {
  const enumValues = grade.GRADE_SCHEMA.schema.properties.findings.items.properties.rubricSection.enum;
  assert.deepEqual(enumValues, [...RUBRIC_SECTIONS]);
  for (const section of RUBRIC_SECTIONS) {
    assert.ok(RUBRIC_TEXT.includes(`\n${section}\n`), `"${section}" is not a heading in RUBRIC_TEXT`);
  }
});

// The critique prompt keys on literals that arrive inside the REQUEST data:
// the desktop writes the first two into evidenceSummary (CITED_SOURCE_MARKER
// and the topical-search heading, src/shared/citedEvidence.ts) and the route
// writes the third above referenceCheck. Reword one side and the pass that
// reads it goes silently dead.
test("the critique prompt still names the headings its input is built with", () => {
  for (const literal of ["[CITED BY THE WRITER]", "Other sources found by a topical search", "Reference lookup"]) {
    assert.ok(critique.CRITIQUE_SYSTEM_PROMPT.includes(literal), `CRITIQUE_SYSTEM_PROMPT no longer mentions "${literal}"`);
  }
});

// src/shared/tracerRewrite.ts parses this block out of the reply.
test("the tracer prompt still specifies the rewrite block the desktop parses", () => {
  assert.match(tracer.TRACER_SYSTEM_PROMPT, /<<<REWRITE\nFIND: [^\n]+\nREPLACE: [^\n]+\n>>>/);
});

/* ── pinned: the text that was verified against the relay ───────────────
 * The byte-for-byte checks below need a relay checkout, and CI does not have
 * one, so on their own they only ever run on a developer's machine. These
 * hashes are of the exact strings verified identical to the relay at 027f920,
 * and they run everywhere. The relay is retired, so these files ARE the
 * prompts now and editing one is allowed — but it should be a decision, not an
 * accident: if you change a prompt on purpose, update its hash here, and
 * re-measure it first (each carries numbers from real drafts; see the
 * critique's "17% of verdicts came back fabricated"). */
const PINNED = {
  CLAIM_DETECTION_SYSTEM_PROMPT: [detect, "5474d71beedb75ea8b782ea79a8f41f0063e5aefb7e18e6ef48401c09eef6968"],
  CRITIQUE_SYSTEM_PROMPT: [critique, "deafe2461e12b982b16ec80360a75f6a0f5806b1f6ff26860f7b1da969f62cda"],
  CORRECTION_SYSTEM_PROMPT: [correction, "e3792878660a49f2566f8be632a688a5b5b8061b5eaeebfff001bfff2affe789"],
  STRUCTURE_SYSTEM_PROMPT: [structure, "99b5401744701a06da8564eda5b6e0687f236b9eeb3934680f1ba0ae34d6bdfc"],
  TRACER_SYSTEM_PROMPT: [tracer, "6b8353a51b7cd61cb68b510341631e969730fc55fb6958e2ab494110884a8545"],
  GRADE_SYSTEM_PROMPT: [grade, "5fb4215534fef78fba4b2f506110ba4061c9796f3bca13a01c9040955af72f1a"],
  SOURCE_SEARCH_SYSTEM_PROMPT: [sources, "1c2a55d43f15bfbb9ef61273bc6316ba1558f0a955c362483d5bea93ec841e0a"],
};
test("every prompt is still the text that was verified against the relay", () => {
  for (const [name, [mod, want]] of Object.entries(PINNED)) {
    const got = createHash("sha256").update(mod[name]).digest("hex");
    assert.equal(got, want, `${name} changed. If on purpose, re-measure it and update the hash in test/prompts.test.js.`);
  }
});
