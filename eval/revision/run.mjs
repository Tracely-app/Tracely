#!/usr/bin/env node
/* What the model does with the owner's deliberately flawed Mongol essay
 * (2026-10-05). The rules around the model are pinned by
 * server/test/revision-quality.test.js with no key; this measures the part
 * only a real call can: does the essay review RAISE each planted problem, and
 * does the sentence check still hand back a negation as a "fix"?
 *
 *   OPENAI_API_KEY=… node eval/revision/run.mjs          # ~1 cent
 *
 * The review returns at most 8 findings, most important first, and this
 * essay plants more than 8 problems on purpose: a writer fixes the top ones
 * and the next review raises the rest. So the report counts coverage over
 * one call and lists what was missed, rather than failing on a missing item.
 * Nothing here guarantees factual accuracy; it measures what the review saw. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runReview, runFactCheck, isBareNegation } = await import(pathToFileURL(path.join(HERE, "..", "..", "server", "lib", "factcheck.js")).href);
const ESSAY = readFileSync(path.join(HERE, "flawed-mongols.txt"), "utf8");
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY is not set — nothing was run."); process.exit(2); }

// Each planted problem: a phrase from its passage, and the kinds that count as catching it.
const PLANTED = [
  ["invented the American dollar", ["relevance", "reasoning", "source"], "delete"],
  ["Buying shoes through online shopping", ["relevance"], "delete"],
  ["Basketball requires teamwork", ["relevance"], "delete"],
  ["My friend visited a Buddhist temple", ["relevance"], "delete"],
  ["Pizza originated in Italy", ["relevance"], "delete"],
  ["Albert Einstein wrote in his book about Genghis Khan", ["quotation", "source"], "delete"],
  ["Einstein, Albert. Genghis Khan and Everything", ["bibliography", "source"], "delete"],
  ["Harvard. Why Mongols Were Always Right", ["bibliography", "source"], null],
  ["History.com / Gutenberg / accessed yesterday", ["citation"], null],
  ["does not need a publication date because Harvard", ["citation"], null],
  ["requires verification", ["citation", "evidence"], null],
  ["Exactly 98% of all trade", ["evidence", "source"], null],
  ["which proves that every empire after them was tolerant", ["reasoning"], null],
  ["completely peaceful and very violent", ["contradiction"], null],
];

const review = await runReview({ text: ESSAY, model: "gpt-5.6-luna", effort: "low", kind: "essay" });
console.log(`essay review: genre=${review.genre}, ${review.findings.length} findings`);
for (const f of review.findings) console.log(`  ${f.kind}/${f.status}/${f.action}: ${(f.quote || "(whole essay)").slice(0, 70)}${f.suggestion ? `  → ${f.suggestion.slice(0, 60)}` : ""}`);
let caught = 0;
const missed = [];
for (const [phrase, kinds, action] of PLANTED) {
  const hit = review.findings.find((f) => f.quote.includes(phrase) && kinds.includes(f.kind));
  if (hit && (!action || hit.action === action)) caught++;
  else missed.push(phrase + (hit ? ` (raised as ${hit.kind}/${hit.action}, wanted ${action})` : ""));
}
console.log(`\nplanted problems raised in one review: ${caught}/${PLANTED.length} (at most 8 per review by design)`);
if (missed.length) console.log("not raised in this review:\n  - " + missed.join("\n  - "));

const sentences = ESSAY.split("\nWorks Cited")[0].split(/(?<=[.!?”])\s+/).map((t) => t.trim()).filter((t) => t.split(/\s+/).length >= 4).map((t, i) => ({ id: `s${i}`, text: t }));
const check = await runFactCheck({ text: ESSAY, sentences, model: "gpt-5.6-luna", effort: "medium" });
const negations = check.findings.filter((f) => f.revision && isBareNegation(sentences.find((s) => s.id === f.id)?.text ?? "", f.revision));
console.log(`\nsentence check: ${check.findings.filter((f) => f.verdict !== "accurate" && f.verdict !== "no_claim").length} flagged; fixes that only negate their sentence: ${negations.length}`);
for (const f of negations) console.log(`  - ${f.revision}`);
process.exit(negations.length ? 1 : 0);
