/**
 * The citation fields /api/sources asks the model for (lib/citeFields.js).
 *
 * The prompt says "copy only what the page states; empty is correct". These
 * pin what holds when the model does not listen: every value here is one a
 * formatter would otherwise print into a student's reference list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { citeFields, SOURCE_KINDS } from "../lib/citeFields.js";

const NOW = new Date("2026-09-21T12:00:00Z");
const blank = { kind: "other", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" };
const f = (raw, opts = {}) => citeFields({ ...blank, ...raw }, { now: NOW, ...opts });

test("the tester's IOM chapter comes through whole", () => {
  const got = f(
    { kind: "book", groupAuthor: "International Organization for Migration", year: 2024, container: "World Migration Report 2024", editors: ["Marie McAuliffe", "Linda Adhiambo Oucho"] },
    { publisher: "International Organization for Migration", title: "World Migration Report 2024: Chapter 2 – Migration and migrants: A global overview" },
  );
  assert.deepEqual(got, {
    kind: "book",
    authors: [],
    groupAuthor: "International Organization for Migration",
    year: 2024,
    container: "World Migration Report 2024",
    editors: ["Marie McAuliffe", "Linda Adhiambo Oucho"],
  });
});

test("an answer with nothing stated comes back empty, not absent", () => {
  // Empty says "the page names no author": the extension formats it as a
  // no-author work, where an absent field means an older server.
  assert.deepEqual(f({}), { kind: "other", authors: [], groupAuthor: "", year: null });
});

test("a source with none of the fields (a harvested url_citation) gets none", () => {
  assert.deepEqual(citeFields({ title: "A", url: "https://a.org", publisher: "a.org", snippet: "", stance: "context" }), {});
  assert.deepEqual(citeFields(null), {});
  assert.deepEqual(citeFields("nope"), {});
});

test("kind is one of the seven, case-folded, else omitted", () => {
  assert.deepEqual(SOURCE_KINDS, ["institutional", "news", "reference", "journal", "book", "archive", "other"]);
  assert.equal(f({ kind: "Journal" }).kind, "journal");
  assert.equal(f({ kind: "blog" }).kind, undefined);
  assert.equal(f({ kind: 7 }).kind, undefined);
});

test("authors: people only — no hostnames, placeholders, handles, URLs or sentences", () => {
  const got = f({ authors: ["Julia Simon", "npr.org", "Staff", "Unknown", "Editors", "@jsimon", "https://npr.org/people/x", "julia@npr.org", "www.npr.org", "Julia Simon", "  Hugh   Schofield ", "A reporter who covers the climate beat for us"] });
  assert.deepEqual(got.authors, ["Julia Simon", "Hugh Schofield"]);
  assert.equal(got.groupAuthor, "");
});

test("an organisation filed as a person becomes the group author, never 'Migration, I. O. F.'", () => {
  assert.deepEqual(
    [f({ authors: ["World Health Organization"] }).authors, f({ authors: ["World Health Organization"] }).groupAuthor],
    [[], "World Health Organization"],
  );
  assert.equal(f({ authors: ["IOM"], groupAuthor: "International Organization for Migration" }).groupAuthor, "International Organization for Migration", "an explicit group author wins");
  const both = f({ authors: ["Pew Research Center", "Michelle Faverio"] });
  assert.deepEqual([both.authors, both.groupAuthor], [["Michelle Faverio"], ""], "people named, so no group author");
});

test("an author who is really the publisher or the group author is dropped", () => {
  const got = f({ authors: ["NPR", "Julia Simon"], groupAuthor: "" }, { publisher: "NPR" });
  assert.deepEqual(got.authors, ["Julia Simon"]);
  const g = f({ authors: ["Centers for Disease Control and Prevention"], groupAuthor: "Centers for Disease Control and Prevention" });
  assert.deepEqual([g.authors, g.groupAuthor], [[], "Centers for Disease Control and Prevention"]);
});

test("groupAuthor: a hostname or placeholder is not an organisation", () => {
  assert.equal(f({ groupAuthor: "cdc.gov" }).groupAuthor, "");
  assert.equal(f({ groupAuthor: "Staff" }).groupAuthor, "");
  assert.equal(f({ groupAuthor: "CDC" }).groupAuthor, "CDC");
  assert.equal(f({ authors: ["Julia Simon"], groupAuthor: "NPR" }).groupAuthor, "", "a person is named");
});

test("year: an integer from 1500 to this year, else null", () => {
  assert.equal(f({ year: 2024 }).year, 2024);
  assert.equal(f({ year: "2024" }).year, 2024, "a digit string is read");
  assert.equal(f({ year: 1499 }).year, null);
  assert.equal(f({ year: 2027 }).year, null, "not the future");
  assert.equal(f({ year: 2024.5 }).year, null);
  assert.equal(f({ year: "circa 2020" }).year, null);
});

test("date: a real calendar day, not in the future, sets the year", () => {
  assert.deepEqual([f({ date: "2020-04-09" }).date, f({ date: "2020-04-09" }).year], ["2020-04-09", 2020]);
  assert.equal(f({ date: "2023-02-29" }).date, undefined, "no 29 February in 2023");
  assert.equal(f({ date: "2024-02-29" }).date, "2024-02-29");
  assert.equal(f({ date: "2026-09-30" }).date, undefined, "the future");
  assert.equal(f({ date: "2026-09-22" }).date, "2026-09-22", "tomorrow somewhere east is fine");
  assert.equal(f({ date: "April 9, 2020" }).date, undefined, "only YYYY-MM-DD");
  const bad = f({ date: "2023-02-29", year: 2023 });
  assert.deepEqual([bad.date, bad.year], [undefined, 2023], "an impossible date leaves a good year standing");
});

test("a year and a date that disagree drop both: one of them is a guess", () => {
  const got = f({ year: 2021, date: "2020-04-09" });
  assert.equal(got.date, undefined);
  assert.equal(got.year, null);
  assert.equal(f({ year: 2020, date: "2020-04-09" }).year, 2020);
});

test("a year the title contradicts is dropped (the page's CMS date copied as a publication year)", () => {
  const title = "World Migration Report 2024: Chapter 2";
  assert.equal(f({ year: 2020 }, { title }).year, null);
  assert.equal(f({ date: "2020-05-21" }, { title }).date, undefined);
  assert.equal(f({ year: 2024 }, { title }).year, 2024);
  assert.equal(f({ year: 2021 }, { title: "Vision 2030" }).year, 2021, "a future target year proves nothing");
});

test("doi: the 10.x/ pattern, resolver prefixes removed", () => {
  assert.equal(f({ doi: "10.1038/s41586-020-2649-2" }).doi, "10.1038/s41586-020-2649-2");
  assert.equal(f({ doi: "https://doi.org/10.1038/s41586-020-2649-2" }).doi, "10.1038/s41586-020-2649-2");
  assert.equal(f({ doi: "doi: 10.1000/xyz123" }).doi, "10.1000/xyz123");
  assert.equal(f({ doi: "10.12/short" }).doi, undefined, "a registrant code has 4-9 digits");
  assert.equal(f({ doi: "n/a" }).doi, undefined);
});

test("container is the larger work, never the publisher or the title restated; editors need it", () => {
  assert.equal(f({ container: "Nature" }, { publisher: "Nature" }).container, undefined);
  assert.equal(f({ container: "Some Title" }, { title: "Some title" }).container, undefined);
  assert.equal(f({ container: "Nature" }, { publisher: "Springer Nature" }).container, "Nature");
  assert.equal(f({ editors: ["Marie McAuliffe"] }).editors, undefined, "editors of nothing");
  assert.deepEqual(f({ container: "World Migration Report 2024", editors: ["Marie McAuliffe", "Editors", "iom.int", "IOM", "Marie McAuliffe"] }).editors, ["Marie McAuliffe"]);
});
