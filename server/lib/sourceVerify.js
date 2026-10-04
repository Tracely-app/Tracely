/* Does the source actually SAY it? The second look a source search gets
 * before a student is told to cite something.
 *
 * Owner, 2026-10-04: "Find sources" offered Ord & Davies (2022) — a paper on
 * youth work and austerity cuts — for "general support for youth leadership
 * has increased … little to no action", which it never says. "From now on
 * dont recommend me sources that do not align." The search model labels a
 * result from its search snippet alone (SOURCES_SYSTEM tells it not to open
 * pages, for cost), and a result on the same topic was getting "supports".
 * A stricter prompt helps; this is the part that does not depend on the
 * search model's judgement at all.
 *
 * For every result labelled "supports" or "refutes":
 *   1. read what the source itself says — the abstract from OpenAlex for a
 *      DOI (free, no key), else the page, cut to the passages that share the
 *      most words and figures with the claim;
 *   2. ONE structured call on the fast model judges all of them against the
 *      claim, from that text only: backs / contradicts / topic;
 *   3. the stance is rewritten from the verdict ("topic" → "context", which
 *      the extension does not offer to cite — backingSources), and the
 *      snippet becomes the source's own words that decided it.
 * A source whose text could not be read (paywall, bot wall, no abstract)
 * keeps the search's label: there is nothing to judge it on, and dropping
 * every walled publisher would drop most newspapers.
 *
 * Cost: one call, ~2-4k input tokens and a short answer on the fast model —
 * about 0.1 cent against the search's ~1.3 (WORST_CALL["/api/sources"]
 * already covers it: 3,000 + 1,500 output tokens under its 6,000). Nothing
 * here throws: any failure leaves the search's answer exactly as it was. */
import { safeFetch, decodeEntities } from "./citeMeta.js";
import { doiOf } from "./sourceEnrich.js";
import { structuredCall } from "./llm.js";

export const OPENALEX_WORK = "https://api.openalex.org/works/doi:";
export const VERIFY_DEADLINE_MS = 3_000;
const PASSAGE_CHARS = 1_400;
const MAX_PAGE_BYTES = 1_500_000;

/* OpenAlex stores an abstract as {word: [positions]}. */
export function abstractFromIndex(index) {
  if (!index || typeof index !== "object") return "";
  const words = [];
  for (const [w, at] of Object.entries(index)) for (const i of Array.isArray(at) ? at : []) if (Number.isInteger(i) && i >= 0 && i < 5_000) words[i] = w;
  return words.filter(Boolean).join(" ").trim();
}

/* The readable text of an HTML page: no scripts, styles, navigation chrome
 * or tags; entities decoded; whitespace collapsed. */
export function pageText(html) {
  return decodeEntities(String(html ?? "")
    .replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, ". ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim();
}

const STOP = new Set("the and for from with that this these those into over under about have has had was were are is be been being its their our your his her a an of in on to by at as or not but than then also more most less such which who whom what when where while".split(" "));
const keyWords = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}%.'-]*/gu) || []).map((w) => w.replace(/[.'-]+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w) || /\d/.test(w)));

/* The part of a long text the judge needs: the sentences that share the most
 * words and figures with the claim, kept in their original order, up to
 * `max` characters. A short text (an abstract) is returned whole. */
export function relevantPassages(text, claim, max = PASSAGE_CHARS) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const want = keyWords(claim);
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20 && s.length <= 600);
  const scored = sentences.map((s, i) => {
    let score = 0;
    for (const w of keyWords(s)) if (want.has(w)) score += /\d/.test(w) ? 3 : 1;
    return { s, i, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const x of scored) {
    if (used + x.s.length + 1 > max) continue;
    picked.push(x);
    used += x.s.length + 1;
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" … ");
}

async function readText(res, cap) {
  const t = await res.text();
  return t.length > cap ? t.slice(0, cap) : t;
}

/* What each source says, for the ones the search vouched for: [{ i, text }]. */
export async function gatherEvidence(sources, claim, { fetchImpl = globalThis.fetch, deadlineMs = VERIFY_DEADLINE_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  const out = [];
  try {
    await Promise.allSettled(sources.map(async (s, i) => {
      if (s.stance !== "supports" && s.stance !== "refutes") return;
      let text = "";
      const doi = doiOf(s);
      if (doi) {
        try {
          const res = await fetchImpl(OPENALEX_WORK + encodeURIComponent(doi), { signal: ctrl.signal, headers: { "User-Agent": "Tracely/1.0 (mailto:hello@jointracely.com)" } });
          if (res.ok) text = abstractFromIndex((await res.json())?.abstract_inverted_index);
        } catch { /* fall through to the page */ }
      }
      if (!text) {
        try {
          const res = await safeFetch(new URL(s.url), {
            signal: ctrl.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Tracely/1.0; local fact-checker)" },
          }, { fetchImpl });
          const type = String(res.headers?.get?.("content-type") ?? "");
          if (res.ok && (!type || /html|xml|text/i.test(type))) text = pageText(await readText(res, MAX_PAGE_BYTES));
        } catch { /* unreadable: the search's label stands */ }
      }
      const passage = relevantPassages(text, claim);
      if (passage.length >= 80) out.push({ i, text: passage });
    }));
  } finally {
    clearTimeout(timer);
  }
  return out.sort((a, b) => a.i - b.i);
}

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "quote"],
        properties: {
          id: { type: "integer" },
          verdict: { type: "string", enum: ["backs", "contradicts", "topic"] },
          quote: { type: "string", description: "The words from the source's text that decide it, verbatim, at most 30 words; \"\" for topic." },
        },
      },
    },
  },
};

export const VERIFY_SYSTEM = `You check whether sources actually say what a student's sentence claims, before the student is told to cite them. You are given the CLAIM and, for each source, an excerpt of its own text. Judge from that text ONLY — never from what you know about the source, its title or its reputation.

For each source, one verdict:
- "backs": the text states the claim's point — the same subject, the same direction, and the same figures where the claim gives any. A different word for the same measure is fine ("spending" or "investment", "facilities" or "services" when the text means the same figure). Backing part of a two-part claim is "backs" only if the part it backs is the claim's main point.
- "contradicts": the text states something that cannot be true alongside the claim (a different figure, the opposite direction, a different date or person).
- "topic": anything else — the text is about the same subject but makes a different point, or does not state the claim at all. This is the answer whenever you are unsure. A paper about youth services cut by austerity does NOT back a claim that support for youth leadership has grown.

If a PROPOSED CORRECTION is given, judge against the ORIGINAL claim: a source that backs the correction "contradicts" the claim.

"quote": copy the words from the excerpt that decide it, verbatim, at most 30 words. Use "" for "topic".`;

/* The verdicts, applied: stance rewritten, snippet replaced by the source's
 * own words when a quote came back that is really in its text. Returns how
 * many stances changed. Pure, so it is tested without a model. */
export function applyVerdicts(sources, evidence, verdicts) {
  const byId = new Map((Array.isArray(verdicts) ? verdicts : []).map((v) => [v?.id, v]));
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  let changed = 0;
  for (const e of evidence) {
    const v = byId.get(e.i);
    const s = sources[e.i];
    if (!v || !s) continue;
    const stance = v.verdict === "backs" ? "supports" : v.verdict === "contradicts" ? "refutes" : v.verdict === "topic" ? "context" : null;
    if (!stance) continue;
    if (s.stance !== stance) changed++;
    s.stance = stance;
    const quote = String(v.quote ?? "").trim();
    if (stance !== "context" && quote.length >= 12 && norm(e.text).includes(norm(quote).replace(/^["“]|["”]$/g, ""))) {
      s.snippet = `“${quote.replace(/^["“]|["”]$/g, "").slice(0, 280)}”`;
    }
  }
  return changed;
}

export async function verifySources({ claim, correction, sources, model, call = structuredCall, fetchImpl = globalThis.fetch, deadlineMs = VERIFY_DEADLINE_MS }) {
  const none = { checked: 0, changed: 0, usage: null };
  try {
    const evidence = await gatherEvidence(sources, claim, { fetchImpl, deadlineMs });
    if (!evidence.length) return none;
    const user = `CLAIM:\n${claim}\n` + (correction ? `\nPROPOSED CORRECTION:\n${correction}\n` : "") +
      evidence.map((e) => `\nSOURCE ${e.i}: ${sources[e.i].title}\n"""\n${e.text}\n"""`).join("\n") +
      `\n\nReturn one verdict per source id (${evidence.map((e) => e.i).join(", ")}).`;
    const raw = await call({ model, system: VERIFY_SYSTEM, user, schema: VERIFY_SCHEMA, maxTokens: 1_500, what: "source check", name: "verdicts", effort: "low" });
    const changed = applyVerdicts(sources, evidence, raw?.parsed?.verdicts);
    return { checked: evidence.length, changed, usage: raw?.usage ?? null };
  } catch (err) {
    // Billed if it answered; the caller adds what the error carries.
    return { ...none, usage: err?.llm?.usage ?? null, error: String(err?.message ?? err) };
  }
}
