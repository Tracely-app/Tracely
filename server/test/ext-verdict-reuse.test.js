/* A sentence changed only by a typo or punctuation keeps its verdict
 * (content.js smallEdit, inheritedVerdict, inheritVerdicts). Cost idea 2,
 * owner 2026-10-04. Every edit that could change what the sentence CLAIMS
 * must still be re-checked — the negative cases outnumber the positive ones
 * on purpose. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  assert.ok(a > 0 && b > a, "content.js: the slice moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000;
    function hashText(s) { return s.toLowerCase().replace(/\\s+/g, " ").trim(); }
    ${SRC.slice(a, b)}
    ({ smallEdit, inheritedVerdict, segmentText, hashText })`, vm.createContext({}));
}
const X = load();

const S = "Lamine Yamal is a winger who recieved the Golden Boy award in 2024.";

test("reused: case, spacing, punctuation, one typo-sized slip in an ordinary word", () => {
  const same = [
    S.replace("recieved", "received"),                     // swapped letters
    S.replace("winger", "wingger"),                        // a doubled letter
    S.replace("award", "awrd"),                            // a dropped letter
    S.replace("award", "awsrd"),                           // one wrong letter
    S.replace(" in 2024.", " in 2024"),                    // the full stop
    S.replace("winger who", "winger, who"),                // a comma
    S.replace("is a", "is  a"),                            // spacing
    S.replace("Lamine", "lamine"),                         // case
  ];
  for (const t of same) assert.equal(X.smallEdit(S, t), true, t);
  assert.equal(X.smallEdit("Teh award went to Yamal.", "The award went to Yamal."), false, "a 3-letter word is too short to call a typo");
});

test("re-checked: anything that can change what the sentence claims", () => {
  const changed = {
    "a number": S.replace("2024", "2023"),
    "a decimal point": ["Prices rose 2.5 percent.", "Prices rose 25 percent."],
    "a thousands separator": ["It cost 5,000 dollars.", "It cost 5000 dollars."],
    "a percent sign": ["Turnout was 60% higher.", "Turnout was 60 higher."],
    "a name": ["The team flew to Austria for the final.", "The team flew to Australia for the final."],
    "a capitalised name, one letter": S.replace("Golden", "Golder"),
    "a negation": ["Vaccines do cause autism.", "Vaccines don't cause autism."],
    "not": ["The study was not peer reviewed.", "The study was peer reviewed."],
    "a number word": ["Nine students passed the exam.", "None students passed the exam."],
    "a quantity word": ["Most doctors recommend it daily.", "Many doctors recommend it daily."],
    "a different word": ["Smoking increases the risk of cancer.", "Smoking decreases the risk of cancer."],
    "two words": S.replace("recieved", "received").replace("award", "awrd"),
    "a word added": S.replace("winger", "young winger"),
    "a word removed": S.replace("a winger who ", ""),
    "a short word": ["The rate was low in May.", "The rate was lot in May."],
  };
  for (const [why, v] of Object.entries(changed)) {
    const [a, b] = Array.isArray(v) ? v : [S, v];
    assert.equal(X.smallEdit(a, b), false, why);
  }
});

test("inheritedVerdict: only from a checked sentence that is gone, and each one once", () => {
  const cache = new Map([["old1", { verdict: "false" }], ["old2", { verdict: "accurate" }]]);
  const prev = [{ hash: "old1", text: S }, { hash: "old2", text: "Water boils at 100 degrees." }];
  const seg = { hash: "new1", text: S.replace("recieved", "received") };
  const taken = new Set();
  assert.equal(X.inheritedVerdict(seg, prev, new Set(["new1"]), cache, taken)?.hash, "old1");
  assert.equal(X.inheritedVerdict({ hash: "new2", text: seg.text + "" }, prev, new Set(["new1", "new2"]), cache, taken), null, "old1 is already taken");
  assert.equal(X.inheritedVerdict(seg, prev, new Set(["new1", "old1"]), cache, new Set()), null, "the old sentence is still there: nothing was edited");
  assert.equal(X.inheritedVerdict(seg, prev, new Set(["new1"]), new Map(), new Set()), null, "never checked: nothing to inherit");
});

test("wired into both modes: before the check, with the dismissal carried and a console count", () => {
  assert.equal((SRC.match(/const before = segments;\n\s+segments = segmentText\((?:docText|fieldText)\);/g) || []).length, 2);
  assert.match(SRC, /settleEditStates\(readAt\);\n\s+if \(inheritVerdicts\(before\)\) persistCaches\(\);\n\s+const todo = uncheckedSegments\(\)/, "Docs: after the edit bookkeeping, before choosing what to send");
  assert.match(SRC, /segments = segmentText\(fieldText\);\n\s+if \(inheritVerdicts\(before\)\) persistFieldCache\(\);\n\s+const todo = uncheckedSegments\(\)/, "field mode: before choosing what to send");
  assert.equal((SRC.match(/function inheritVerdicts\(before\) \{/g) || []).length, 2);
  assert.equal((SRC.match(/if \(dismissed\.has\(old\.hash\) && !dismissed\.has\(seg\.hash\)\) \{/g) || []).length, 2, "a dismissed flag stays dismissed after a typo fix");
  assert.equal((SRC.match(/sentencesChecked \+= todo\.length;/g) || []).length, 2);
  assert.equal((SRC.match(/\[tracely\] reused \$\{n\} verdict\(s\) after a small edit/g) || []).length, 2);
});

/* An essay revised over a session: typo fixes, punctuation, a reworded
 * sentence, a changed figure, a new sentence. Count the sentences sent to
 * /api/check with and without reuse, the way cycle() does (a new hash is
 * sent unless its verdict can be inherited). */
test("simulation: fewer sentences sent, and every real change is still checked", () => {
  const drafts = [
    "Sleep improves memory in teenagers. Most students sleep about seven hours a night. Schools that start later report better grades. Caffeine stays in the body for up to six hours.",
  ];
  const edit = (f) => drafts.push(f(drafts[drafts.length - 1]));
  edit((t) => t.replace("teenagers.", "teenagers, according to resaerch."));        // a real change (new words)
  edit((t) => t.replace("resaerch", "research"));                                   // typo
  edit((t) => t.replace("about seven hours", "about 7 hours"));                     // a figure rewritten: re-checked
  edit((t) => t.replace("later report", "later  report"));                          // spacing
  edit((t) => t.replace("better grades.", "better grades!"));                       // punctuation
  edit((t) => t.replace("Caffeine stays", "Caffiene stays"));                       // a typo introduced…
  edit((t) => t.replace("Caffiene stays", "Caffeine stays"));                       // …and fixed
  edit((t) => t + " Naps after lunch improve focus.");                              // a new sentence
  edit((t) => t.replace("improve focus.", "improve focus"));                        // the full stop
  edit((t) => t.replace("better grades!", "better grades."));                       // and back

  const run = (reuse) => {
    const cache = new Map();
    let sent = 0, prev = [], stale = [];
    for (const text of drafts) {
      const segs = X.segmentText(text).filter((s) => s.checkable);
      const live = new Set(segs.map((s) => s.hash));
      const taken = new Set();
      for (const seg of segs) {
        if (cache.has(seg.hash)) continue;
        const old = reuse ? X.inheritedVerdict(seg, prev, live, cache, taken) : null;
        if (old) { cache.set(seg.hash, cache.get(old.hash)); stale.push([old.text, seg.text]); continue; }
        cache.set(seg.hash, { verdict: "checked" });
        sent++;
      }
      prev = segs;
    }
    return { sent, stale };
  };
  const without = run(false), withReuse = run(true);
  console.log(`[verdict reuse sim] sentences sent: ${without.sent} without reuse, ${withReuse.sent} with (${withReuse.stale.length} inherited)`);
  assert.ok(withReuse.sent < without.sent);
  for (const [a, b] of withReuse.stale) {
    assert.ok(!/\d/.test(a + b) || a.match(/\d+/g).join() === b.match(/\d+/g).join(), `a figure changed and was reused: ${a} → ${b}`);
  }
  assert.ok(!withReuse.stale.some(([a]) => /about seven hours/.test(a)), "seven → 7 was re-checked");
});
