/* The figure rule for source receipts (lib/claimFigures.js): when a sentence
 * states a figure, a source backs it only if its quote shows that figure.
 * The sentences and quotes below are the judged ones in eval/goldset (run
 * `node eval/goldset/figures.mjs` for the measurement). */
import test from "node:test";
import assert from "node:assert/strict";
import { figuresOf, figuresShown, figureMatches } from "../lib/claimFigures.js";

const show = (t) => figuresOf(t).map((f) => `${f.cmp === "gt" ? ">" : f.cmp === "lt" ? "<" : ""}${f.approx ? "~" : ""}${+f.value.toFixed(1)} ${f.kind}${f.digits ? "" : " w"}`);

test("not figures: years, clock times, ordinals, decades, labels, product names, descriptors, vague sizes, citations", () => {
  for (const t of [
    "The American Academy of Pediatrics recommended in 2014 that schools start no earlier than 8:30 a.m.",
    "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface.",
    "By the 19th century, and again in the 1990s, see Chapter 5 and Doc 3 on page 12, lines 5-8.",
    "GPT-5 class models and COVID-19 and K-12 schools; a two-bedroom flat; a fourteen-year-old; World War 2.",
    "Resistance genes have been recovered from sediment tens of thousands of years older; hundreds of studies.",
    "Orben and Przybylski (2019) found it; so did (Shoup 45) and [8].",
    "It was a study of one of the schools, a decade later.",
    "Between 2010/11 and 2022/23, and again over 1939-1945 and the 2019-20 season.",
  ]) assert.deepEqual(show(t), [], t);
  assert.deepEqual(show("Investment in youth facilities has fallen by 73% between 2010/11 and 2022/23."), ["73 percent"], "fiscal years are not figures");
});

test("figures: percentages, fractions, money, scaled and plain counts, number words, with roughly / more than / less than", () => {
  assert.deepEqual(show("Teenagers require between eight and ten hours, and roughly 70 percent of them get less than seven."), ["~70 percent", "8 count w", "10 count w", "<7 count w"]);
  assert.deepEqual(show("1 out of every 3 antibiotic drugs prescribed is unnecessary"), ["33.3 percent"]);
  assert.deepEqual(show("including 1·27 million (95% UI 0·911-1·71) deaths"), ["95 percent", "1270000 count", "0.9 count", "1.7 count"]);
  assert.deepEqual(show("now lists for more than $2,400 a month, and the vacancy rate has been under two percent"), ["<2 percent w", ">2400 money"]);
  assert.deepEqual(show("for under a hundred dollars"), ["<100 money w"]);
  assert.deepEqual(show("within fifty years presses were operating in more than two hundred cities"), ["50 count w", ">200 count w"]);
  assert.deepEqual(show("1,274 measles cases in 2019"), ["1274 count"], "a 4-digit count before its noun, the year after 'in'");
  assert.deepEqual(show("attrition fell by half, and two-thirds stayed"), ["50 percent w", "66.7 percent w"]);
  assert.deepEqual(show("eight in a row"), ["8 count w"], "'a' is no number on its own");
});

test("a match: same kind, close enough; roughly loosens it; more than / less than are bounds", () => {
  const f = (t) => figuresOf(t)[0];
  assert.ok(figureMatches(f("roughly 30 percent"), f("1 out of every 3")));
  assert.ok(figureMatches(f("roughly 70 percent"), f("72.7%")));
  assert.ok(!figureMatches(f("70 percent"), f("17.7%")));
  assert.ok(!figureMatches(f("30 percent"), f("30 schools")), "a percentage is not a count");
  assert.ok(figureMatches(f("more than two hundred cities"), f("around 250 locations")));
  assert.ok(!figureMatches(f("more than two hundred cities"), f("150 towns")));
  assert.ok(figureMatches(f("1.27 million deaths"), f("1·27 million")));
  assert.ok(!figureMatches(f("1.27 million deaths"), f("4·95 million")));
});

test("the judged cases: the receipt must show the sentence's figure", () => {
  // The two the judges rejected and production's verifier passed.
  assert.equal(figuresShown("Teenagers require between eight and ten hours of sleep per night, and roughly 70 percent of them get less than seven.",
    "The American Academy of Sleep Medicine recommends that teenagers 13 to 18 years of age should sleep 8 to 10 hours per 24 hours").ok, false);
  assert.equal(figuresShown("Johannes Gutenberg introduced movable-type printing to Europe around 1450, and within fifty years printing presses were operating in more than two hundred European cities.",
    "Around 1450, Johannes Gutenberg introduced the first movable-type printing system in Europe").ok, false);
  // Ones the judges accepted, which must stay.
  const keep = [
    ["Johannes Gutenberg introduced movable-type printing to Europe around 1450, and within fifty years printing presses were operating in more than two hundred European cities.", "By 1500 printing offizins had emerged at around 250 locations"],
    ["A randomized controlled trial at a Chinese travel agency found that employees working from home were roughly 13 percent more productive than their in-office counterparts, and that attrition fell by half.", "Home working led to a 13% performance increase, of which 9% was from working more minutes per shift"],
    ["Roughly 30 percent of antibiotic prescriptions written in American outpatient settings are unnecessary, and that overprescription is the main reason resistant infections have risen inside hospitals.", "In U.S. outpatient doctors' offices specifically, 1 out of every 3 antibiotic drugs prescribed is unnecessary"],
    ["The American Academy of Pediatrics recommended in 2014 that middle and high schools start no earlier than 8:30 a.m., yet the majority of public high schools in the United States still begin before that.", "In a policy statement published in 2014, the American Academy of Pediatrics (AAP) urged middle and high schools to modify start times"],
    ["A 2019 global analysis attributed 1.27 million deaths directly to bacterial antimicrobial resistance, more than either HIV or malaria caused that year.", "including 1·27 million (95% UI 0·911-1·71) deaths attributable to bacterial AMR"],
    ["Resistance genes have been recovered from permafrost sediment tens of thousands of years older than any human medicine.", "ancient DNA from 30,000-year-old Beringian permafrost sediments"],
    ["The moment of animation takes up barely a paragraph.", "One paragraph, 98 words out 75,000 depict the creature creation"],
  ];
  for (const [claim, quote] of keep) assert.equal(figuresShown(claim, quote).ok, true, claim);
});

test("a sentence with no figure is never held to one", () => {
  assert.deepEqual(figuresShown("Some researchers argue the effect is small.", "Others point out that the effect sizes are too small"), { ok: true, missing: [] });
});
