/**
 * The relay's prompts, held to the byte.
 *
 * server/lib/prompts/ is a port of the relay's lib/prompts.ts,
 * lib/gradePrompt.ts and lib/sourceSearchPrompt.ts. The desktop app's parsing
 * was tuned against those exact words, and the critique prompt's prefix-cache
 * saving (measured at 36% of an eight-claim run) only exists while the bytes
 * never change. A drifted prompt fails in the worst way available: every
 * request still succeeds, and the answers quietly get worse or dearer.
 *
 * Two halves:
 *
 *  - Checks that need nothing but this tree: every schema is the BARE shape
 *    structuredCall wants and passes assertStrictSchema, and the grade prompt
 *    is built from the rubric it claims to be built from. These always run.
 *
 *  - Checks against the relay SOURCE: each prompt string equal to the value
 *    the relay's TypeScript evaluates to, each schema deep-equal to the
 *    relay's once its chat/Responses wrapper is removed. These need a relay
 *    checkout, and SKIP without one — unlike models.test.js, which fails when
 *    extension/ is missing. The difference is deliberate: extension/ lives in
 *    this repo, so its absence is a broken checkout, while the relay is a
 *    separate repository that CI and the deploy host never clone. A test that
 *    failed there would fail on every run and teach everyone to ignore it.
 *
 * The relay is found at $RELAY_SRC (the relay repo root) when that is set,
 * then at the scratch clone the port was made from. The relay's .ts files are
 * IMPORTED rather than regex-scraped, so what is compared is the string the
 * relay actually sent, with its one interpolation (${RUBRIC_TEXT} in the grade
 * prompt) resolved exactly as the relay resolved it. That works because none
 * of the three files imports zod or openai: prompts.ts and
 * sourceSearchPrompt.ts import nothing and load under Node's own type
 * stripping; gradePrompt.ts imports './prompts' without an extension, which
 * Node's resolver will not follow, so its types are stripped here and the one
 * specifier is pointed at the file.
 */
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

/* ── against the relay source ─────────────────────────────────────────── */

// RELAY_SRC, or a sibling checkout named like the repo. No machine-specific
// path: the one that stood here was a scratch directory from the session that
// did the port.
const RELAY = [process.env.RELAY_SRC, path.join(HERE, "..", "..", "..", "Tracely-relay")]
  .filter(Boolean)
  .find((dir) => existsSync(path.join(dir, "lib", "prompts.ts")));
const CAN_STRIP = Boolean(process.features?.typescript) && typeof nodeModule.stripTypeScriptTypes === "function";

let SKIP = false;
if (!RELAY) {
  SKIP =
    "no relay checkout found (set RELAY_SRC to the Tracely-relay repo root to run these). " +
    "Expected in CI, which does not clone the relay.";
} else if (!CAN_STRIP) {
  SKIP = `this Node (${process.version}) cannot strip TypeScript types, so the relay's .ts cannot be evaluated`;
}

let relay = null;
let loadError = null;
if (!SKIP) {
  try {
    const url = (file) => pathToFileURL(path.join(RELAY, "lib", file)).href;
    const promptsUrl = url("prompts.ts");
    const gradeSource = readFileSync(path.join(RELAY, "lib", "gradePrompt.ts"), "utf8");
    const rewired = gradeSource.replace(/from '\.\/prompts'/, `from '${promptsUrl}'`);
    assert.notEqual(rewired, gradeSource, "gradePrompt.ts no longer imports './prompts' — update this loader");
    relay = {
      prompts: await import(promptsUrl),
      gradePrompt: await import("data:text/javascript," + encodeURIComponent(nodeModule.stripTypeScriptTypes(rewired))),
      sourceSearchPrompt: await import(url("sourceSearchPrompt.ts")),
    };
  } catch (err) {
    loadError = err;
  }
}

test("the relay source loads", { skip: SKIP }, () => {
  assert.equal(loadError, null, `found a relay at ${RELAY} but could not evaluate it: ${loadError?.stack}`);
});

for (const [what, prompt, file, name] of PROMPTS) {
  test(`${what} is byte-identical to the relay's ${file}.ts ${name}`, { skip: SKIP }, () => {
    assert.ok(relay, "relay did not load");
    const theirs = relay[file][name];
    assert.equal(typeof theirs, "string", `relay ${file}.ts no longer exports ${name}`);
    // assert.equal on two 13,000-character strings prints both in full; the
    // first differing offset is what anyone fixing this actually needs.
    if (prompt !== theirs) {
      let i = 0;
      while (i < prompt.length && prompt[i] === theirs[i]) i++;
      assert.fail(
        `${what} differs from the relay at char ${i} (port ${prompt.length} chars, relay ${theirs.length}):\n` +
          `  port:  ${JSON.stringify(prompt.slice(Math.max(0, i - 40), i + 40))}\n` +
          `  relay: ${JSON.stringify(theirs.slice(Math.max(0, i - 40), i + 40))}`
      );
    }
  });
}

for (const [what, exported, file, name] of SCHEMAS) {
  test(`${what} deep-equals the relay's ${name} once unwrapped`, { skip: SKIP }, () => {
    assert.ok(relay, "relay did not load");
    const theirs = relay[file][name];
    assert.ok(theirs && typeof theirs === "object", `relay ${file}.ts no longer exports ${name}`);
    // What the unwrapping throws away, pinned so it is thrown away knowingly:
    // strict is re-added by the caller, and only the source-search schema was
    // Responses-shaped with the format type at the top.
    assert.equal(theirs.strict, true);
    assert.equal(theirs.type, file === "sourceSearchPrompt" ? "json_schema" : undefined);
    assert.deepEqual(exported, { name: theirs.name, schema: theirs.schema });
  });
}

test("RUBRIC_TEXT and RUBRIC_SECTIONS match the relay's copies", { skip: SKIP }, () => {
  assert.ok(relay, "relay did not load");
  assert.equal(RUBRIC_TEXT, relay.prompts.RUBRIC_TEXT);
  assert.deepEqual(RUBRIC_SECTIONS, [...relay.prompts.RUBRIC_SECTIONS]);
});
