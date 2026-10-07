/* /api/review — a genre-aware writing review (lib/factcheck.js runReview,
 * validateReview), and the check prompt's document-type clause.
 *
 * Owner, 2026-10-03, on a resume the checker answered with eight
 * "needs_citation" flags ("$10K+ in revenue" wanting "business records"):
 * "for this obvious resume … right now tracely wants to add citations.
 * Instead, it can give tips about formatting issues or if one of the bullet
 * points is bad it can flag that." The resume below is invented. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReview, validateReview, REVIEW_KINDS } from "../lib/factcheck.js";
import { ROUTES, modelForRoute, DAILY_REVIEW, REVIEW_MIN_INTERVAL_MS } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

const RESUME = [
  "Jordan Rivera",
  "jordan.rivera@outlook ● (555) 010-2234",
  "EDUCATION",
  "Lakeside High School - Junior",
  "EXPERIENCE",
  "Harbor Cafe",
  "Barista",
  "June 2025 - August 2025",
  "Spearheaded robust, high-velocity customer engagement initiatives leveraging synergistic service frameworks across all touchpoints.",
  "Trained 4 new baristas on the espresso machine.",
  "SKILLS",
  "Customer service, Spanish",
].join("\n");

test("the review keeps only findings it can point at: verbatim quote, a known kind, a message", () => {
  const { genre, findings } = validateReview(RESUME, {
    genre: "resume",
    findings: [
      { quote: "jordan.rivera@outlook", kind: "format", message: "No domain ending.", suggestion: "" },
      { quote: "Spearheaded robust, high-velocity customer engagement initiatives", kind: "bullet", message: "Buzzwords instead of what you did.", suggestion: "Served customers at a busy cafe." },
      { quote: "Managed a team of 12 at a Fortune 500 company.", kind: "bullet", message: "Not in the document.", suggestion: "" },
      { quote: "Barista", kind: "grammar", message: "Not one of our kinds.", suggestion: "" },
      { quote: "Lakeside High School - Junior", kind: "format", message: "", suggestion: "" },
    ],
  });
  assert.equal(genre, "resume");
  assert.deepEqual(findings.map((f) => f.kind), ["format", "bullet"]);
  assert.ok(REVIEW_KINDS.includes("typo"));
});

test("a suggested rewrite may only narrow its line: an invented figure or name is dropped, the message kept", () => {
  const { findings } = validateReview(RESUME, {
    genre: "resume",
    findings: [
      { quote: "Trained 4 new baristas on the espresso machine.", kind: "bullet", message: "Say what changed.", suggestion: "Trained 4 new baristas, cutting wait times 30% at Starbucks." },
      { quote: "Spearheaded robust, high-velocity customer engagement initiatives leveraging synergistic service frameworks across all touchpoints.", kind: "bullet", message: "Buzzwords.", suggestion: "Served customers and kept orders moving." },
    ],
  });
  assert.equal(findings[0].suggestion, "", "Starbucks is not in the line: the rewrite invented it");
  assert.equal(findings[0].message, "Say what changed.");
  assert.equal(findings[1].suggestion, "Served customers and kept orders moving.", "a pure cut survives");
});

test("not a resume: genre reported, no findings (the extension asks only for resumes)", () => {
  const r = validateReview("Sleep matters for memory.", { genre: "essay", findings: [{ quote: "Sleep matters", kind: "bullet", message: "x", suggestion: "" }] });
  assert.deepEqual(r, { genre: "essay", findings: [] });
  assert.equal(validateReview("x", { genre: "novel", findings: [] }).genre, "other", "an unknown genre is other");
});

test("at most six findings, duplicates dropped", () => {
  const many = Array.from({ length: 9 }, () => ({ quote: "Barista", kind: "typo", message: "Check it.", suggestion: "" }));
  assert.equal(validateReview(RESUME, { genre: "resume", findings: many }).findings.length, 1, "the same line and kind once");
  const distinct = RESUME.split("\n").slice(0, 9).map((q) => ({ quote: q, kind: "format", message: "Check it.", suggestion: "" }));
  assert.equal(validateReview(RESUME, { genre: "resume", findings: distinct }).findings.length, 6);
});

test("mock mode answers in the real shape, from the document itself", async () => {
  const r = await runReview({ text: RESUME, model: "gpt-5.6-luna", mock: true });
  assert.equal(r.genre, "resume");
  assert.ok(r.findings.some((f) => f.kind === "format" && f.quote === "jordan.rivera@outlook"), "the email with no domain ending");
  assert.ok(r.findings.some((f) => f.kind === "bullet" && f.quote.startsWith("Spearheaded")), "the buzzword bullet");
  assert.match(r.model, /\(mock\)$/);
});

test("the route is metered like flow: its own daily kind, a once-a-minute floor, the fast model at low", () => {
  assert.ok(ROUTES.includes("review"));
  assert.deepEqual(modelForRoute("review", "free"), { model: "gpt-5.6-luna", effort: "low", maxTokens: undefined, thorough: false });
  assert.deepEqual(DAILY_REVIEW, { free: 30, student: 120, pro: 120 });
  assert.equal(REVIEW_MIN_INTERVAL_MS, 60_000);
  for (const set of ["EXTENSION_API", "PAID_ROUTES", "MODEL_ROUTES", "EXTENSION_MODEL_ROUTES"]) {
    const decl = SERVER.slice(SERVER.indexOf(`const ${set} = new Set([`), SERVER.indexOf("]);", SERVER.indexOf(`const ${set} = new Set([`)));
    assert.ok(decl.includes('"/api/review"'), `${set} lists /api/review`);
  }
  assert.match(SERVER, /"\/api\/review": \{ input: 6_000, output: 6_000, webSearchCalls: 0 \}/, "a worst-case hold, or the paid pools reserve nothing for it");
  // /api/entitlement is frozen while a Web Store build is in review: no new field.
  assert.ok(!SERVER.includes("reviewPerDay"), "the entitlement response is unchanged");
});

test("the check prompt decides what the document is before it asks for citations", () => {
  assert.match(FACTCHECK, /Decide first what the DOCUMENT is\./);
  assert.match(FACTCHECK, /a resume, CV, cover letter, personal statement or bio; fiction, a personal narrative or journal; an email, message or notes — never use "needs_citation"/);
  assert.match(FACTCHECK, /what the author says they did, won or plan is "no_claim", never "questionable"/);
  assert.match(FACTCHECK, /still use "false" for a public fact stated wrongly/);
});
