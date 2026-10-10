/**
 * Tracer's voices, held together across the two sides.
 *
 * The desktop shows a persona (src/shared/voices.ts) and the server decides
 * what it sounds like (lib/voices.js). A persona on one side only is a voice
 * picker entry that 400s, or a server persona nobody can pick, so the ids are
 * pinned to each other here, parsed out of the TypeScript source (the server
 * suite runs without a TypeScript toolchain, the same way mirror-contracts
 * reads src/).
 *
 * Every base voice must be one gpt-live-1 accepts, from OpenAI's documented
 * list (lib/voices.js GPT_LIVE_VOICES, read from the sideband reference on
 * 2026-10-10). And the instructions are pinned by SHA-256 like the text
 * prompts (test/prompts.test.js): editing one is allowed and should be a
 * decision — listen to it, then update the hash in the same change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VOICE_PERSONAS, VOICE_BASE_PROMPT, GPT_LIVE_VOICES, DEFAULT_VOICE_ID, DRAFT_HEADER, buildInstructions, isVoiceId } from "../lib/voices.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS = readFileSync(path.join(HERE, "..", "..", "src", "shared", "voices.ts"), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");

/* The desktop registry, read from source: the VoiceId union, and each entry's
 * id and name in VOICES order. */
const unionIds = /export type VoiceId = ([^\n]+)/.exec(TS)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
const entries = [...TS.matchAll(/\{ id: '([a-z]+)', name: '([^']+)', tagline: '([^']+)', accent: '([^']+)'/g)]
  .map(([, id, name, tagline, accent]) => ({ id, name, tagline, accent }));
const tsDefault = /export const DEFAULT_VOICE_ID: VoiceId = '([a-z]+)'/.exec(TS)[1];

test("the server's persona ids are exactly the desktop's, in the same order", () => {
  assert.equal(entries.length, 7, "parsed all seven VOICES entries from src/shared/voices.ts");
  assert.deepEqual(Object.keys(VOICE_PERSONAS), unionIds, "VoiceId union");
  assert.deepEqual(Object.keys(VOICE_PERSONAS), entries.map((e) => e.id), "VOICES order");
  assert.equal(DEFAULT_VOICE_ID, tsDefault);
  assert.equal(Object.keys(VOICE_PERSONAS)[0], DEFAULT_VOICE_ID, "the default is listed first on both sides");
});

test("each persona's display name matches, and its prompt says that name", () => {
  for (const e of entries) {
    assert.equal(VOICE_PERSONAS[e.id].name, e.name, e.id);
    assert.ok(VOICE_PERSONAS[e.id].prompt.startsWith(`Your name is ${e.name}.`), e.id);
  }
});

test("every base voice is a documented gpt-live-1 voice, and no two personas share one", () => {
  assert.equal(GPT_LIVE_VOICES.length, 31);
  const bases = Object.values(VOICE_PERSONAS).map((p) => p.base);
  for (const b of bases) assert.ok(GPT_LIVE_VOICES.includes(b), `${b} is not a gpt-live-1 voice`);
  assert.equal(new Set(bases).size, bases.length);
  assert.deepEqual(bases, ["marin", "cedar", "vesper", "willow", "quartz", "delta", "ash"]);
});

test("names avoid ChatGPT's own voice names", () => {
  const chatgpt = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"];
  for (const p of Object.values(VOICE_PERSONAS)) assert.ok(!chatgpt.includes(p.name.toLowerCase()), p.name);
});

test("the instructions are held to the byte", () => {
  assert.equal(sha(VOICE_BASE_PROMPT), "80a01facc5c134624ded1ddbd70fa030bbaa8331be6e194bffe5b31d13d79ef2", "VOICE_BASE_PROMPT changed");
  assert.equal(sha(JSON.stringify(VOICE_PERSONAS)), "355f619feaa3e35af098d09d0f159f6cbed3e3e7c44a56e216978f11193eaa44", "a persona changed");
  assert.ok(!/\n/.test(VOICE_BASE_PROMPT), "one paragraph: the spec's hard-wraps are joined");
});

test("buildInstructions: base, persona, then the draft under its header", () => {
  const p = VOICE_PERSONAS.atlas.prompt;
  assert.equal(buildInstructions("atlas"), `${VOICE_BASE_PROMPT}\n\n${p}`);
  assert.equal(buildInstructions("atlas", "   "), `${VOICE_BASE_PROMPT}\n\n${p}`, "whitespace is no draft");
  assert.equal(buildInstructions("atlas", "My thesis is X."), `${VOICE_BASE_PROMPT}\n\n${p}\n\n${DRAFT_HEADER}\n\nMy thesis is X.`);
  assert.equal(DRAFT_HEADER, "The student's current draft (for reference; never read it back at length):");
  assert.throws(() => buildInstructions("toString"), /unknown voice/);
  assert.equal(isVoiceId("toString"), false);
  assert.equal(isVoiceId("kip"), true);
});
