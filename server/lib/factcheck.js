import { CheckError } from "./errors.js";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  chooseModel,
  hasApiKey,
  structuredCall,
  webSearchCall,
} from "./llm.js";
import { citeFields, SOURCE_KINDS } from "./citeFields.js";

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
  return `You are Tracely's fact-checker, embedded in a writing tool. The author sees your findings as underlines while they type. You judge one thing: whether the factual content of each sentence is correct, verifiable and attributed. You hold no view on style, tone, politics, or whether a claim is comfortable to read, and you never judge the author.

You receive the full document for context plus a list of sentences to evaluate. Return exactly one finding for EVERY listed sentence id — no more, no fewer.

Verdicts, in order of precedence:
- "false": a specific factual claim in the sentence contradicts an established fact — one you can state precisely (the correct date, number, name, place or mechanism) and that standard references document. Put that correct fact in "basis". If you cannot state the correct fact, the sentence is not "false".
- "incoherent": the sentence contradicts itself, or its conclusion does not follow from its own premise. "basis" names the contradiction. Long, awkward or unclear writing is NOT incoherent.
- "questionable": a checkable claim you cannot settle either way — the record is genuinely unsettled, the figure is stated with more precision than any source supports, or it depends on events after your knowledge. "basis" says exactly what cannot be verified. Never use "questionable" as a hedge on a fact you know, and never because a true claim is unpopular, uncomfortable or politically charged.
- "needs_citation": the claim is accurate, but it is the kind of assertion a reader expects a source for — a statistic, a study finding, a quotation, a dated event, a specific non-common-knowledge fact — and no citation marker, parenthetical or prose attribution appears in or around the sentence. "basis" names the kind of source that would support it.
- "accurate": the factual claims are correct, and either they are common knowledge or a citation or attribution is present.
- "no_claim": the sentence contains no checkable factual claim — an opinion, value judgement, prediction, greeting, instruction, question or framed fiction — however forcefully it is stated. "Jazz is the greatest art form America has produced" is no_claim, not false.

Rules:
- Judge each sentence in the context of the whole document; resolve pronouns and references from the surrounding text.
- A citation can be a bracketed marker like [1], a parenthetical (Author, year), or prose attribution ("According to…", "X reported…"). Any of these count as cited — never flag them "needs_citation". Ignore bracketed markers when judging the claim itself.
- Widely known facts (capitals, famous dates, basic science) are common knowledge: "accurate", not "needs_citation".
- Reasonable, widely used approximations and rounded figures are accurate.
- A sentence that is right in every detail but one is "false" — name the one detail.
- Be consistent: the same sentence always gets the same verdict.
- "basis": a statement of fact in plain words, at most 30 words — never advice, never a remark about the author.
- "explanation": shown to the author, at most 25 words, concrete. For "false", state the correct fact. For "needs_citation", name the kind of source. For "questionable", say what cannot be verified. For "incoherent", say where the sentence breaks.
- "revision": for "false" and "incoherent", the minimal rewrite that makes the sentence correct while keeping the author's voice — never add surrounding sentences. For "questionable", a more careful wording only when one is warranted, else "". Always "" for "needs_citation": it needs a source, not different words.
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
export async function runFactCheck({ text, sentences, model, effort, mock = false, admitSplit = null, admitCalls = null, maxTokens = undefined }) {
  const chosenModel = chooseModel(model);
  if (mock) return mockFindings(sentences, chosenModel);
  const context = checkContext(text);
  // `effort` used to be destructured here and then dropped, so the slider
  // moved the model and nothing else. undefined falls to lib/llm.js's
  // DEFAULT_EFFORT rather than to OpenAI's much costlier default.
  const shards = shardSentences(sentences);
  if (shards.length === 1 || !callsAdmitted(admitCalls, shards.length - 1)) {
    return checkBatch({ text: context, sentences, model: chosenModel, effort, admitSplit, maxTokens });
  }
  const settled = await Promise.allSettled(shards.map((s) => checkBatch({ text: context, sentences: s, model: chosenModel, effort, admitSplit, maxTokens })));
  const done = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    // Every shard that answered was billed, and so was whatever the failing
    // one managed — the route records only what the error it catches carries.
    const billed = done.reduce((acc, r) => addUsage(acc, r.usage), null);
    throw withBilledUsage(failed.reason, billed, failed.reason?.llm);
  }
  return {
    findings: done.flatMap((r) => r.findings),
    model: done[0]?.model ?? chosenModel,
    usage: done.reduce((acc, r) => addUsage(acc, r.usage), { input: 0, output: 0, cached: 0, cacheWrite: 0 }),
    shards: shards.length,
  };
}

async function checkBatch({ text, sentences, model, effort, admitSplit, maxTokens, retryMissing = true }) {
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
    });
  } catch (err) {
    // Output budget exhausted — split the batch so each retry makes progress.
    // A single sentence that still truncates has nothing left to split.
    if (err?.kind === "truncated" && sentences.length > 1 && splitAdmitted(admitSplit)) {
      const mid = Math.ceil(sentences.length / 2);
      let first = null;
      try {
        first = await checkBatch({ text, sentences: sentences.slice(0, mid), model, effort, admitSplit, maxTokens });
        const second = await checkBatch({ text, sentences: sentences.slice(mid), model, effort, admitSplit, maxTokens });
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
    const again = await checkBatch({ text, sentences: missed, model, effort, admitSplit, maxTokens, retryMissing: false });
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

After researching, your FINAL message must be ONLY a JSON object, no prose, in this exact shape:
{"sources":[{"title":"...","url":"...","publisher":"...","snippet":"...","stance":"supports"|"refutes"|"context","kind":"...","authors":[],"groupAuthor":"","year":null,"date":"","container":"","editors":[],"doi":""}]}

Rules:
- 3 to 5 sources, ranked best-first. Prefer primary and authoritative sources (scientific bodies, encyclopedias, government agencies, reputable news) over blogs and content farms.
- "stance" is relative to the ORIGINAL claim: "supports" backs the claim as written, "refutes" contradicts it, "context" informs without settling it.
- "snippet": one sentence (max 30 words) describing what the source says about the claim.
- Use real URLs from your search results only. Never invent URLs.

Citation fields. A student's reference list is built from these, so copy ONLY what the source itself states; never guess, never infer from the URL, the site or what is typical. Empty is correct: use "", [] or null whenever the source does not say.
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

export async function findSources({ claim, correction, context, model, effort, mock = false }) {
  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  if (mock) return mockSources(claim, chosenModel);

  const userMsg =
    `CLAIM:\n${claim}\n` +
    (correction ? `\nPROPOSED CORRECTION:\n${correction}\n` : "") +
    (context ? `\nDOCUMENT CONTEXT (excerpt):\n${context.slice(0, 3000)}\n` : "") +
    `\nFind sources, then output only the JSON object.`;

  // The web_search tool bills per call on top of tokens, which is why
  // findSources is the one path with a caller-side budget (search/webBudget).
  // `effort` undefined sends no reasoning effort — the vendor's default, which
  // is what every source search has run at; the widgets send none here (see
  // webSearchCall). A caller-chosen level is sent.
  const { text: fullText, citations, model: usedModel, usage, webSearchCalls, sent } = await webSearchCall({
    model: chosenModel,
    system: SOURCES_SYSTEM,
    user: userMsg,
    maxTokens: 6_000,
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

  // `webSearchCalls`: what the search tool billed, per call — the route
  // records it and keeps it out of the response.
  return { sources: merged, model: usedModel, usage, webSearchCalls };
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
