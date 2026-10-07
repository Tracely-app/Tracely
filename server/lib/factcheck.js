import { CheckError } from "./errors.js";
import { enrichSources, doiOf } from "./sourceEnrich.js";
import { fetchUrlMetadata } from "./citeMeta.js";
import { verifySources } from "./sourceVerify.js";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  chooseModel,
  hasApiKey,
  structuredCall,
  webSearchCall,
} from "./llm.js";
import { citeFields, SOURCE_KINDS } from "./citeFields.js";
import { isNarrowing } from "../shared/narrowing.js";

// Re-exported so every existing importer (server.js, tests) is unaffected by
// CheckError having moved into its own module to break an import cycle.
export { CheckError, hasApiKey };

/* What the MODEL is asked to return — not what the route returns.
 *
 * Two shapes for one finding, chosen by the verdict. A sentence that is fine
 * ("accurate", "no_claim") is answered with its id and verdict and NOTHING
 * else; a flagged sentence carries its evidence. Most sentences in a draft are
 * fine, and the old flat schema made the model spell out an empty explanation,
 * an empty revision and a confidence for every one of them — output tokens,
 * which on a reasoning model is where the latency is. Measured on the
 * checkset before this change: 735-986 output tokens for 11 sentences.
 *
 * `basis` is the objectivity check, enforced by SHAPE rather than by
 * adjectives in the prompt. A "false" verdict must state the correct fact; a
 * "questionable" one must say exactly what cannot be verified; a
 * "needs_citation" must name the kind of source. The route demotes a "false"
 * that arrives with no basis to "questionable" (normalizeFinding): a verdict
 * the model cannot ground is a hunch, and a hunch is not a contradiction.
 *
 * OpenAI strict mode accepts `anyOf` on array items as long as every branch
 * is itself strict (every property required, additionalProperties false) —
 * lib/llm.js assertStrictSchema walks the branches. The wire shape the
 * clients read is unchanged: normalizeFinding flattens both branches to
 * { id, verdict, explanation, revision, confidence } (+ basis when present). */
const CLEAN_FINDING = {
  type: "object",
  properties: {
    id: { type: "string" },
    verdict: { type: "string", enum: ["accurate", "no_claim"] },
  },
  required: ["id", "verdict"],
  additionalProperties: false,
};
const FLAGGED_FINDING = {
  type: "object",
  properties: {
    id: { type: "string" },
    verdict: { type: "string", enum: ["false", "questionable", "incoherent", "needs_citation"] },
    basis: { type: "string" },
    explanation: { type: "string" },
    revision: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["id", "verdict", "basis", "explanation", "revision", "confidence"],
  additionalProperties: false,
};
const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: { type: "array", items: { anyOf: [CLEAN_FINDING, FLAGGED_FINDING] } },
  },
  required: ["findings"],
  additionalProperties: false,
};

const VERDICTS = new Set(["accurate", "needs_citation", "false", "questionable", "incoherent", "no_claim"]);
const FLAGGED = new Set(["false", "questionable", "incoherent", "needs_citation"]);

/* The check's instructions. Objective by construction: the model judges only
 * whether the factual content of a sentence is correct, verifiable and
 * attributed, and every verdict that flags a sentence has to be grounded in a
 * stated fact (`basis`). The words "misleading", "disputed" and "clarity
 * editor" are gone from the verdict definitions on purpose — each was a
 * judgement call the model was invited to make about the author rather than
 * a fact it could state about the world. The date goes LAST so the prefix
 * before it is byte-stable across days for the provider's prompt cache. */
function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Tracely's fact-checker, embedded in a writing tool. The author sees your findings as underlines while they type. You judge one thing: whether the factual content of each sentence is correct, verifiable and attributed. You hold no view on style, tone or politics, and you never judge the author.

You receive the full document for context plus a list of sentences to evaluate. Return exactly one finding for EVERY listed sentence id — no more, no fewer.

Decide first what the DOCUMENT is. The verdicts below are for expository writing (an essay, paper, report or article). For anything else — a resume, CV, cover letter, personal statement or bio; fiction, a personal narrative or journal; an email, message or notes — never use "needs_citation"; what the author says they did, won or plan is "no_claim", never "questionable"; still use "false" for a public fact stated wrongly (an institution's real name, a famous date).

Verdicts, in order of precedence:
- "false": a specific factual claim in the sentence contradicts an established fact — one you can state precisely (the correct date, number, name, place or mechanism) and that standard references document. Put that correct fact in "basis". If you cannot state the correct fact, the sentence is not "false".
- "incoherent": the sentence contradicts itself, or its conclusion does not follow from its own premise. "basis" names the contradiction. Long, awkward or unclear writing is NOT incoherent.
- "questionable": a checkable claim you cannot settle either way — the record is genuinely unsettled, the figure is stated with more precision than any source supports, or it depends on events after your knowledge. "basis" says exactly what cannot be verified. Never use "questionable" as a hedge on a fact you know, or because a true claim is unpopular. A source or quotation you cannot confirm is "questionable", never "false", unless impossible on its face (an author writing before their birth).
- "needs_citation": the claim is accurate, and it is one of the four kinds of statement a reader expects a source for, and no citation marker, parenthetical or prose attribution appears in or around the sentence. The four kinds: (1) a QUANTITY — any specific number, percentage, count, amount, rate, measurement or price ("280 parts per million", "a quarter of the workforce") — a quantity is a statistic even when it is about the essay's own subject, and even when it is right; (2) a DIRECT QUOTATION attributed to someone, however famous; (3) a research or study finding; (4) a specific claim that is genuinely contested or surprising. "basis" names the kind of source that would support it. It is NOT for the ordinary facts of a narrative: the dates, places, names, titles and sequence of events of a life, a war or a discovery are "accurate" when they are right, cited or not. A date is not a quantity. A history essay that is correct in every sentence should carry a flag only where it states a number or quotes someone, never one per sentence. A general statement — a topic sentence, an abstraction or generalization the essay goes on to support, the writer's own argument — is never "needs_citation" or "questionable": the evidence after it carries the citation.
- "accurate": the factual claims are correct, and either they are common knowledge or a citation or attribution is present.
- "no_claim": the sentence contains no checkable factual claim — an opinion, value judgement, superlative, prediction, greeting, instruction, question or framed fiction — however forcefully it is stated. "Jazz is the greatest art form America has produced" and "he remains the most controversial commander of the century" are no_claim: not false, and never "questionable" — there is nothing to verify.

Rules:
- Judge each sentence in the context of the whole document; resolve pronouns and references from the surrounding text.
- A citation can be a bracketed marker like [1], a parenthetical (Author, year), or prose attribution ("According to…", "X reported…"). Any of these count as cited — never flag them "needs_citation"; an unnamed one ("some researchers", "studies show") does not. Ignore bracketed markers when judging the claim itself.
- You cannot read a cited source. A cited figure you recall under a different label for the same measure ("services" or "facilities", "spending" or "investment") is not "false" or "questionable": judge its number, years, place and direction, never its wording.
- Widely known facts (capitals, famous dates, basic science), and the encyclopedic facts of the essay's own subject (when a person was born, what post they held, when a battle was fought), are common knowledge for that essay: "accurate", not "needs_citation".
- Reasonable, widely used approximations and rounded figures are accurate.
- A sentence that is right in every detail but one is "false" — name the one detail.
- Be consistent: the same sentence always gets the same verdict.
- "basis": a statement of fact in plain words, at most 30 words — never advice, never a remark about the author.
- "explanation": shown to the author, at most 25 words, concrete. For "false", state the correct fact. For "needs_citation", name the kind of source. For "questionable", say what cannot be verified. For "incoherent", say where the sentence breaks.
- "revision": for "false" and "incoherent", the minimal rewrite that makes the sentence correct while keeping the author's voice — never add surrounding sentences, never a bare negation: if the corrected sentence would not serve the essay, "" (delete it). For "questionable", a more careful wording only when one is warranted, else "". Always "" for "needs_citation": it needs a source, not different words.
- Today's date is ${today}.`;
}

function userPrompt(text, sentences) {
  const list = sentences.map((s) => `[${s.id}] ${s.text}`).join("\n");
  return `DOCUMENT:\n"""\n${text}\n"""\n\nSENTENCES TO EVALUATE:\n${list}\n\nReturn one finding per id.`;
}

/* COST: never resend a whole long document as context — the sentences carry
 * their own text, and a short head (title/thesis) covers reference resolution. */
function checkContext(text) {
  return text.length > 6000 ? text.slice(0, 2000) + "\n[… document trimmed for cost — judge sentences on their own text …]" : text;
}

/* The UTF-8 size of everything one check call sends as input — instructions,
 * document context, sentences and the output schema — for sizing a hold on
 * it (server.js thoroughWorstMicroCents). Bytes, not characters: a byte-level
 * BPE token covers at least one byte, so this bounds the input tokens in any
 * script, where a character count under-counts CJK roughly 3x. */
export function checkPromptBytes({ text, sentences }) {
  const t = typeof text === "string" ? text : "";
  const list = Array.isArray(sentences) ? sentences : [];
  return Buffer.byteLength(systemPrompt()) + Buffer.byteLength(userPrompt(checkContext(t), list)) +
    Buffer.byteLength(JSON.stringify(FINDINGS_SCHEMA));
}

/* Sentences per model call.
 *
 * A check is decode-bound: on the reasoning model the wall clock is roughly
 * the reasoning tokens plus the output per sentence, at a few dozen tokens a
 * second, so a 40-sentence first pass took 15-20 s and an 11-sentence essay
 * 9-13 s (measured, eval/models/results-baseline). Splitting the list into
 * shards that run CONCURRENTLY makes the wall clock the slowest shard's,
 * not the sum. Each shard repeats the instructions and the (short) document
 * context — the instructions are a stable prefix the provider caches, and
 * the context is at most 2,000 characters — so the extra input is a fraction
 * of a cent on a 40-sentence check. Sharding also caps how much one
 * truncation can cost: a shard that overruns splits (checkBatch), not the
 * whole check.
 *
 * The route admits the extra calls against its spend hold first (admitCalls,
 * one more worst case per extra shard); refused, the check runs as one call,
 * exactly as before. Overridable for the eval harness's sweeps. */
export const CHECK_SHARD_SENTENCES = Math.max(1, Number(process.env.TRACELY_CHECK_SHARD) || 8);

/* How long one call of at most CHECK_SHARD_SENTENCES sentences may take.
 *
 * Every model call waits up to lib/llm.js's 120 s, and a shard of /api/check
 * occasionally hangs for all of it: 2026-10-03, a 10-sentence check (two
 * shards) ran over two minutes and failed `timeout`, where the identical
 * request a minute later took 4.6 s. Measured the same day against
 * production, 100 ten-sentence checks: p50 4.1 s, p99 5.4 s, max 11.4 s, no
 * hang. So a shard that has not answered in 30 s is the hang, not a slow
 * answer — and waiting out the other 90 s only delays the same failure.
 *
 * Only calls of at most one shard's size get it: a check refused its extra
 * calls runs up to 40 sentences as ONE call, and an "Explain in depth" call
 * (server.js passes no deadline for those) is the thorough model, neither of
 * which this measurement covers. */
export const CHECK_SHARD_TIMEOUT_MS = Math.max(1, Number(process.env.TRACELY_CHECK_SHARD_TIMEOUT_MS) || 30_000);

export function shardSentences(sentences, size = CHECK_SHARD_SENTENCES) {
  const n = sentences.length;
  if (n <= size) return [sentences];
  const k = Math.ceil(n / size);
  const per = Math.ceil(n / k);
  const out = [];
  for (let i = 0; i < n; i += per) out.push(sentences.slice(i, i + per));
  return out;
}

/* `admitSplit`, when given, is asked before a truncated batch is split into
 * two more calls, and the split happens only if it answers true — the route
 * uses it to hold those calls' worst case against a spend pool (server.js
 * /api/check). Refused, the truncation stands: the check fails as it would
 * for a single sentence, and what the truncated call cost is still recorded.
 * `admitCalls(n)`, when given, is asked once before a check is sharded into
 * n extra concurrent calls; refused, it runs as one call. */
/* `maxTokens` overrides the route's output ceiling (16,000) — server.js
 * passes 2,000 for an "Explain in depth" check on the thorough model, which is
 * what makes that call's worst case (shared/plan.js THOROUGH_RESERVE_USD) a
 * bound. Absent, the ceiling is unchanged. */
/* `shardTimeoutMs` (server.js passes CHECK_SHARD_TIMEOUT_MS for every check
 * but "Explain in depth") is the deadline for each call of at most one
 * shard's size; absent, every call keeps 120 s. When a sharded check's only
 * failures are TIMEOUTS and another shard answered, the check answers with
 * what it has: the timed-out sentences are simply absent from `findings`,
 * which the extension already reads as "not checked yet" and re-sends after
 * its 30 s hold (content.js holdOmitted). A server-side retry would be that
 * same call, sooner — so it would raise the bill on every hang, where this
 * raises nothing. `onShardFailure(err)` is told of each shard so dropped,
 * so the failure log still counts it. Any other failure, or every shard
 * timing out, fails the check exactly as before. */
export async function runFactCheck({ text, sentences, model, effort, mock = false, admitSplit = null, admitCalls = null, maxTokens = undefined, shardTimeoutMs = undefined, onShardFailure = null }) {
  const chosenModel = chooseModel(model);
  if (mock) return mockFindings(sentences, chosenModel);
  const context = checkContext(text);
  // `effort` used to be destructured here and then dropped, so the slider
  // moved the model and nothing else. undefined falls to lib/llm.js's
  // DEFAULT_EFFORT rather than to OpenAI's much costlier default.
  const shards = shardSentences(sentences);
  if (shards.length === 1 || !callsAdmitted(admitCalls, shards.length - 1)) {
    return checkBatch({ text: context, sentences, model: chosenModel, effort, admitSplit, maxTokens, shardTimeoutMs });
  }
  const settled = await Promise.allSettled(shards.map((s) => checkBatch({ text: context, sentences: s, model: chosenModel, effort, admitSplit, maxTokens, shardTimeoutMs })));
  const done = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const rejected = settled.filter((r) => r.status === "rejected").map((r) => r.reason);
  const partial = rejected.length > 0 && done.length > 0 && shardTimeoutMs !== undefined && rejected.every((e) => e?.kind === "timeout");
  if (rejected.length && !partial) {
    // Every shard that answered was billed, and so was whatever the failing
    // one managed — the route records only what the error it catches carries.
    const billed = done.reduce((acc, r) => addUsage(acc, r.usage), null);
    throw withBilledUsage(rejected[0], billed, rejected[0]?.llm);
  }
  for (const e of rejected) {
    try { onShardFailure?.(e); } catch { /* a log hook never fails the check */ }
  }
  // A dropped shard can still have been billed (a truncation split or a
  // missed-id retry that completed before the deadline), so it is counted.
  const usage = [...done.map((r) => r.usage), ...rejected.map((e) => e?.llm?.usage)]
    .reduce((acc, u) => addUsage(acc, u), { input: 0, output: 0, cached: 0, cacheWrite: 0 });
  return {
    findings: done.flatMap((r) => r.findings),
    model: done[0]?.model ?? chosenModel,
    usage,
    shards: shards.length,
  };
}

async function checkBatch({ text, sentences, model, effort, admitSplit, maxTokens, shardTimeoutMs, retryMissing = true }) {
  let result;
  try {
    result = await structuredCall({
      model,
      system: systemPrompt(),
      user: userPrompt(text, sentences),
      schema: FINDINGS_SCHEMA,
      effort,
      // Room for a revision per sentence, plus slack for long documents.
      maxTokens: maxTokens ?? 16_000,
      what: "fact check",
      name: "findings",
      timeoutMs: sentences.length <= CHECK_SHARD_SENTENCES ? shardTimeoutMs : undefined,
    });
  } catch (err) {
    // Output budget exhausted — split the batch so each retry makes progress.
    // A single sentence that still truncates has nothing left to split.
    if (err?.kind === "truncated" && sentences.length > 1 && splitAdmitted(admitSplit)) {
      const mid = Math.ceil(sentences.length / 2);
      let first = null;
      try {
        first = await checkBatch({ text, sentences: sentences.slice(0, mid), model, effort, admitSplit, maxTokens, shardTimeoutMs });
        const second = await checkBatch({ text, sentences: sentences.slice(mid), model, effort, admitSplit, maxTokens, shardTimeoutMs });
        // The truncated attempt was billed too — every output token it was
        // allowed — so its usage (lib/llm.js tags it on the error) is part of
        // what this check cost and of what the route records.
        return {
          findings: [...first.findings, ...second.findings],
          model: second.model,
          usage: addUsage(addUsage(first.usage, second.usage), err.llm?.usage),
        };
      } catch (inner) {
        // A half failed: the truncated attempt and any half that completed
        // were billed all the same, and the route records only what the error
        // it catches carries — so they ride on that error.
        throw withBilledUsage(inner, addUsage(err.llm?.usage, first?.usage), err.llm);
      }
    }
    throw err;
  }

  const validIds = new Set(sentences.map((s) => s.id));
  const findings = (Array.isArray(result.parsed.findings) ? result.parsed.findings : [])
    .filter((f) => f && validIds.has(f.id))
    .map(normalizeFinding);

  // One finding per id is the contract, and the model keeps it almost
  // always — measured once in 165 judgements it left an id out. A sentence
  // with no finding is a sentence never checked, so the ones it skipped are
  // asked again, once, on their own; a second miss stands (the client treats
  // a missing id as unchecked and asks next cycle).
  const answered = new Set(findings.map((f) => f.id));
  const missed = sentences.filter((s) => !answered.has(s.id));
  if (missed.length && missed.length < sentences.length && retryMissing) {
    const again = await checkBatch({ text, sentences: missed, model, effort, admitSplit, maxTokens, shardTimeoutMs, retryMissing: false });
    return { findings: [...findings, ...again.findings], model: again.model, usage: addUsage(result.usage, again.usage) };
  }

  return { findings, model: result.model, usage: result.usage };
}

/* The wire shape every client reads, from either branch of the model schema —
 * and from the old flat shape, which a mock or an older test still answers
 * with. A "false" with no stated basis is demoted to "questionable": the
 * prompt makes the correct fact the price of that verdict, and the schema
 * makes the field mandatory, so an empty one is the model saying it could not
 * name what is wrong. That is not a contradiction; it is a doubt. */
export function normalizeFinding(f) {
  let verdict = VERDICTS.has(f.verdict) ? f.verdict : "no_claim";
  const basis = String(f.basis ?? "").trim().slice(0, 300);
  if (verdict === "false" && basis.length < 8) verdict = "questionable";
  const flagged = FLAGGED.has(verdict);
  const explanation = flagged ? (String(f.explanation ?? "").trim().slice(0, 400) || basis) : "";
  const revision = flagged && verdict !== "needs_citation" ? String(f.revision ?? "").slice(0, 2000) : "";
  const out = {
    id: f.id,
    verdict,
    explanation,
    revision,
    confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium",
  };
  if (flagged && basis) out.basis = basis;
  return out;
}

// A hook that throws refuses: the shards run as one call.
function callsAdmitted(admitCalls, extra) {
  if (!admitCalls) return true;
  try { return admitCalls(extra) === true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Source finding: uses OpenAI's built-in web_search tool (billed through the
// same API key — no extra keys) to pull up candidate sources for a claim.
// Search bills PER CALL on top of tokens, which is why this is the one path
// with a caller-side budget (search/webBudget in server.js).
// ---------------------------------------------------------------------------

/* The answer's shape, strict: every property required, nothing extra, so
 * each source carries every citation field — "" / [] / null when the page
 * does not state it. The fields past `stance` feed the extension's
 * citations; before them its formatter had only a title, a URL and a
 * publisher, so every reference was "(n.d.)" with the publisher (often a
 * hostname) in the author slot. They are validated (lib/citeFields.js)
 * before they reach a client, and they are OPTIONAL on the wire: a source
 * harvested from the search's url_citations carries none of them. */
const SOURCES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "publisher", "snippet", "stance", "kind", "authors", "groupAuthor", "year", "date", "container", "editors", "doi"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publisher: { type: "string" },
          snippet: { type: "string" },
          stance: { type: "string", enum: ["supports", "refutes", "context"] },
          kind: { type: "string", enum: SOURCE_KINDS },
          authors: { type: "array", items: { type: "string" } },
          groupAuthor: { type: "string" },
          year: { type: ["integer", "null"] },
          date: { type: "string" },
          container: { type: "string" },
          editors: { type: "array", items: { type: "string" } },
          doi: { type: "string" },
        },
      },
    },
  },
};

const SOURCES_SYSTEM = `You are Tracely's source finder. Given a claim from a document (and optionally a proposed correction), use web search to find authoritative sources that address it.

How to search. Each search is paid for, so be economical:
- Run ONE web search, with a query that names the claim's specific fact (the figure, the person, the event, the finding, the quoted words). Run a second search only if the first returned nothing a student could cite. Never a third.
- Do NOT open pages. Judge each result from what the search returned — its title, snippet, site and date. The server opens the pages afterwards and reads each page's own citation data, so nothing is gained by opening them here.

After researching, your FINAL message must be ONLY a JSON object, no prose, in this exact shape:
{"sources":[{"title":"...","url":"...","publisher":"...","snippet":"...","stance":"supports"|"refutes"|"context","kind":"...","authors":[],"groupAuthor":"","year":null,"date":"","container":"","editors":[],"doi":""}]}

Rules:
- 3 to 5 sources, ranked best-first. Prefer primary and authoritative sources (scientific bodies, encyclopedias, government agencies, reputable news) over blogs and content farms.
- "stance" is relative to the ORIGINAL claim: "supports" backs the claim as written, "refutes" contradicts it, "context" informs without settling it. "supports" only when the result itself states the claim's point — the same subject, direction and figures; a source on the same topic that makes a different point is "context", however relevant. When unsure, "context". A student will cite a "supports" source for this exact sentence.
- "snippet": one sentence (max 30 words) saying what the source itself states — never the claim's words unless the source uses them.
- Use real URLs from your search results only. Never invent URLs.

Citation fields. A student's reference list is built from these, so copy ONLY what the source itself states; never guess, never infer from the URL, the site or what is typical. Here "states" means what the search result showed you — a byline, a date, a journal name, a DOI. Empty is correct: use "", [] or null whenever the source does not say; the server completes a journal article from its DOI and a readable page from its own metadata.
- "title": the work's own title, without the site name.
- "publisher": the organization that publishes it, by name (e.g. "International Organization for Migration"), never a web address.
- "kind": institutional (a web page of a government, intergovernmental body, NGO, university or research body), news, reference (encyclopedia, dictionary), journal (journal article), report (a report, working paper, white paper or fact sheet an organization publishes, or a chapter of one), book (a book, or a chapter of one), archive, other.
- "authors": the named PEOPLE credited, full names as written. Never an organization, a website, "Staff" or "Editors".
- "groupAuthor": the organization credited as author when no person is; otherwise "".
- "year": the year of publication the source states (integer), else null — not the year it was updated or retrieved.
- "date": "YYYY-MM-DD" only when the source states the full publication date, else "".
- "container": the larger work this is part of — the journal of an article, the book or report of a chapter — else "".
- "editors": the editors of that container as the source names them, else [].
- "doi": the DOI when shown (10.xxxx/...), else "".`;

export async function findSources({ claim, correction, context, model, effort, mock = false, enrich = true }) {
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  if (mock) return mockSources(claim, chosenModel);

  const userMsg =
    `CLAIM:\n${claim}\n` +
    (correction ? `\nPROPOSED CORRECTION:\n${correction}\n` : "") +
    (context ? `\nDOCUMENT CONTEXT (excerpt):\n${claimWindow(context, claim)}\n` : "") +
    `\nFind sources, then output only the JSON object.`;

  // The web_search tool bills per call on top of tokens, which is why
  // findSources is the one path with a caller-side budget (search/webBudget).
  // `effort` undefined sends no reasoning effort — the vendor's default, which
  // is what every source search has run at; the widgets send none here (see
  // webSearchCall). A caller-chosen level is sent.
  const { text: fullText, citations, model: usedModel, usage, webSearchCalls, webSearchActions, sent } = await webSearchCall({
    model: chosenModel,
    system: SOURCES_SYSTEM,
    user: userMsg,
    // 3,000, from 6,000: an answer is ~700-1,000 tokens plus ~200-600 of
    // reasoning at low effort (measured 2026-10-02 over 12 calls); the one
    // answer that ran to the old cap was a runaway that produced no sources
    // and cost 0.7 cents of output. The cap now bounds that at a third.
    maxTokens: 3_000,
    what: "source search",
    effort,
    schema: SOURCES_SCHEMA,
    name: "sources",
  });

  let sources = [];
  const jsonMatch = fullText.match(/\{[\s\S]*"sources"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.sources)) sources = parsed.sources;
    } catch { /* fall through to citation harvest */ }
  }

  // Harvest search citations as backup candidates (and to backfill a thin list).
  // OpenAI hangs these off the text as url_citation annotations; they carry a
  // title and URL but no excerpt, so the snippet stays empty here. Under the
  // strict schema the answer may carry none: the one measured call
  // (2026-09-21, gpt-5.6-luna, two searches) had zero, so a list is now what
  // the model wrote, and this is the backstop for an answer that does not parse.
  const harvested = citations.map((c) => ({
    title: c.title || c.url,
    url: c.url,
    publisher: hostOf(c.url),
    snippet: "",
    stance: "context",
  }));

  const merged = mergeSources([...sources, ...harvested]);

  if (merged.length === 0) {
    // Answered, so billed — tokens and every search — like any failure the
    // facade tags (lib/llm.js tagFailure); the route records what it carries.
    const err = new CheckError("server", "No usable sources came back — try again.", { status: 502 });
    Object.defineProperty(err, "llm", { value: { ...sent, usage, webSearchCalls }, enumerable: false, configurable: true });
    throw err;
  }

  // The model no longer opens pages (SOURCES_SYSTEM): the server completes
  // the citation fields itself — Crossref for anything with a DOI, the page's
  // own metadata for the rest — under one short deadline, and drops a link
  // that answers 404. Off for a mock answer and whenever a caller asks.
  const { enriched, dropped } = enrich === false ? { enriched: 0, dropped: 0 } : await completeSources(merged, { now: new Date() });

  // Then the second look (lib/sourceVerify.js): read what each "supports" /
  // "refutes" source itself says and judge it against the claim, so a source
  // only on the topic is relabelled "context" and never offered to cite.
  // Never fails the search; its tokens are added to what the route records.
  const verified = enrich === false ? { checked: 0, changed: 0, usage: null } : await verifySources({ claim, correction, sources: merged, model: chosenModel });

  // `webSearchCalls`: what the search tool billed, per call — the route
  // records it and keeps it out of the response. `enriched`/`dropped`/
  // `verified` are for the route's log line.
  return { sources: merged, model: usedModel, usage: verified.usage ? addUsage(usage, verified.usage) : usage, webSearchCalls, webSearchActions, enriched, dropped, verified: { checked: verified.checked, changed: verified.changed } };
}

/* The part of the document the search should see: the claim's own
 * neighbourhood, not the document's head. The extension sends the first
 * 6,000 characters of the text as context and this used to keep the first
 * 3,000 — so for a claim in paragraph four the model read the introduction
 * and never the paragraph the claim lives in. Now: find the claim (its first
 * 80 characters, whitespace-normalised) and take up to `radius` characters
 * either side, cut at sentence ends where there is one; a claim that is not
 * in the context (an edited sentence, a field) falls back to the head. */
export function claimWindow(context, claim, { radius = 1_200, head = 3_000 } = {}) {
  const ctx = String(context ?? "");
  if (!ctx) return "";
  const needle = String(claim ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const hay = ctx.replace(/\s+/g, " ");
  const at = needle.length >= 20 ? hay.indexOf(needle) : -1;
  if (at < 0) return ctx.slice(0, head);
  let start = Math.max(0, at - radius);
  let end = Math.min(hay.length, at + needle.length + radius);
  // Snap outward to a sentence end / start within 200 characters when there is one.
  const before = hay.slice(Math.max(0, start - 200), start);
  const cut = before.search(/[.!?]["'”)]*\s+[^\s]*$/);
  if (start > 0 && cut >= 0) start = Math.max(0, start - 200) + cut + before.slice(cut).search(/\s/) + 1;
  const after = hay.slice(end, end + 200);
  const stop = after.search(/[.!?]["'”)]*(\s|$)/);
  if (end < hay.length && stop >= 0) end = end + stop + 1;
  return (start > 0 ? "…" : "") + hay.slice(start, end).trim() + (end < hay.length ? "…" : "");
}

/* Fill in what the search result could not show, from the authority for each
 * kind of source:
 *   1. Crossref, for every source that names a DOI (lib/sourceEnrich.js);
 *   2. the page itself, for a source still without a year — the reader behind
 *      /api/cite-url (lib/citeMeta.js fetchUrlMetadata), which answers for
 *      .gov/.org pages and most publishers that do not wall off bots.
 * Both run in parallel under PAGE_DEADLINE_MS, and a page that answers 404 or
 * 410 is removed from the list in place: a dead link is not a citation.
 * Nothing here throws; a lookup that fails leaves the model's fields alone.
 *
 * Measured 2026-10-02 before shipping: Crossref answers a DOI in ~0.5 s with
 * authors, issue date, journal and publisher; the page reader yielded a year
 * on 2 of 8 real pages (Gallup, CDC) and was walled by NYT, Pew and Nature —
 * which is why the DOI path comes first and the page path is a fallback. */
export const PAGE_DEADLINE_MS = 2_500;
async function completeSources(list, { now = new Date(), fetchImpl = globalThis.fetch, deadlineMs = PAGE_DEADLINE_MS } = {}) {
  const t0 = Date.now();
  const { enriched } = await enrichSources(list, { fetchImpl, deadlineMs });
  const left = Math.max(400, deadlineMs - (Date.now() - t0));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), left);
  let filled = 0;
  const dead = new Set();
  try {
    await Promise.allSettled(list.map(async (s) => {
      // A source with a DOI was Crossref's; the rest are read when the page
      // may still state what the result did not — a year, or any author.
      const credited = (Array.isArray(s.authors) && s.authors.length) || s.groupAuthor;
      if (doiOf(s) || (s.year != null && credited)) return;
      let page;
      try {
        page = await fetchUrlMetadata(s.url, { now, signal: ctrl.signal, fetchImpl });
      } catch (e) {
        if (/returns (404|410)/.test(String(e?.message))) dead.add(s);
        return;
      }
      // Only what the page states and the model left empty; the model's title,
      // snippet and stance stay. citeFields already validated the page's fields.
      let changed = false;
      for (const k of ["authors", "groupAuthor", "year", "date", "container", "editors", "doi", "kind"]) {
        const v = page[k];
        const empty = s[k] == null || s[k] === "" || (Array.isArray(s[k]) && s[k].length === 0);
        const has = v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
        if (empty && has) { s[k] = v; changed = true; }
      }
      if (changed) filled++;
    }));
  } finally {
    clearTimeout(timer);
  }
  let dropped = 0;
  if (dead.size && dead.size < list.length) {
    for (let i = list.length - 1; i >= 0; i--) if (dead.has(list[i])) { list.splice(i, 1); dropped++; }
  }
  return { enriched: enriched + filled, dropped };
}

/* De-duplicated by URL, at most six, each with the five fields every client
 * has always read — then whatever citation fields survive validation. The
 * mock runs through here too, so TRACELY_MOCK answers in the real shape. */
function mergeSources(list, now = new Date()) {
  const seen = new Set();
  const merged = [];
  for (const s of list) {
    const url = String(s?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const source = {
      title: String(s.title ?? url).slice(0, 200),
      url: url.slice(0, 600),
      publisher: String(s.publisher ?? hostOf(url)).slice(0, 100),
      snippet: String(s.snippet ?? "").slice(0, 300),
      stance: ["supports", "refutes", "context"].includes(s.stance) ? s.stance : "context",
    };
    merged.push({ ...source, ...citeFields(s, { publisher: source.publisher, title: source.title, now }) });
    if (merged.length >= 6) break;
  }
  return merged;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// A hook that throws refuses: the truncation (and its billed usage) stands.
function splitAdmitted(admitSplit) {
  if (!admitSplit) return true;
  try { return admitSplit() === true; } catch { return false; }
}

/* Adds `billed` to what a failure says it cost (err.llm.usage — the tag
 * lib/llm.js puts on every failure, non-enumerable, never serialised), so the
 * route's error path records it. A failure with no usage of its own (a
 * timeout, a network error) still carries `billed`, under the model and
 * effort of `sentTag`. */
function withBilledUsage(err, billed, sentTag) {
  if (!err || typeof err !== "object") return err;
  const tag = err.llm ?? { model: sentTag?.model ?? null, effort: sentTag?.effort ?? null };
  Object.defineProperty(err, "llm", { value: { ...tag, usage: addUsage(tag.usage, billed) }, enumerable: false, configurable: true });
  return err;
}

// Every usage field is summed, cacheWrite included: dropping it would price a
// split check's cache writes as plain input, under the write rate.
function addUsage(a, b) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    input: n(a?.input) + n(b?.input),
    output: n(a?.output) + n(b?.output),
    cached: n(a?.cached) + n(b?.cached),
    cacheWrite: n(a?.cacheWrite) + n(b?.cacheWrite),
  };
}

// ---------------------------------------------------------------------------
// Mock mode (TRACELY_MOCK=1): deterministic canned verdicts and sources so the
// UI can be exercised end-to-end without an API key. Never used with a key.
// ---------------------------------------------------------------------------
const MOCK_RULES = [
  { re: /visible from space/i, verdict: "false", explanation: "Astronauts report the Great Wall is not visible to the naked eye from orbit; many other structures are easier to see.", revise: () => "Contrary to popular belief, the Great Wall of China is not visible to the naked eye from space." },
  { re: /einstein.*(failed|flunked).*math|math.*einstein/i, verdict: "false", explanation: "Einstein excelled at mathematics; the 'failed math' story is a myth, and Edison did not invent the lightbulb alone either.", revise: () => "Contrary to a popular myth, Albert Einstein excelled at mathematics from a young age." },
  { re: /napoleon.*(short|five feet)/i, verdict: "false", explanation: "Napoleon was about 5'7\" (170 cm) — average height for his era. The 'short' myth comes from French vs English units.", revise: () => "Despite the famous myth, Napoleon was around 5'7\" — average height for a Frenchman of his era." },
  { re: /stock market|because the mitochondria/i, verdict: "incoherent", explanation: "The conclusion does not follow from the premise — cell biology has no bearing on stock movements.", revise: () => "The mitochondria is the powerhouse of the cell." },
  { re: /boils at 100|206 bones|honey never spoils/i, verdict: "accurate", explanation: "", revise: () => "" },
];

function mockFindings(sentences, model) {
  const cycle = ["accurate", "questionable", "no_claim"];
  const findings = sentences.map((s, i) => {
    const rule = MOCK_RULES.find((r) => r.re.test(s.text));
    if (rule) {
      return { id: s.id, verdict: rule.verdict, explanation: rule.explanation, revision: rule.revise(), confidence: "high" };
    }
    const verdict = cycle[i % cycle.length];
    return {
      id: s.id,
      verdict,
      explanation: verdict === "questionable" ? "Mock mode: this claim could not be verified (canned response)." : "",
      revision: verdict === "questionable" ? s.text.replace(/\.$/, "") + " (citation needed)." : "",
      confidence: "medium",
    };
  });
  return { findings, model: `${model} (mock)`, usage: { input: 0, output: 0, cached: 0 } };
}

// ---------------------------------------------------------------------------
// Flow check: paragraph-level coaching. Where the fact checker judges single
// sentences, this reads the piece as a whole and flags places where the
// writing JUMPS — a paragraph that changes subject with no transition, an
// idea introduced before it is set up. One cheap call per structural change.
// ---------------------------------------------------------------------------
const FLOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["passage", "explanation", "transition"],
        properties: {
          passage: { type: "string", description: "The first sentence of the passage that reads abruptly, copied VERBATIM from the document." },
          explanation: { type: "string", description: "One or two sentences: what the reader loses at this jump." },
          transition: { type: "string", description: "A single sentence that could be inserted immediately BEFORE the passage to bridge the gap. Plain prose, no quotes." },
        },
      },
    },
  },
};

function flowSystemPrompt() {
  return `You are Tracely's flow coach. You read a student's essay as a whole and find places where the WRITING JUMPS — where a reader would lose the thread.

Flag a passage only when one of these is true:
- The paragraph changes subject with no transition from what came before.
- An idea, term, or example arrives before it has been set up.
- Two adjacent paragraphs are in the wrong order for the argument.
- A conclusion appears without the step that earns it.

Do NOT flag: grammar, word choice, tone, sentence length, factual errors, or anything a proofreader would catch. Those are other tools' jobs. Do not flag a paragraph merely for starting a new topic if a transition is already present.

Be strict. Most well-organized essays have ZERO flow issues; return an empty list in that case. Never report more than 3, and rank the most damaging first.

For each issue:
- "passage": copy the FIRST SENTENCE of the offending passage exactly as it appears in the document, character for character. It must be findable with an exact string search. Never paraphrase it, never add ellipses.
- "explanation": what the reader loses here, in plain language, addressed to the writer. Max 2 sentences.
- "transition": one sentence the writer could insert immediately before that passage to bridge the gap, written in their voice and using their subject matter. It must stand alone as prose.`;
}

export async function runFlowCheck({ text, model, effort, mock = false }) {
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  if (mock) return mockFlow(chosenModel);

  // Flow is judged on structure, so the WHOLE piece goes in (clamped) — unlike
  // the sentence checker, a trimmed body would hide the very jumps we hunt.
  const body = text.length > 12_000 ? text.slice(0, 12_000) + "\n[… document truncated …]" : text;

  const { parsed, model: usedModel, usage } = await structuredCall({
    model: chosenModel,
    system: flowSystemPrompt(),
    user: `DOCUMENT:\n\n${body}\n\nFind the flow problems. Return an empty list if the piece already reads smoothly.`,
    schema: FLOW_SCHEMA,
    maxTokens: 8_000,
    what: "flow check",
    name: "flow",
    effort,
  });

  // Only keep issues whose passage really is in the document — a paraphrased
  // anchor can't be located on the page, so it would render nothing.
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((i) => ({
      passage: String(i?.passage ?? "").trim().slice(0, 400),
      explanation: String(i?.explanation ?? "").slice(0, 400),
      transition: String(i?.transition ?? "").slice(0, 400),
    }))
    .filter((i) => i.passage.length >= 12 && hay.includes(norm(i.passage)))
    .slice(0, 3);

  return { issues, model: usedModel, usage };
}

function mockFlow(model) {
  return {
    issues: [{
      passage: "Grid storage remains one of the biggest technical challenges facing renewable adoption today.",
      explanation: "This part of the text doesn't flow correctly — it jumps into grid storage without transitioning from the point about solar and wind costs.",
      transition: "Falling costs, however, only solve half the problem.",
    }],
    model: `${model} (mock)`,
    usage: { input: 0, output: 0, cached: 0 },
  };
}

// ---------------------------------------------------------------------------
// Writing review (/api/review): what a document of ITS kind should be judged
// on, where the fact checker judges only facts. Owner, 2026-10-03, on a
// resume the checker answered with eight "needs_citation" flags: "it can give
// tips about formatting issues or if one of the bullet points is bad it can
// flag that. Tracely should be able to detect the context". Scoped to resumes
// and CVs for now: the extension asks only when it has recognised one, and
// the model returns no findings for anything else.
// ---------------------------------------------------------------------------
export const REVIEW_KINDS = ["bullet", "format", "typo"];
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["genre", "findings"],
  properties: {
    genre: { type: "string", enum: ["resume", "cover_letter", "essay", "other"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "kind", "message", "suggestion"],
        properties: {
          quote: { type: "string", description: "The bullet or line at fault, copied VERBATIM from the document." },
          kind: { type: "string", enum: REVIEW_KINDS },
          message: { type: "string", description: "What is wrong, addressed to the writer, at most 25 words." },
          suggestion: { type: "string", description: "The line rewritten, or \"\" when there is nothing to rewrite." },
        },
      },
    },
  },
};

function reviewSystemPrompt() {
  return `You are Tracely's resume reviewer, embedded in a writing tool. You read the whole document the way a recruiter skimming it would, and point out the few things most worth fixing.

First decide what the document is: "resume" (a resume or CV), "cover_letter", "essay", or "other". If it is not a resume or CV, return that genre and an empty findings list — nothing else.

For a resume, return at most 6 findings, most important first, of three kinds:
- "bullet": a bullet or description that undersells the author — a list of duties with no result, a stack of buzzwords ("robust", "high-velocity", "synergy", "aggressive") standing in for what was actually done, a claim too vague to picture, more than about 30 words, or a weak opening verb. Flag only bullets a recruiter would genuinely skim past; most strong resumes have one or two.
- "format": an inconsistency or slip a recruiter notices — dates written in different styles, states sometimes abbreviated and sometimes spelled out, a stray or duplicated line that belongs to no entry, broken contact details (an email address with no domain ending, a malformed phone number), bullets marked in some entries but not others.
- "typo": a misspelled word or proper noun, including a place or organisation name you know the correct spelling of — and a school, university, company or place named wrongly (one that does not exist under that name, like "University of California, Boston"), with the real name in "message" when you know it.

Rules:
- "quote": copy the bullet or line EXACTLY as it appears, character for character, so it can be found with an exact search. Never paraphrase or shorten it with an ellipsis.
- "message": what is wrong and why it matters, plainly, at most 25 words. Never judge the author, only the line.
- "suggestion": the line rewritten to fix it, in the author's voice. NEVER add a number, name, place, date, client or achievement that is not already in the line — you may only cut and reword. For a bullet with no result, say in the message what result would help rather than inventing one. Use "" when there is no better wording.
- Do not fact-check the author: what they say they did, won or plan is theirs to state. Only a public name stated wrongly (above) is yours to correct.
- Do not report a problem the document does not have. An empty list is a good answer for a clean resume.`;
}

export async function runReview({ text, model, effort, mock = false, kind = "resume" }) {
  if (kind === "essay") return runEssayReview({ text, model, effort, mock });
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const body = text.length > 12_000 ? text.slice(0, 12_000) + "\n[… document truncated …]" : text;
  const raw = mock ? mockReview(text, chosenModel) : await structuredCall({
    model: chosenModel,
    system: reviewSystemPrompt(),
    user: `DOCUMENT:\n\n${body}\n\nReview it.`,
    schema: REVIEW_SCHEMA,
    maxTokens: 6_000,
    what: "writing review",
    name: "review",
    effort,
  });
  const parsed = raw.parsed ?? {};
  return { ...validateReview(text, parsed), model: raw.model, usage: raw.usage };
}

/* Keep only findings the writer can act on: the quote must be in the
 * document (or the extension cannot show which line it means), the kind must
 * be one of ours, and a suggested rewrite may only NARROW its line — it may
 * drop a figure or a name but never introduce one, the same rule critique
 * revisions and Tracer's rewrites live by (shared/narrowing.js). A rewrite
 * that adds a fact is discarded and the message kept. */
export function validateReview(text, parsed) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  const genre = ["resume", "cover_letter", "essay", "other"].includes(parsed?.genre) ? parsed.genre : "other";
  const seen = new Set();
  const findings = (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .map((f) => ({
      quote: String(f?.quote ?? "").trim().slice(0, 600),
      kind: REVIEW_KINDS.includes(f?.kind) ? f.kind : null,
      message: String(f?.message ?? "").trim().slice(0, 300),
      suggestion: String(f?.suggestion ?? "").trim().slice(0, 600),
    }))
    .filter((f) => f.kind && f.message && f.quote.length >= 4 && hay.includes(norm(f.quote)))
    .filter((f) => { const k = norm(f.quote) + "|" + f.kind; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((f) => ({ ...f, suggestion: f.suggestion && f.suggestion !== f.quote && isNarrowing(f.suggestion, f.quote) ? f.suggestion : "" }))
    .slice(0, 6);
  return { genre, findings: genre === "resume" ? findings : [] };
}

/* Deterministic, in the real shape, from the document itself, so the UI can be
 * exercised with no key: the longest line that reads like a bullet, and an
 * email address with no domain ending if there is one. */
// ---------------------------------------------------------------------------
// Essay feedback (/api/review, kind "essay"). Owner, 2026-10-05, on an AP
// World DBQ the fact check rightly passed (29 of 30 sentences accurate): "it
// flags things too little". Then, on a deliberately flawed Mongol essay whose
// sentence-by-sentence fixes had turned "The Mongols invented the American
// dollar" into "the Mongols did not invent the American dollar", kept a
// fabricated Einstein quotation and its invented bibliography entries, kept
// "[History.com / Gutenberg / accessed yesterday]", and hedged unsupported
// claims instead of sourcing them: the check judges ONE sentence's facts and
// its "revision" is the smallest edit that makes that sentence true, so
// applying those one at a time produced an essay of corrections.
//
// This is the whole-essay pass that was missing. It reads the CURRENT text —
// it runs again after every real change, so it is also the review of the
// revised draft — and names the few things most worth fixing, each with:
//   kind    what is wrong (relevance, source, quotation, citation, bibliography,
//           reasoning, contradiction, evidence, analysis, thesis, structure,
//           and for a DBQ documents / sourcing / complexity)
//   status  how sure: confirmed (contradicted, or demonstrable from the text
//           itself), unsupported (no evidence in the essay), unverified (a
//           source or quotation not established), possible (depends on the
//           prompt, the rubric or a document packet Tracely has not seen)
//   action  delete | rewrite | cite | needs_info
// and validateEssayReview enforces what the prompt asks: a rewrite may not be
// a bare negation of the sentence, and may not bring in a number, a name or a
// quotation the essay does not already contain. Nothing here invents a
// source, a date or a document's contents.
// ---------------------------------------------------------------------------
export const ESSAY_REVIEW_KINDS = ["relevance", "source", "quotation", "citation", "bibliography", "reasoning", "contradiction", "evidence", "analysis", "thesis", "structure", "documents", "sourcing", "complexity"];
export const ESSAY_REVIEW_STATUSES = ["confirmed", "unsupported", "unverified", "possible"];
export const ESSAY_REVIEW_ACTIONS = ["delete", "rewrite", "cite", "needs_info"];
const ESSAY_WIDE_KINDS = new Set(["thesis", "structure", "documents", "sourcing", "complexity", "bibliography", "contradiction"]);
const DBQ_ONLY_KINDS = new Set(["documents", "sourcing", "complexity"]);
const NO_REWRITE_KINDS = new Set(["documents", "sourcing", "complexity", "source", "quotation", "bibliography", "citation"]);
const ESSAY_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["genre", "findings"],
  properties: {
    genre: { type: "string", enum: ["dbq", "essay", "other"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "kind", "status", "action", "message", "suggestion"],
        properties: {
          quote: { type: "string", description: "The sentence or reference entry this is about, copied VERBATIM; \"\" for a finding about the whole essay." },
          kind: { type: "string", enum: ESSAY_REVIEW_KINDS },
          status: { type: "string", enum: ESSAY_REVIEW_STATUSES },
          action: { type: "string", enum: ESSAY_REVIEW_ACTIONS },
          message: { type: "string", description: "What is wrong and what to do, addressed to the writer, at most 40 words." },
          suggestion: { type: "string", description: "For action \"rewrite\" only: the sentence rewritten using only what the essay already says. \"\" otherwise." },
        },
      },
    },
  },
};

/* The Documents an essay cites, counted here rather than by the model: a
 * count is exactly the kind of thing a model gets wrong and a regex does not.
 * "Document 2", "Doc. 3", "(Doc 6)", "Documents 1 and 4". */
export function citedDocuments(text) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(/\bDoc(?:ument)?s?\.?\s*((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)/gi)) {
    for (const n of m[1].match(/\d{1,2}/g) ?? []) found.add(Number(n));
  }
  return [...found].filter((n) => n >= 1 && n <= 12).sort((a, b) => a - b);
}

function essayReviewSystemPrompt() {
  return `You are Tracely's essay reviewer, embedded in a writing tool. Read the student's CURRENT draft as a whole, the way the teacher grading it would, and name the few things most worth fixing — including what earlier fixes left behind. Another check judges each sentence's facts; you judge the essay.

First decide what it is: "dbq" — an AP history document-based question, citing sources as "Document 1", "Doc 2"; "essay" — any other argumentative or analytical essay; "other" — not an essay. For "other", return no findings.

Return at most 8 findings, most important first. Kinds:
- "relevance": a sentence that does not support the argument — an anecdote, an analogy, an aside (shopping, sports, a trip, a food's origin in an essay about the Mongols), or a sentence that only says what is NOT true or does NOT prove the point ("The Mongols did not invent the dollar", "This does not prove…"). Action "delete". A false claim corrected into a negation is still irrelevant.
- "source": a source that is impossible or unidentifiable — an author who could not have written it (Einstein in 1206), an institution given as the author of an untitled "study", a source named in the text with no way to find it. "confirmed" only when impossible on its face; a source you merely cannot place is "unverified", never "fabricated". Action "delete" for impossible, "needs_info" otherwise.
- "quotation": words in quotation marks attributed to someone who could not have said them, or with no source. Same statuses.
- "citation": an in-text citation that cannot lead a reader to a source — several sites in one bracket, "accessed yesterday", a page number in words, an unnamed attribution ("some researchers", "experts say"), a note like "requires verification". Say what is missing; never supply a date, author, title or page yourself. A source's fame never excuses a missing date or author. Do NOT apply MLA or APA to a DBQ's document-number citations ("Document 2", "(Doc 3)") — those are correct.
- "bibliography": an entry that is incomplete or impossible, or in-text citations and the list that do not match. Quote the entry.
- "reasoning": a conclusion the evidence does not support, a cause asserted from a sequence, one case generalized.
- "contradiction": two statements in the essay that cannot both be true.
- "evidence": a claim stated broadly with nothing specific to support it — never a topic sentence the next sentences support. A hedge ("may have", "some argue") is not evidence: the claim still needs support or removal.
- "analysis": evidence described but never explained.
- "thesis": no defensible claim that answers the question, or one only restating the prompt.
- "structure": paragraphs that do not each advance one claim, or a draft that reads as a list of corrections rather than an argument.
For a "dbq", also judge against the College Board's AP history DBQ rubric (revised 2023), as "possible" when you have not seen the prompt or document packet:
- "documents": 1 point for using three documents to address the topic, 2 for using four to SUPPORT an argument. Use the DOCUMENTS CITED count given; never count yourself.
- "sourcing": explaining for two documents how or why the author's point of view, purpose, historical situation or audience matters to the argument. You have not seen the documents: never describe a document's author, purpose, audience or contents — say what sourcing is missing and ask for the document packet (action "needs_info").
- "complexity": explaining relationships among the evidence (a cost and a benefit, change and continuity, several causes), not merely mentioning a counterpoint.

Rules:
- "quote": the sentence or reference entry EXACTLY as written, character for character; "" when the finding is about the whole essay.
- "status": "confirmed" (contradicted, or demonstrable from the essay itself), "unsupported" (no evidence in the essay), "unverified" (a source or quotation not established), "possible" (depends on the prompt, rubric or documents).
- "action": "delete" for irrelevant, impossible or unusable material; "rewrite" only when the sentence can be fixed with what the essay already says; "cite" when it needs a real, identifiable source; "needs_info" when only the student or the packet can settle it.
- "suggestion": for "rewrite" only — the student's sentence fixed in their voice, adding NO name, number, date, quotation or source the essay does not already contain, and never a sentence that only negates the original. Otherwise "".
- "message": what is wrong and what to do, plainly, at most 40 words. Never praise, never judge the student, never invent a fact.
- Do not report a problem the essay does not have. Fewer, sharper findings beat many.`;
}

async function runEssayReview({ text, model, effort, mock = false }) {
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const body = text.length > 12_000 ? text.slice(0, 12_000) + "\n[… document truncated …]" : text;
  const docs = citedDocuments(text);
  const raw = mock ? mockEssayReview(text, chosenModel, docs) : await structuredCall({
    model: chosenModel,
    system: essayReviewSystemPrompt(),
    user: `DOCUMENTS CITED: ${docs.length ? `${docs.join(", ")} (${docs.length} distinct)` : "none"}\n\nESSAY:\n\n${body}\n\nReview it.`,
    schema: ESSAY_REVIEW_SCHEMA,
    maxTokens: 6_000,
    what: "essay review",
    name: "review",
    effort,
  });
  return { ...validateEssayReview(text, raw.parsed ?? {}), documents: docs, model: raw.model, usage: raw.usage };
}

const NEGATION = /\b(?:not|never|no|n['’]t)\b/i;
// An unnamed source or a note to verify: a hedge, never support.
const UNNAMED_SUPPORT = /\b(?:some|many|several|certain|most) (?:scholars|researchers|historians|experts|studies|sources|people)\b|\baccording to (?:some|many|experts|scholars|researchers|historians|studies)\b|\b(?:studies|experts|research|scholars|historians) (?:say|says|show|shows|suggest|suggests|agree)\b|\b(?:requires?|needs?) (?:further )?verification\b/i;
const contentWords = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !/^(?:the|and|did|does|was|were|not|never|furthermore|however|also|that|this|but|have|has|had)$/.test(w)));
/* A rewrite that only negates its sentence: it adds a negation the sentence
 * did not have and nothing else of substance. "The Mongols invented the
 * American dollar." → "Furthermore, the Mongols did not invent the American
 * dollar." */
export function isBareNegation(original, rewrite) {
  if (!rewrite || !NEGATION.test(rewrite) || NEGATION.test(original)) return false;
  const before = contentWords(original);
  const stem = (w) => w.replace(/(?:ed|es|s)$/, "");
  const beforeStems = new Set([...before].map(stem));
  return [...contentWords(rewrite)].every((w) => beforeStems.has(stem(w)));
}
/* A rewrite may only use what the essay already says: every figure, every
 * quoted passage and every capitalised name in it must already be in the
 * essay. Narrowing is fine; inventing is not. */
export function addsNothingNew(rewrite, essay) {
  const hay = String(essay).toLowerCase();
  const figures = String(rewrite).match(/\d[\d.,]*/g) ?? [];
  const quotes = String(rewrite).match(/["“][^"”]{3,}["”]/g) ?? [];
  const names = (String(rewrite).match(/(?<=\s)[\p{Lu}][\p{L}'’-]+/gu) ?? []);
  return [...figures, ...quotes.map((q) => q.slice(1, -1)), ...names].every((t) => hay.includes(String(t).toLowerCase()));
}

/* Only findings the writer can act on, and only what the prompt allows:
 * a known kind, status and action; a quote really in the essay (or none, for
 * a whole-essay kind); the rubric kinds on a DBQ only; a suggestion only for
 * a rewrite, and only one that neither negates the sentence nor adds a fact
 * — a rewrite that fails becomes a deletion when it was a bare negation
 * (the sentence had nothing else to say), else just loses its suggestion. */
export function validateEssayReview(text, parsed) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  const genre = ["dbq", "essay", "other"].includes(parsed?.genre) ? parsed.genre : "other";
  const seen = new Set();
  const findings = (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .map((f) => {
      const kind = ESSAY_REVIEW_KINDS.includes(f?.kind) ? f.kind : null;
      const quote = String(f?.quote ?? "").trim().slice(0, 600);
      let action = ESSAY_REVIEW_ACTIONS.includes(f?.action) ? f.action : "needs_info";
      let suggestion = action === "rewrite" && kind && !NO_REWRITE_KINDS.has(kind) ? String(f?.suggestion ?? "").trim().slice(0, 600) : "";
      if (suggestion && quote && isBareNegation(quote, suggestion)) { suggestion = ""; action = "delete"; }
      if (suggestion && (!addsNothingNew(suggestion, text) || norm(suggestion) === norm(quote))) suggestion = "";
      // A hedge is not a fix: ask for a real source instead.
      if (suggestion && UNNAMED_SUPPORT.test(suggestion)) { suggestion = ""; if (action === "rewrite") action = "cite"; }
      if (action === "rewrite" && !suggestion) action = "needs_info";
      const status = ESSAY_REVIEW_STATUSES.includes(f?.status) ? f.status : "possible";
      // Irrelevant material is deleted, not reworded into something still irrelevant;
      // a source shown to be impossible goes; a DBQ rubric note never writes the analysis.
      if (kind === "relevance") { action = "delete"; suggestion = ""; }
      if ((kind === "source" || kind === "quotation" || kind === "bibliography") && status === "confirmed") action = "delete";
      if (DBQ_ONLY_KINDS.has(kind)) { action = "needs_info"; suggestion = ""; }
      return {
        quote, kind, action, suggestion, status,
        message: String(f?.message ?? "").trim().slice(0, 400),
      };
    })
    .filter((f) => f.kind && f.message && (f.quote ? f.quote.length >= 8 && hay.includes(norm(f.quote)) : ESSAY_WIDE_KINDS.has(f.kind)))
    .filter((f) => genre === "dbq" || !DBQ_ONLY_KINDS.has(f.kind))
    .filter((f) => { const k = norm(f.quote) + "|" + f.kind; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8);
  return { genre, findings: genre === "other" ? [] : findings };
}

// Deterministic, in the real shape, so the panel can be exercised with no key.
function mockEssayReview(text, model, docs) {
  const findings = [];
  const isDbq = docs.length > 0;
  if (isDbq) findings.push({ quote: "", kind: "documents", status: "possible", action: "needs_info", message: `You use ${docs.length} document${docs.length === 1 ? "" : "s"} (${docs.join(", ")}). [mock]`, suggestion: "" });
  const sentences = String(text).split(/(?<=[.!?])\s+/).map((s) => s.trim());
  const broad = sentences.find((s) => /\bsuch as\b/i.test(s) && !/\bDoc(?:ument)?\b/i.test(s));
  if (broad) findings.push({ quote: broad, kind: "evidence", status: "unsupported", action: "cite", message: "A broad claim with nothing specific behind it. [mock]", suggestion: "" });
  const aside = sentences.find((s) => /\b(?:pizza|basketball|shopping|shoes)\b/i.test(s));
  if (aside) findings.push({ quote: aside, kind: "relevance", status: "confirmed", action: "delete", message: "This does not support the argument. Delete it. [mock]", suggestion: "" });
  return { parsed: { genre: isDbq ? "dbq" : "essay", findings }, model: `${model} (mock)`, usage: { input: 0, output: 0, cached: 0 } };
}

function mockReview(text, model) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const findings = [];
  const email = text.match(/[\w.+-]+@[\w-]+(?![\w.-]*\.[a-z]{2,})/i);
  if (email) findings.push({ quote: email[0], kind: "format", message: "This email address has no domain ending, so a recruiter's reply would bounce.", suggestion: "" });
  const bullet = lines.filter((l) => l.split(/\s+/).length > 12).sort((a, b) => b.length - a.length)[0];
  if (bullet) findings.push({ quote: bullet, kind: "bullet", message: "Long and abstract: lead with what you did and what changed because of it.", suggestion: "" });
  return { parsed: { genre: /\b(experience|education|skills)\b/i.test(text) ? "resume" : "other", findings }, model: `${model} (mock)`, usage: { input: 0, output: 0, cached: 0 } };
}

function mockSources(claim, model) {
  // Canned, in the real shape: the citation fields go through the same
  // validation a real answer does. Nothing here is asserted about the pages
  // beyond what a citation needs; unknowns are empty, as the prompt asks.
  const none = { authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" };
  const raw = [
    { title: "Great Wall of China — Visibility from space", url: "https://en.wikipedia.org/wiki/Great_Wall_of_China", publisher: "en.wikipedia.org", snippet: "Notes that the wall is not visible to the naked eye from low Earth orbit, per astronaut accounts.", stance: "refutes", ...none, kind: "reference" },
    { title: "China's Wall Less Great in View from Space", url: "https://www.nasa.gov/vision/space/workinginspace/great_wall.html", publisher: "nasa.gov", snippet: "NASA explains the Great Wall is generally invisible to the unaided eye from orbit.", stance: "refutes", ...none, kind: "institutional", groupAuthor: "NASA", year: 2005 },
    { title: "Is the Great Wall of China visible from space?", url: "https://www.scientificamerican.com/article/is-chinas-great-wall-visible-from-space/", publisher: "scientificamerican.com", snippet: "Reviews the myth and what astronauts actually report seeing from orbit.", stance: "context", ...none, kind: "news" },
  ].map((s) => ({ ...s, snippet: `[mock] ${s.snippet}` }));
  return {
    sources: mergeSources(raw),
    model: `${model} (mock)`,
    usage: { input: 0, output: 0, cached: 0 },
  };
}
