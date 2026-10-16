/* The wrong-source check (lib/prompts/citeFit.js): whether the source a
 * cited sentence names could be where its claim comes from. POST /api/check
 * runs it after the fact check, only when the extension asks (`citeFit:
 * true`, 2.21.60) and only on the cited sentences the check called accurate:
 * a false or doubtful sentence already has a card, and the check's own
 * pinned prompt is untouched. One call per check, the fast model at low.
 *
 * Only "wrong" changes anything: that sentence's finding becomes
 * "wrong_source", which only a build that asked for it ever receives.
 * "fits" and "unsure" leave the check's "accurate" as it was. */

import { structuredCall, chooseModel } from "./llm.js";
import { CITE_FIT_SYSTEM, CITE_FIT_SCHEMA } from "./prompts/citeFit.js";

export const CITE_FIT_MAX = 12; // cited sentences judged per check
// The output ceiling, reasoning included; server.js WORST_CALL["/api/check"] holds a whole check's worth for it.
export const CITE_FIT_MAX_TOKENS = 2_000;

// "(OECD, 2023)", "(Miao & Holmes, 2023)", "(Smith et al., 2019, p. 4)", "(CDC, n.d.)": who, before the year.
const AUTHOR_YEAR = /^([\p{Lu}][^()]{0,90}?),?\s+(?:(?:1[5-9]|20)\d\d[a-z]?|n\.\s?d\.)(?:\s*,[^()]*)?$/u;
// MLA's author and page: "(Klein 45)", "(Lee and Park 12-14)".
const AUTHOR_PAGE = /^([\p{Lu}][\p{L}'’-]+(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’-]+|\s+et al\.)?)\s+\d{1,4}(?:[-–]\d{1,4})?$/u;

/* The name a sentence's citation gives, "" when it has none a reader could
 * judge: a numbered [1], a footnote, a quoted title, a "Doc 3". The last one
 * when there are several: a sentence's citation is usually at its end. */
export function citedName(sentence) {
  let name = "";
  for (const m of String(sentence ?? "").matchAll(/\(([^()\n]{2,120})\)/g)) {
    const inner = m[1].trim();
    if (/^Doc(?:ument)?\.?\s*\d/i.test(inner)) continue;
    const hit = inner.match(AUTHOR_YEAR) ?? inner.match(AUTHOR_PAGE);
    if (hit) name = hit[1].replace(/[,\s]+$/, "").trim();
  }
  return name;
}

// The sentences worth asking about: cited, and called accurate by the check.
export function citeFitCandidates(sentences, findings) {
  const accurate = new Set((findings ?? []).filter((f) => f?.verdict === "accurate").map((f) => f.id));
  const out = [];
  for (const s of sentences ?? []) {
    if (!accurate.has(s.id)) continue;
    const cited = citedName(s.text);
    if (cited) out.push({ id: s.id, text: s.text, cited });
    if (out.length >= CITE_FIT_MAX) break;
  }
  return out;
}

function userPrompt(items) {
  return `ITEMS:\n${items.map((x) => `[${x.id}] ${x.text}\ncited: ${x.cited}`).join("\n\n")}\n\nAnswer one item per id.`;
}

/* One answer per item it was asked about; anything else is dropped. A
 * "wrong" with no explanation is "unsure": the student would be told a
 * citation is wrong without being told why. */
export function validateCiteFit(parsed, items) {
  const ids = new Set((items ?? []).map((x) => x.id));
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(parsed?.items) ? parsed.items : []) {
    if (!v || !ids.has(v.id) || seen.has(v.id)) continue;
    seen.add(v.id);
    let fit = ["wrong", "fits", "unsure"].includes(v.fit) ? v.fit : "unsure";
    const explanation = fit === "wrong" ? String(v.explanation ?? "").trim().slice(0, 300) : "";
    if (fit === "wrong" && explanation.length < 8) fit = "unsure";
    out.push({ id: v.id, fit, source: fit === "wrong" ? String(v.source ?? "").trim().slice(0, 80) : "", explanation: fit === "wrong" ? explanation : "" });
  }
  return out;
}

// The mock server's answer, by keyword, so a test page shows the card: three agencies outside their remit.
const MOCK_REMIT = [
  [/^NASA$/i, /\b(?:space|planets?|Venus|Mars|Mercury|Jupiter|moon|Sun|orbit\w*|rotat\w*|astronauts?|rockets?|climate|galax\w*|stars?)\b/i],
  [/^(?:CDC|Centers for Disease Control and Prevention)$/i, /\b(?:health|disease\w*|sleep|vaccin\w*|infect\w*|obesity|injur\w*|teen\w*|adolescen\w*)\b/i],
  [/^OECD$/i, /\b(?:PISA|econom\w*|education\w*|students?|schools?|tax\w*|GDP|mathematics|countries)\b/i],
];
function mockCiteFit(items) {
  return items.map((x) => {
    const remit = MOCK_REMIT.find(([who]) => who.test(x.cited));
    return remit && !remit[1].test(x.text)
      ? { id: x.id, fit: "wrong", source: "another publisher", explanation: `${x.cited} does not publish this kind of claim; cite who does. (mock)` }
      : { id: x.id, fit: "fits", source: "", explanation: "" };
  });
}

export async function runCiteFit({ items, model, effort, mock = false }) {
  const chosenModel = chooseModel(model);
  if (!items?.length) return { verdicts: [], model: chosenModel, usage: null };
  if (mock) return { verdicts: mockCiteFit(items), model: `${chosenModel} (mock)`, usage: { input: 0, output: 0, cached: 0 } };
  const raw = await structuredCall({
    model: chosenModel, system: CITE_FIT_SYSTEM, user: userPrompt(items),
    schema: CITE_FIT_SCHEMA.schema, maxTokens: CITE_FIT_MAX_TOKENS, what: "citation fit", name: CITE_FIT_SCHEMA.name, effort,
  });
  return { verdicts: validateCiteFit(raw.parsed, items), model: raw.model, usage: raw.usage };
}

// The check's findings with each "wrong" in place of its "accurate".
export function applyCiteFit(findings, verdicts) {
  const wrong = new Map((verdicts ?? []).filter((v) => v.fit === "wrong").map((v) => [v.id, v]));
  return (findings ?? []).map((f) => {
    const v = wrong.get(f.id);
    return v && f.verdict === "accurate"
      ? { id: f.id, verdict: "wrong_source", explanation: v.explanation, revision: "", confidence: "medium", ...(v.source ? { source: v.source } : {}) }
      : f;
  });
}
