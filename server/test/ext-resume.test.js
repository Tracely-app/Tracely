/* The extension knows a resume when it sees one (content.js detectGenre), and
 * treats it as one: no citation flags (flagShown), free format rules
 * (resumeFormatIssues), and Resume tips merged with /api/review's notes
 * (resumeTips / resumeTipsHtml). Owner, 2026-10-03: "for this obvious resume
 * … right now tracely wants to add citations. Instead, it can give tips about
 * formatting issues or if one of the bullet points is bad it can flag that."
 * Every document below is invented. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const BG = readFileSync(path.join(HERE, "..", "..", "extension", "background.js"), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  const c = SRC.indexOf("  function wireChrome(", b);
  const f0 = SRC.indexOf("  const ISSUE_VERDICTS =");
  const f1 = SRC.indexOf("  /* Card titles", f0);
  assert.ok(a > 0 && b > a && c > b && f0 > 0 && f1 > f0, "content.js: the slices moved");
  const code = `
    const CHECK_INTERVAL_MS = 10000;
    const FEATURES = { citeHintsToggle: false };
    function hashText(s) { const n = s.toLowerCase().replace(/\\s+/g, " ").trim(); let h = 5381; for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) >>> 0; return "s" + h.toString(36); }
    ${SRC.slice(f0, f1)}
    ${SRC.slice(a, c)}
    ({ detectGenre, resumeFormatIssues, resumeTips, resumeTipsHtml, flagShown })`;
  return vm.runInContext(code, vm.createContext({}));
}
const X = load();

const RESUME = [
  "Jordan Rivera",
  "jordan.rivera@outlook ● (555) 010-2234",
  "EDUCATION",
  "Lakeside High School - Junior",
  "Portland, OR",
  "EXPERIENCE",
  "Harbor Cafe",
  "Barista",
  "Seattle, Washington",
  "June 2025 – August 2025",
  "Served customers during the morning rush and kept the espresso station stocked and clean.",
  " Trained four new baristas on the espresso machine and the opening checklist for the cafe.",
  "City Library",
  "Volunteer",
  "Eugene, OR",
  "January 2024 – Present",
  "• Shelved returns and helped younger readers find books during the summer reading program.",
  "Ran the weekly chess club for twelve students and organised a small end of year tournament.",
  "Robotics Club",
  "March 3, 2024– March 5, 2024",
  "SKILLS",
  "Customer service, Spanish, Python",
].join("\n");

const ESSAY = [
  "Why sleep matters",
  "Sleep improves memory, according to many studies of students and adults across the world.",
  "It also helps the body recover after a long day of physical work, exercise and stress.",
  "Experience",
  "Most people who sleep less than six hours a night report feeling tired at work and school.",
  "Teenagers need more sleep than adults because their brains are still developing quickly.",
  "In conclusion, sleep is one of the most important habits a person can build for health.",
].join("\n");

const COVER_LETTER = [
  "Dear Hiring Manager,",
  "I am writing to apply for the barista position at Harbor Cafe, which I saw advertised last week.",
  "Over the past year I have worked in a busy cafe and learned to keep calm during the morning rush.",
  "I enjoy talking with customers and I take pride in making every drink the same way, every time.",
  "I would welcome the chance to bring that care to your team, and I am available on weekends.",
  "Thank you for your time and consideration.",
  "Sincerely,",
  "Jordan Rivera",
].join("\n");

test("detects a resume, and not an essay with a heading called Experience", () => {
  assert.equal(X.detectGenre(RESUME), "resume");
  assert.equal(X.detectGenre(ESSAY), "prose", "one heading-like word and full sentences: an essay");
  assert.equal(X.detectGenre(COVER_LETTER), "letter", "Dear … Sincerely: a letter, its own genre");
  assert.equal(X.detectGenre("EXPERIENCE\nSKILLS"), "prose", "too short to judge");
  assert.equal(X.detectGenre(""), "prose");
});

test("on a resume, a citation flag is never shown; on anything else, unchanged", () => {
  const cite = { verdict: "needs_citation" }, wrong = { verdict: "false" };
  assert.equal(X.flagShown(cite, {}, "resume"), false);
  assert.equal(X.flagShown(wrong, {}, "resume"), true, "a public fact stated wrongly still shows (the University of California's real name)");
  assert.equal(X.flagShown(cite, {}, "prose"), true);
  assert.equal(X.flagShown(cite, {}), true, "callers that pass no genre behave as before");
});

test("the free format rules name the slips — the minority, never the writer's house style", () => {
  const issues = X.resumeFormatIssues(RESUME);
  const quotes = issues.map((i) => i.quote);
  assert.ok(quotes.includes("jordan.rivera@outlook"), "an email with no domain ending");
  assert.ok(quotes.includes("March 3, 2024– March 5, 2024"), "the one date written with days");
  assert.ok(quotes.includes("Seattle, Washington"), "the one state spelled out among abbreviations");
  assert.ok(!quotes.includes("Portland, OR") && !quotes.includes("Eugene, OR"), "the majority style is not flagged");
  assert.ok(quotes.some((q) => q.startsWith("• Shelved returns")), "the one bullet with a marker");
  assert.ok(quotes.some((q) => q.startsWith("Trained four new baristas")), "the line with a stray leading space");
  assert.ok(issues.length <= 6 && issues.every((i) => i.kind === "format" && i.message));
  for (const q of quotes) assert.ok(RESUME.includes(q), `quote is verbatim: ${q}`);
});

test("a clean resume gets no format notes", () => {
  const clean = [
    "Jordan Rivera", "jordan.rivera@outlook.com ● (555) 010-2234", "EDUCATION", "Lakeside High School", "Portland, OR",
    "EXPERIENCE", "Harbor Cafe", "Seattle, WA", "June 2025 – August 2025",
    "Served customers during the morning rush and kept the espresso station stocked and clean.",
    "Trained four new baristas on the espresso machine and the opening checklist for the cafe.",
    "SKILLS", "Customer service, Spanish",
  ].join("\n");
  assert.equal(X.detectGenre(clean), "resume");
  assert.deepEqual(Array.from(X.resumeFormatIssues(clean)), []);
});

test("Resume tips: free rules first, then the review's notes, each line once, gone once fixed or dismissed", () => {
  const model = [
    { quote: "Served customers during the morning rush and kept the espresso station stocked and clean.", kind: "bullet", message: "Duties, no result.", suggestion: "Served customers during the morning rush." },
    { quote: "jordan.rivera@outlook", kind: "format", message: "Duplicate of a rule.", suggestion: "" },
    { quote: "Harbor Caffe", kind: "typo", message: "Not in the text.", suggestion: "" },
    { quote: "Barista", kind: "praise", message: "Unknown kind.", suggestion: "" },
  ];
  const tips = X.resumeTips(RESUME, model, new Set());
  const kinds = tips.map((t) => t.kind);
  assert.equal(kinds.indexOf("bullet"), kinds.length - 1, "the model's note comes after the instant rules");
  assert.equal(tips.filter((t) => t.quote === "jordan.rivera@outlook").length, 1, "a line and kind once");
  assert.ok(!tips.some((t) => t.quote === "Harbor Caffe" || t.kind === "praise"));
  const bullet = tips.find((t) => t.kind === "bullet");
  assert.equal(X.resumeTips(RESUME, model, new Set([bullet.id])).some((t) => t.kind === "bullet"), false, "dismissed");
  const fixed = RESUME.replace("jordan.rivera@outlook", "jordan.rivera@outlook.com");
  assert.ok(!X.resumeTips(fixed, model, new Set()).some((t) => t.quote === "jordan.rivera@outlook"), "fixed: the note drops out at once");
});

test("the tips render escaped, neutral, with Copy only where there is a rewrite", () => {
  const tips = [
    { id: "tip:a", quote: "<b>Led</b> team", kind: "bullet", message: "Say what changed.", suggestion: "Led the <i>team</i>." },
    { id: "tip:b", quote: "x@y", kind: "format", message: "No domain.", suggestion: "" },
  ];
  const html = X.resumeTipsHtml(tips, false, null);
  assert.match(html, /Resume tips \(2\)/);
  assert.ok(!html.includes("<b>Led</b>") && html.includes("&lt;b&gt;Led&lt;/b&gt;"), "quotes are escaped");
  assert.equal((html.match(/data-tip-copy=/g) || []).length, 1);
  assert.equal((html.match(/data-tip-x=/g) || []).length, 2);
  assert.ok(!/class="dot/.test(html), "no finding colour: advice, not a finding");
  assert.match(X.resumeTipsHtml([], true, null), /Reading your bullets…/);
  assert.match(X.resumeTipsHtml([], false, null), /reads cleanly/);
});

test("wired: the background worker relays /api/review, and the call is gated", () => {
  assert.match(BG, /const API_PATHS = new Set\(\[[^\]]*"\/api\/review"/, "or api() fails with 'No reply from the Tracely background worker'");
  assert.equal((SRC.match(/async function requestReview\(text\)/g) || []).length, 2, "Docs and field mode");
  assert.equal((SRC.match(/api\("\/api\/review", \{ text: text\.slice\(0, REVIEW_MAX_CHARS\), model: CHECK_MODEL, kind \}\)/g) || []).length, 2, "no effort sent: the server decides");
  assert.match(SRC, /if \(!kind \|\| review\.inflight \|\| review\.unavailable\) return;/, "resumes only, one at a time, off after a 404");
  assert.match(SRC, /Date\.now\(\) - lastTextChangeAt < REVIEW_IDLE_MS \|\| Date\.now\(\) - review\.at < REVIEW_FLOOR_MS/, "still text, and at most once a minute");
  assert.match(SRC, /if \(err\?\.kind === "not_found"\) review\.unavailable = true;/, "an older server without the route: quiet, not an error");
  assert.equal((SRC.match(/flagShown\(.*?, settings, docGenre, (?:seg|x)\.text, (?:citedLater|liveCovered)\.has\((?:seg|x)\.hash\)\)/g) || []).length, 4, "every place a verdict is shown knows the genre and the sentence");
  assert.equal((SRC.match(/FEATURES\.evidenceHints && isArgumentGenre\(docGenre\)/g) || []).length, 2, "no evidence suggestions on a resume or a letter");
  assert.match(SRC, /const isArgumentGenre = \(g\) => g === "prose" \|\| g === "research" \|\| g === "literary";/);
});
