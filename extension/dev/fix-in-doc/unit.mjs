// Unit tests for engine.js's pure planner: normMap / matchText / planEdit.
// Simulates Docs applying the planned paste to the raw model text (including
// Docs' "leading/trailing spaces of a paste are dropped" behaviour) and the
// reverse paste used by semantic undo, and checks both round-trip.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const win = { __tracelyEditExpose: true, addEventListener() {}, postMessage() {} };
const ctx = vm.createContext({ window: win, navigator: { platform: "MacIntel" }, document: {}, performance, setTimeout, console });
vm.runInContext(fs.readFileSync(path.join(DIR, "engine.js"), "utf8"), ctx);
const E = win.__tracelyEditInternals;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra ?? ""); } };
const docPaste = (s) => s.replace(/^ +| +$/g, ""); // measured Docs behaviour for plain pastes

function run(name, T, find, replacement, expectInsert) {
  const mt = E.matchText(T, find);
  if (mt.hits.length !== 1) { ok(name + " match", false, "hits=" + mt.hits.length); return; }
  const m = mt.hits[0];
  const loc = { map: mt.map, m, needle: mt.needle };
  const p = E.planEdit(T, loc, replacement, false);
  if (p.noop) { ok(name + " noop", E.normMap(replacement).n === mt.needle); return; }
  ok(name + " insert has no edge space", !/^\s|\s$/.test(p.insert), JSON.stringify(p.insert));
  ok(name + " removed has no edge space", !/^\s|\s$/.test(p.removedRaw), JSON.stringify(p.removedRaw));
  ok(name + " selection verifies", E.normMap(T.slice(p.s, p.e)).n.trim() === p.oldN.slice(p.oa, p.ob).trim());
  const T2 = T.slice(0, p.s) + docPaste(p.insert) + T.slice(p.e);
  const rawS = mt.map[m], rawE = mt.map[m + mt.needle.length - 1] + 1;
  const expected = T.slice(0, rawS) + replacement + T.slice(rawE);
  ok(name + " forward", E.normMap(T2).n === E.normMap(expected).n, `\n   got ${JSON.stringify(T2)}\n  want ${JSON.stringify(expected)}`);
  if (expectInsert !== undefined) ok(name + " minimal", p.insert === expectInsert, `insert=${JSON.stringify(p.insert)} remove=${JSON.stringify(p.removedRaw)}`);
  // reverse (semantic undo): select the inserted text in T2, paste removedRaw
  const ins = docPaste(p.insert);
  const T3 = T2.slice(0, p.s) + docPaste(p.removedRaw) + T2.slice(p.s + ins.length);
  ok(name + " reverse", E.normMap(T3).n === E.normMap(T).n, `\n   got ${JSON.stringify(T3)}\n  want ${JSON.stringify(T)}`);
  return p;
}

const DOC = "\u0003The film stars Tom Cruise. Maverick's return as coach is an order from his friend, Admiral Tom \"Iceman\" Kazansky. However, Rooster still holds a grudge and blames Maverick for his father's death. This film contains the values \u200b\u200bof friendship, competition, and courage. The story is really good. The music is really good which is recommended.\n\n\u0003\n";

run("word swap", DOC, "The film stars Tom Cruise.", "The film stars Tom Cruise and Miles Teller.", "Cruise and Miles Teller");
run("cite marker", DOC, "The film stars Tom Cruise.", "The film stars Tom Cruise [1].", "Cruise [1]");
run("mid change", DOC, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster still blames Maverick for the death of his father, Goose.");
run("delete words", DOC, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster blames Maverick for his father's death.");
run("delete word before ws", DOC, "The story is really good.", "The story is good.");
run("insert words", DOC, "The story is really good.", "The story is really very good.");
run("smart-quote find", DOC, "Maverick’s return as coach is an order from his friend, Admiral Tom “Iceman” Kazansky.", "Maverick’s return as coach is an order from his friend, Admiral Tom “Iceman” Kazansky — his old rival.");
run("smart-quote kept from doc", DOC, "Maverick's return as coach is an order from his friend, Admiral Tom \"Iceman\" Kazansky.", "Maverick’s return as coach is a favour from his friend, Admiral Tom “Iceman” Kazansky.", "a favour");
run("zwsp find", DOC, "This film contains the values of friendship, competition, and courage.", "This film contains the values of friendship, rivalry, and courage.", "rivalry");
run("zwsp inside diff", DOC, "This film contains the values of friendship, competition, and courage.", "This film celebrates friendship, competition, and courage.");
run("insertAfter-like", DOC, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster still holds a grudge and blames Maverick for his father's death. (Top Gun: Maverick, 2022)", ". (Top Gun: Maverick, 2022)");
run("em dash + ellipsis", "\u0003He waited… then left — fast.\n\u0003\n", "He waited... then left - fast.", "He waited… then left — very fast.", "very fast");
run("ellipsis edge", "\u0003Wait.\n\u0003\n", "Wait.", "Wait…");
run("whole rewrite", DOC, "The film stars Tom Cruise.", "Tom Cruise leads the cast.");
run("noop", DOC, "The film stars Tom Cruise.", "The film stars Tom Cruise.");
run("list marker", "\u0003Einstein was a basketball player.\n\u0003\n", "* Einstein was a basketball player.", "Einstein was a physicist.");

// matching rules
ok("ambiguous", E.matchText(DOC, "is really good").hits.length === 2);
ok("no mid-word", E.matchText(DOC, "tars Tom Cruise.").hits.length === 0);
ok("no cross-paragraph", E.matchText("\u0003One two.\nThree four.\n\u0003\n", "two. Three").hits.length === 0);
ok("nbsp/ws collapse", E.matchText("\u0003A\u00a0 b  c.\n\u0003\n", "A b c.").hits.length === 1);
ok("case-sensitive", E.matchText(DOC, "the film stars tom cruise.").hits.length === 0);
const nm = E.normMap("\u0003a…b");
ok("normMap map", nm.n === "\na...b" && nm.map.join() === "0,1,2,2,2,3", JSON.stringify(nm));

console.log(`unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
