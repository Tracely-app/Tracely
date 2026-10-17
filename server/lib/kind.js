/* POST /api/kind: the model names the kind of writing (lib/prompts/kind.js).
 *
 * It reads the start and the end of the document — a title, a salutation, a
 * heading block, a sign-off or a reference list is where a kind shows — at
 * most KIND_HEAD + KIND_TAIL characters (PRIVACY.md says 4,000). The answer
 * is one of the 56 kinds or "unsure"; anything else is "unsure". Answers are
 * kept in memory by the text they were given, so a reload, a second tab or
 * another install with the same text costs no second call. */

import { createHash } from "node:crypto";
import { ALLOWED_MODELS, DEFAULT_MODEL, structuredCall } from "./llm.js";
import { KIND_SYSTEM_PROMPT, KIND_SCHEMA, WRITING_KIND_KEYS } from "./prompts/kind.js";

export const KIND_HEAD = 3_600;
export const KIND_TAIL = 400;
// The output ceiling, reasoning included; server.js WORST_CALL["/api/kind"] keeps the same number.
export const KIND_MAX_TOKENS = 1_500;
const KINDS = new Set(WRITING_KIND_KEYS);

// The part of the document the model reads: its start, and its end when it is longer.
export function kindExcerpt(text) {
  const t = String(text ?? "");
  return t.length <= KIND_HEAD + KIND_TAIL ? t : `${t.slice(0, KIND_HEAD)}\n[…]\n${t.slice(-KIND_TAIL)}`;
}

export function validateKind(parsed) {
  const kind = typeof parsed?.kind === "string" ? parsed.kind : "";
  return KINDS.has(kind) ? kind : "unsure";
}

const CACHE_MAX = 2_000;
const cache = new Map(); // sha256 of the excerpt -> kind, oldest first
export const kindCacheKey = (excerpt) => createHash("sha256").update(excerpt).digest("hex");
export function cachedKind(key) {
  if (!cache.has(key)) return null;
  const kind = cache.get(key);
  cache.delete(key);
  cache.set(key, kind); // most recently used last
  return kind;
}
export function rememberKind(key, kind) {
  cache.set(key, kind);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
export function clearKindCache() {
  cache.clear();
}

export async function runKind({ text, model, effort, mock = false }) {
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const excerpt = kindExcerpt(text);
  if (mock) return { kind: "unsure", model: `${chosenModel} (mock)`, usage: { input: 0, output: 0, cached: 0 } };
  const raw = await structuredCall({
    model: chosenModel, system: KIND_SYSTEM_PROMPT, user: `DOCUMENT:\n\n${excerpt}\n\nWhat kind of writing is it?`,
    schema: KIND_SCHEMA.schema, maxTokens: KIND_MAX_TOKENS, what: "kind of writing", name: KIND_SCHEMA.name, effort,
  });
  return { kind: validateKind(raw.parsed), model: raw.model, usage: raw.usage };
}
