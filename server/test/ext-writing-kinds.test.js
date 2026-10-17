/* 56 kinds of writing (content.js readKind, WRITING_KINDS). Owner,
 * 2026-10-15: "yes fix the detection, but not only for this. Fix it for a
 * plethora of writing, so it is very unlikely that tracely will detect
 * something wrong. Before incorporating, list all things that could be
 * labeled." The owner approved the list: 23 kinds already named and 33 new,
 * in five groups by what they change (each kind's genre), and three moves:
 * a blog post and an op-ed (a letter to the editor too) name their sources
 * in the sentence with no Works Cited, and a reference list on its own is
 * never asked where each entry is cited.
 *
 * Corpora, every document invented except the owner's own lab draft:
 *   fixtures/writing-kinds-tuned.js — 313 documents, five or more of every
 *     kind plus look-alikes, by eight writers who never saw the detector. The
 *     rules were tuned on these.
 *   fixtures/writing-kinds-blind.js — 312 more by eight other writers, scored
 *     blind once (75.0% exact, 13.1% in the wrong group; main: 37.2% in the
 *     wrong group), then read for general fixes, so no longer blind.
 *   fixtures/writing-kinds-fresh.js — 312 more by eight new writers, written
 *     after those fixes and scored once: 72.1% exact, 13.5% in the wrong group
 *     (5 checked documents read as quiet), the header wrong on 13.8%; main:
 *     37.5% in the wrong group, 12 read as quiet. Keep it untuned: it is the
 *     honest number.
 *
 * "Wrong group" is the miss that changes what is checked (a story read as an
 * essay); "the header" is what the chip names: a kind only when very sure
 * (KIND_SURE, owner 2026-10-15), else nothing. That cut-off was chosen on
 * the first two corpora, before the fresh one was written; on the fresh one
 * it took the header from wrong on 13.8% of documents to 3.2%, naming
 * nothing on 43%. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { WRITING_KINDS_TUNED } from "./fixtures/writing-kinds-tuned.js";
import { WRITING_KINDS_BLIND } from "./fixtures/writing-kinds-blind.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const FRESH = path.join(HERE, "fixtures", "writing-kinds-fresh.js");
const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ detectGenre, readKind, WRITING_KINDS, genreNote, isArgumentGenre, genreWantsList, flagShown, GENRE_QUIET })`, vm.createContext({}));
const K = X.WRITING_KINDS;

// What a genre changes: 1 checked with a list, 2 named in the sentence, 3 its own documents, 4 the writer's own account, 5 quiet.
const GROUP = (g) => ({ prose: 1, research: 1, literary: 1, lab: 1, speech: 2, news: 2, dbq: 3, homework: 5, poem: 5, story: 5, script: 5 }[g] ?? 4);
const essayish = (k) => ["prose", "literary", "research"].includes(K[k].genre);
function score(docs) {
  const r = { n: docs.length, exact: 0, broader: 0, sameGroup: 0, wrongGroup: 0, toQuiet: 0, chipWrong: 0, chipShown: 0, misses: [] };
  for (const d of docs) {
    const { kind, shown } = X.readKind(d.text, d.place ?? "");
    if (kind === d.kind) r.exact++;
    else if (K[d.kind].parent === kind) r.broader++;
    else if (GROUP(K[kind].genre) === GROUP(K[d.kind].genre)) r.sameGroup++;
    else {
      r.wrongGroup++;
      r.misses.push(`${d.kind} → ${kind}: ${d.name}`);
      if (GROUP(K[kind].genre) === 5) r.toQuiet++;
    }
    if (shown) r.chipShown++;
    if (shown && shown !== d.kind && K[d.kind].parent !== shown && !(shown === "essay" && essayish(d.kind))) r.chipWrong++;
  }
  return r;
}
const pct = (x, n) => (100 * x) / n;

test("every kind has five or more documents in each corpus", () => {
  for (const docs of [WRITING_KINDS_TUNED, WRITING_KINDS_BLIND]) {
    for (const k of Object.keys(K)) assert.ok(docs.filter((d) => d.kind === k).length >= 5, k);
    for (const d of docs) assert.ok(K[d.kind], `${d.kind}: ${d.name}`);
  }
});

test("the tuned corpus: 85% named exactly, at most 4% in the wrong group, the header wrong at most 1% and naming 60% or more", () => {
  const r = score(WRITING_KINDS_TUNED);
  assert.ok(pct(r.exact, r.n) >= 85, `${r.exact}/${r.n} exact`);
  assert.ok(pct(r.wrongGroup, r.n) <= 4, `${r.wrongGroup}/${r.n} in the wrong group:\n${r.misses.join("\n")}`);
  assert.ok(pct(r.chipWrong, r.n) <= 1, `the header wrong on ${r.chipWrong}/${r.n}`);
  assert.ok(pct(r.chipShown, r.n) >= 60, `the header names ${r.chipShown}/${r.n}`);
  assert.ok(r.toQuiet <= 1, `${r.toQuiet} checked documents read as quiet`);
});

test("the once-blind corpus: 79% named exactly, at most 9% in the wrong group, the header wrong at most 2% and naming 60% or more", () => {
  const r = score(WRITING_KINDS_BLIND);
  assert.ok(pct(r.exact, r.n) >= 79, `${r.exact}/${r.n} exact`);
  assert.ok(pct(r.wrongGroup, r.n) <= 9, `${r.wrongGroup}/${r.n} in the wrong group:\n${r.misses.join("\n")}`);
  assert.ok(pct(r.chipWrong, r.n) <= 2, `the header wrong on ${r.chipWrong}/${r.n}`);
  assert.ok(pct(r.chipShown, r.n) >= 60, `the header names ${r.chipShown}/${r.n}`);
  assert.ok(r.toQuiet <= 1, `${r.toQuiet} checked documents read as quiet`);
});

test("the fresh corpus, scored once and left untuned: at most 14% in the wrong group, the header wrong at most 4%", { skip: !existsSync(FRESH) && "no fresh corpus" }, async () => {
  const docs = Object.values(await import(pathToFileURL(FRESH)))[0];
  assert.ok(docs.length >= 300);
  const r = score(docs);
  // The honest number (ext-writing-kinds.test.js header). A change that lowers it is a regression on writing it was never tuned on.
  assert.ok(pct(r.wrongGroup, r.n) <= FRESH_BAR.wrongGroup, `${r.wrongGroup}/${r.n} in the wrong group:\n${r.misses.join("\n")}`);
  assert.ok(pct(r.chipWrong, r.n) <= FRESH_BAR.chipWrong, `the header wrong on ${r.chipWrong}/${r.n}`);
  assert.ok(r.toQuiet <= FRESH_BAR.toQuiet, `${r.toQuiet} checked documents read as quiet`);
});
const FRESH_BAR = { wrongGroup: 14, chipWrong: 4, toQuiet: 5 }; // its one scoring, 2026-10-15: 13.5%, 5 read as quiet; the header 13.8%, then 3.2% naming only what it is sure of

test("the three moves the owner approved: a blog post and an op-ed name their sources; a reference list alone is not asked to be cited", () => {
  assert.equal(K.blog.genre, "news");
  assert.equal(K.oped.genre, "news");
  assert.equal(K.workscited.genre, "annotated");
  for (const k of ["blog", "oped"]) assert.equal(X.genreWantsList(K[k].genre), false, `${k}: no Works Cited`);
  assert.equal(X.isArgumentGenre("annotated"), false, "a reference list alone: no citation or reference-list notes");
  const editor = "To the Editor:\n\nThe council's plan to close the Elm Street pool every Monday is a mistake. Families use it most on Mondays.\n\nRuth Ellison\nWestfield";
  assert.equal(X.readKind(editor).kind, "oped");
  const blog = "Hi everyone, welcome back to the blog!\n\nToday I want to share three things I learned from my first year of backyard chickens.\n\nFirst, they are louder than you think.";
  assert.equal(X.readKind(blog).kind, "blog");
  const list = "Works Cited\n\nHale, Lauren, and Stijn Guan. \"Screen Time and Sleep.\" Sleep Medicine Reviews, vol. 21, 2015, pp. 50-58.\nOwens, Judith. \"Insufficient Sleep in Adolescents.\" Pediatrics, vol. 134, no. 3, 2014.\nWalker, Matthew. Why We Sleep. Scribner, 2017.";
  assert.deepEqual({ ...X.readKind(list) }, { kind: "workscited", shown: "workscited" });
});

test("in a field, the site counts: mail is an email, a class board a discussion post, a social site a post", () => {
  const short = "Thanks for the notes from Tuesday. I will bring the permission slip tomorrow and finish the reading by Friday.";
  assert.equal(X.readKind(short, "mail.google.com/mail/u/0/").kind, "email");
  assert.equal(X.readKind(short, "canvas.instructure.com/courses/4821/discussion_topics/99012").kind, "discussion");
  assert.equal(X.readKind(short, "x.com/compose/post").kind, "social");
  assert.equal(X.readKind(short, "www.goodreads.com/review/edit/3312").kind, "review");
  assert.equal(X.readKind(short, "www.linkedin.com/in/me/edit/about/").kind, "bio");
  assert.equal(X.readKind(short, "www.valleyherald.com/opinion/letters/submit").kind, "oped");
  assert.equal(X.readKind(short).kind, "essay", "no place: the text alone");
  const cover = "Dear Hiring Manager,\n\nI am applying for the summer intern position at Brightline Analytics. Last year I built a budgeting app that 2,000 students use, and I would welcome an interview.\n\nSincerely,\nPriya Shah";
  assert.equal(X.readKind(cover, "mail.google.com/mail/u/0/").kind, "coverletter", "a cover letter sent by mail is still a cover letter");
  assert.equal(X.readKind("a".repeat(10) + " word".repeat(700), "x.com/home").kind === "social", false, "a long text on a social site is not a post");
});

test("the owner's spring-scale draft is a lab report: every sentence says 'we will', and its measurements are a lab's data", () => {
  const triad = WRITING_KINDS_TUNED.find((d) => /spring-scale draft/.test(d.name));
  assert.ok(triad);
  assert.equal(X.readKind(triad.text).kind, "lab");
  assert.equal(X.detectGenre(triad.text), "lab");
  assert.match(triad.text, /23 cm for 2\.9 newtons/);
});

test("what each new kind says about its citations, and the quiet ones stay quiet", () => {
  assert.match(X.genreNote("dbq", "", "mla", "synthesis"), /Reading this as a synthesis essay — cite the sources by letter, like \(Source A\)/);
  assert.match(X.genreNote("news", "", "mla", "blog"), /Reading this as a blog post — name or link each source in the sentence; a blog post has no Works Cited/);
  assert.match(X.genreNote("news", "", "mla", "oped"), /Reading this as an op-ed — name each source in the sentence/);
  assert.match(X.genreNote("annotated", "", "mla", "workscited"), /Reading this as a reference list on its own — Tracely won't ask where each entry is cited/);
  assert.match(X.genreNote("speech", "", "mla", "debate"), /Reading this as a debate case — name each source as you say it/);
  assert.match(X.genreNote("prose", "", "apa", "rhetorical"), /Reading this as a rhetorical analysis — quote the text you're analyzing and list it in your References/);
  assert.equal(X.genreNote("prose", "", "mla", "argumentative"), "", "an essay of its own kind says nothing more");
  assert.equal(X.genreNote("prose", "", "mla", "email"), "", "a kind of another genre is not this genre's note");
  assert.match(X.genreNote("homework", "", "mla", "code"), /This looks like code\. Tracely checks writing, so it is staying quiet here\./);
  assert.match(X.genreNote("homework", "", "mla", "math"), /This looks like math work/);
  assert.match(X.genreNote("homework", "", "mla", "survey"), /This reads as a survey/);
  assert.match(X.genreNote("poem", "", "mla", "lyrics"), /This reads as song lyrics/);
  assert.match(X.genreNote("homework"), /This looks like homework questions/, "the old line without a kind");
  for (const k of Object.keys(K).filter((k) => X.GENRE_QUIET.has(K[k].genre))) {
    assert.equal(X.flagShown({ verdict: "false" }, {}, K[k].genre, "The Moon is made of cheese."), false, `${k}: nothing flagged`);
  }
});

test("shapes that are nothing else win over a word in the title", () => {
  const worksheet = "Lab 4: Motion graphs\n1. Calculate the slope of the position vs time graph between 0 s and 4 s.\n2. What is the velocity of the cart at t = 3 s?\n3. Determine the net area under the velocity vs time curve.\n4. How does the area under the curve compare to the displacement?";
  assert.equal(X.readKind(worksheet).kind, "homework", "a worksheet called Lab 4");
  const lesson = "Grade 7 ELA – Personal Narrative Unit, Lesson 4\nObjective\nStudents will identify four types of narrative hooks and draft two openings.\nStandard: CCSS.ELA-LITERACY.W.7.3.A\nMaterials\nMentor text packet\nWarm-up (5 min)\nGuided practice (15 min)\nExit ticket";
  assert.equal(X.readKind(lesson).kind, "lessonplan", "a lesson about personal narratives is a lesson plan");
  const request = "Subject: Request for a letter of recommendation\n\nDear Professor Lindqvist,\n\nWould you be willing to write a letter of recommendation for me? The program is due January 15.\n\nBest regards,\nAisha";
  assert.equal(X.readKind(request).kind, "email", "asking for a reference is an email");
  const grandpa = "Grandpa —\n\nCollege is good. My roommate puts ranch on everything.\n\nThe dorm is loud but I have stopped noticing.\n\nLove you lots,\nEllie";
  assert.equal(X.readKind(grandpa).kind, "letter", "a letter that opens on a name alone");
});

/* The model's kind (askKind → POST /api/kind, server/lib/kind.js), behind
 * FEATURES.modelKind until it is measured. With the switch on: a kind it
 * names is used; "unsure", a failure and an older server leave the rules. */
const ON = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  const FEATURES = { citeHintsToggle: false, modelKind: true };
  function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ readKind, kindWithModel, askKind, kindExcerptOf, resetKindAsk: () => { kindAsked = { print: "", head: "", kind: "", at: 0, inflight: false, off: false }; } })`, vm.createContext({}));
const ESSAYISH = "Every summer my town floods a little more, and the council keeps saying it will study the problem. ".repeat(6);

test("the model's kind: used when it names one, the rules when it is unsure, fails or the server is older", async () => {
  const asked = [];
  const answer = (kind) => async (path, body) => { asked.push([path, body.text.length]); return { kind }; };
  ON.resetKindAsk();
  let rendered = 0;
  await ON.askKind(ESSAYISH, "", answer("oped"), () => rendered++);
  assert.deepEqual(asked, [["/api/kind", ESSAYISH.length]]);
  assert.equal(rendered, 1, "the panel is drawn again with the answer");
  assert.deepEqual({ ...ON.kindWithModel(ON.readKind(ESSAYISH), ESSAYISH) }, { kind: "oped", shown: "oped" });
  await ON.askKind(ESSAYISH, "", answer("lab"));
  assert.equal(asked.length, 1, "the same document is not asked again");
  assert.notEqual(ON.kindWithModel(ON.readKind("Another document entirely."), "Another document entirely.").kind, "oped", "another text keeps its own rules");

  ON.resetKindAsk();
  await ON.askKind(ESSAYISH, "", answer("unsure"));
  assert.deepEqual({ ...ON.kindWithModel(ON.readKind(ESSAYISH), ESSAYISH) }, { ...ON.readKind(ESSAYISH) }, "unsure: the rules");
  ON.resetKindAsk();
  await ON.askKind(ESSAYISH, "", answer("Op-ed"));
  assert.deepEqual({ ...ON.kindWithModel(ON.readKind(ESSAYISH), ESSAYISH) }, { ...ON.readKind(ESSAYISH) }, "not a kind: the rules");

  ON.resetKindAsk();
  let calls = 0;
  const older = async () => { calls++; throw Object.assign(new Error("Not found"), { kind: "not_found" }); };
  await ON.askKind(ESSAYISH, "", older);
  ON.resetKindAsk;
  await ON.askKind(ESSAYISH + " More.", "", older);
  assert.equal(calls, 1, "an older server is never asked again");

  ON.resetKindAsk();
  const none = async () => { throw new Error("should not be asked"); };
  await ON.askKind("Too short to ask about.", "", none);
  await ON.askKind(ESSAYISH, "mail.google.com/mail/u/0/", none);
  assert.deepEqual({ ...X.readKind(ESSAYISH) }, { ...ON.readKind(ESSAYISH) }, "the switch changes nothing until an answer comes");
});

test("the model's kind: off by default, and only the start and end of the document are sent", async () => {
  assert.match(SRC, /modelKind: false, {5}\/\/ the model names the kind of writing/);
  const { kindExcerpt } = await import("../lib/kind.js");
  for (const t of ["short", "x".repeat(4_000), `HEAD ${"y".repeat(9_000)} TAIL`]) assert.equal(ON.kindExcerptOf(t), kindExcerpt(t), "the same excerpt on both sides");
  // Both modes read with it, and ask after the read.
  assert.equal((SRC.match(/\(\{ kind: docKind, shown: docShown \} = kindWithUsual\(kindWithModel\(readKind\((?:docText|fieldText, location\.hostname \+ location\.pathname)\), (?:docText|fieldText)\)(?:, location\.hostname \+ location\.pathname)?\)\);/g) || []).length, 2);
  assert.equal((SRC.match(/askKind\((?:docText, ""|fieldText, location\.hostname \+ location\.pathname), api, \(\) => \{ read(?:Doc|Field)Kind\(\); render\(\); \}\);/g) || []).length, 2);
});
