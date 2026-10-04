/* When the extension pays for another /api/review (content.js
 * reviewWorthwhile, requestReview). Cost idea 1, owner 2026-10-04: the first
 * gate re-reviewed a resume on ANY change once it had been still 5 s and a
 * minute had passed, so a typo fix bought a whole review (~0.1-0.3¢; Free
 * allows 30 a day). Now: only a new or rewritten line, and 3 minutes after an
 * answer. The simulation replays one editing session through both gates. */
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
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
    ${SRC.slice(a, b)}
    ({ reviewWorthwhile, nearlySame, REVIEW_IDLE_MS, REVIEW_FLOOR_MS, REVIEW_REPEAT_MS })`, vm.createContext({}));
}
const X = load();

const BASE = [
  "Jordan Rivera", "jordan.rivera@outlook.com", "EXPERIENCE", "Harbor Cafe", "Barista",
  "Served customers during the morning rush and kept the espresso station stocked.",
  "Trained four new baristas on the espresso machine.",
  "SKILLS", "Customer service, Spanish",
].join("\n");

test("the first review always goes; after that, only a new or rewritten line counts", () => {
  assert.equal(X.reviewWorthwhile(null, BASE), true, "nothing reviewed yet");
  assert.equal(X.reviewWorthwhile(BASE, BASE), false, "unchanged");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("baristas", "barristas")), false, "a typo");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("four new", "five new")), false, "four → five is 3 letters: a detail the review does not judge (it reviews wording, not facts)");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("Trained four new", "Mentored four new")), true, "a verb rewritten");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("Served customers", "Served  customers")), false, "whitespace");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("Trained four new baristas on the espresso machine.\n", "")), false, "a deleted line: its tips drop out locally");
  assert.equal(X.reviewWorthwhile(BASE, BASE + "\nOrganised the weekly staff rota for eight employees."), true, "a new bullet");
  assert.equal(X.reviewWorthwhile(BASE, BASE.replace("Served customers during the morning rush and kept the espresso station stocked.", "Cut morning wait times by running the espresso station during the rush.")), true, "a bullet rewritten");
});

test("nearlySame is a bounded edit distance", () => {
  assert.equal(X.nearlySame("barista", "barrista", 3), true);
  assert.equal(X.nearlySame("abc", "abcdefg", 3), false, "length alone rules it out");
  assert.equal(X.nearlySame("served customers", "trained employees", 3), false);
});

test("the floors: 5 s still, 1 minute between tries, 3 minutes after an answer", () => {
  assert.equal(X.REVIEW_IDLE_MS, 5_000);
  assert.equal(X.REVIEW_FLOOR_MS, 60_000);
  assert.equal(X.REVIEW_REPEAT_MS, 180_000);
  assert.equal((SRC.match(/if \(!reviewWorthwhile\(review\.lastText, text\) \|\| Date\.now\(\) - lastTextChangeAt < REVIEW_IDLE_MS \|\| Date\.now\(\) - review\.at < REVIEW_FLOOR_MS \|\| Date\.now\(\) - review\.okAt < REVIEW_REPEAT_MS\) return;/g) || []).length, 2, "Docs and field mode");
  assert.equal((SRC.match(/review\.lastText = text;\n\s+review\.okAt = Date\.now\(\);/g) || []).length, 2, "only an ANSWER moves the 3-minute floor");
});

/* A 30-minute session, one second at a time: write a bullet, pause, fix a
 * couple of typos, pause, delete a weak line, rewrite another, add two more
 * bullets, with pauses of 6-40 s between. The old gate: any change, still
 * 5 s, 60 s apart. The new one: reviewWorthwhile, still 5 s, 60 s apart,
 * 180 s after an answer. Both must still review the finished resume. */
function session() {
  const steps = [];
  let text = BASE;
  const at = (t, next) => { steps.push([t, next]); text = next; };
  let t = 0;
  const pause = (s) => { t += s; };
  const edit = (f) => { t += 3; at(t, f(text)); };
  pause(20);
  edit((x) => x + "\nOrganised the weekly staff rota for eight employes."); pause(30);
  edit((x) => x.replace("employes", "employees")); pause(8);
  edit((x) => x.replace("Spanish", "Spanish, Excel")); pause(40);
  edit((x) => x.replace("Customer service", "Customer servise")); pause(6);
  edit((x) => x.replace("servise", "service")); pause(30);
  edit((x) => x.replace("Trained four new baristas on the espresso machine.\n", "")); pause(25);
  edit((x) => x.replace("Served customers during the morning rush and kept the espresso station stocked.", "Cut morning wait times by running the espresso station during the rush.")); pause(35);
  for (let i = 0; i < 6; i++) { edit((x) => x.replace("rush.", i % 2 ? "rush." : "rush!")); pause(12); } // fiddling with punctuation
  edit((x) => x + "\nHandled opening and closing cash counts without a discrepancy."); pause(40);
  edit((x) => x + "\nWelcomed regulars by name and remembered their usual orders."); pause(300);
  return { steps, end: t, final: text };
}

function simulate(gate) {
  const { steps, end, final } = session();
  let text = BASE, changeAt = 0, at = -1e9, okAt = -1e9, lastText = null, reviews = 0, reviewedText = null;
  for (let s = 0, i = 0; s <= end + 400; s++) {
    while (i < steps.length && steps[i][0] <= s) { text = steps[i][1]; changeAt = steps[i][0]; i++; }
    const still = (s - changeAt) * 1000 >= X.REVIEW_IDLE_MS;
    const go = gate === "old"
      ? text !== lastText && still && (s - at) * 1000 >= 60_000
      : X.reviewWorthwhile(lastText, text) && still && (s - at) * 1000 >= X.REVIEW_FLOOR_MS && (s - okAt) * 1000 >= X.REVIEW_REPEAT_MS;
    if (go) { reviews++; at = okAt = s; lastText = text; reviewedText = text; }
  }
  return { reviews, coversFinal: X.reviewWorthwhile(reviewedText, final) === false };
}

test("simulation: fewer reviews over an editing session, and the finished resume is still reviewed", () => {
  const old = simulate("old"), now = simulate("new");
  console.log(`[review gate sim] old ${JSON.stringify(old)}  new ${JSON.stringify(now)}`);
  assert.ok(old.coversFinal && now.coversFinal, "both end with the final resume's lines reviewed");
  assert.ok(now.reviews < old.reviews, `reviews ${now.reviews}, was ${old.reviews}`);
});
