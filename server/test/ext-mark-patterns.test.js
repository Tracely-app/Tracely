/* Never colour alone (CLAUDE.md "UI decisions"): every underline the
 * extension draws says what it means with its LINE as well as its colour —
 * solid for wrong, dashed for worth checking, double for a missing citation —
 * and the panel carries the one legend. Amber #ffb800 is 1.73:1 on white, and
 * red and orange are close under tritanopia; before this, colour was the only
 * difference between the three. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

/* A document just big enough for svgMarkFill: ids, children, attributes. */
function fakeDocument() {
  const byId = new Map();
  const node = (tag) => {
    const n = {
      tag, attrs: {}, children: [], style: {}, _id: "",
      get id() { return this._id; }, set id(v) { this._id = v; byId.set(v, this); },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); if (c._id) byId.set(c._id, c); return c; },
    };
    return n;
  };
  const body = node("body");
  return { body, documentElement: body, created: [], getElementById: (id) => byId.get(id) ?? null,
    createElementNS(_ns, tag) { const n = node(tag); this.created.push(n); return n; } };
}

function load(document = fakeDocument()) {
  const a = SRC.indexOf("  const MARK_PATTERN =");
  const b = SRC.indexOf("  const MARK_LINE_RADIUS", a);
  assert.ok(a > 0 && b > a, "content.js: the mark-pattern block moved");
  const colors = SRC.match(/const MARK_COLORS = (\{[^}]*\});/)[1];
  const code = `
    const MARK_COLORS = ${colors};
    const MARK_LINE_HEIGHT = 2, MARK_LINE_HEIGHT_HOVERED = 3;
    ${SRC.slice(a, b)}
    ({ MARK_COLORS, MARK_PATTERN, markFill, markLineHeight, svgMarkFill, legendHtml, LEGEND })`;
  return { ...vm.runInContext(code, vm.createContext({ document })), document };
}

test("each finding colour has its own line, and none is the 'still checking' dotted line", () => {
  const { MARK_COLORS, MARK_PATTERN } = load();
  const byColor = new Map();
  for (const [verdict, color] of Object.entries(MARK_COLORS)) {
    const p = MARK_PATTERN[verdict];
    assert.ok(["solid", "dashed", "double"].includes(p), `${verdict} has a line pattern (${p})`);
    // One vocabulary: verdicts that share a colour share a line.
    if (byColor.has(color)) assert.equal(byColor.get(color), p, `${verdict} draws ${color} like the others`);
    byColor.set(color, p);
  }
  const lines = [...byColor.values()];
  assert.equal(new Set(lines).size, lines.length, `three colours, three lines: ${JSON.stringify(Object.fromEntries(byColor))}`);
  assert.equal(MARK_PATTERN.false, "solid", "wrong keeps the plain line it always had");
});

test("the div line: a solid colour, a dashed gradient, a double rule tall enough to read as two", () => {
  const { markFill, markLineHeight } = load();
  assert.equal(markFill("#d93636", "solid"), "#d93636");
  assert.match(markFill("#ff5900", "dashed"), /^repeating-linear-gradient\(90deg, #ff5900 0 6px, transparent 6px 9px\)$/);
  assert.match(markFill("#ffb800", "double"), /linear-gradient\(to bottom, #ffb800 0 1px, transparent 1px calc\(100% - 1px\), #ffb800/);
  assert.ok(markLineHeight("double", false) >= 3, "two 1px strokes and a gap need 3px");
  assert.ok(markLineHeight("double", true) > markLineHeight("double", false), "and it still thickens on hover");
  assert.equal(markLineHeight("solid", false), 2);
  assert.equal(markLineHeight("solid", true), 3);
});

test("the in-Docs SVG bar: a pattern fill defined once, in our own hidden SVG", () => {
  const { svgMarkFill, document } = load();
  assert.equal(svgMarkFill("#d93636", "solid"), "#d93636", "solid stays a plain fill");
  const dashed = svgMarkFill("#ff5900", "dashed");
  assert.equal(dashed, "url(#tracely-mark-dashed-ff5900)");
  assert.equal(svgMarkFill("#ff5900", "dashed"), dashed);
  assert.equal(svgMarkFill("#ffb800", "double"), "url(#tracely-mark-double-ffb800)");
  const patterns = document.created.filter((n) => n.tag === "pattern");
  assert.equal(patterns.length, 2, "one <pattern> per line and colour, however many bars use it");
  assert.equal(document.created.filter((n) => n.tag === "svg").length, 1, "one hidden SVG holds them");
  const dash = document.getElementById("tracely-mark-dashed-ff5900");
  assert.equal(dash.attrs.patternUnits, "userSpaceOnUse", "dashes keep their length however long the bar is");
  const dbl = document.getElementById("tracely-mark-double-ffb800");
  assert.equal(dbl.children.length, 2, "two strokes");
});

test("one legend names every line, in the cards' words", () => {
  const { legendHtml, markFill, MARK_COLORS, MARK_PATTERN } = load();
  const html = legendHtml();
  assert.equal((html.match(/class="legend-item"/g) || []).length, 3);
  for (const label of ["Contradicted or doesn't make sense", "Worth checking", "Missing or incomplete citation"]) assert.ok(html.includes(label), label);
  for (const v of ["false", "questionable", "needs_citation"]) {
    assert.ok(html.includes(markFill(MARK_COLORS[v], MARK_PATTERN[v])), `the legend draws ${v}'s line exactly as the page does`);
  }
  assert.match(html, /aria-label="What the underlines mean"/);
});

test("every drawing path takes its line from the pattern, not the colour alone", () => {
  // Docs: the in-tree SVG rect, its fixed-div fallback, the page-anchored div; field mode's line.
  assert.ok(!/setAttribute\("fill", color\)/.test(SRC), "the SVG bar is filled through svgMarkFill");
  assert.ok(!/background: color, borderRadius: "2px"/.test(SRC), "no Docs div bar is a bare colour");
  assert.equal((SRC.match(/background: markFill\(color, pattern\)/g) || []).length, 3, "the two Docs div bars and field mode's line");
  assert.match(SRC, /bar\.setAttribute\("fill", svgMarkFill\(color, pattern\)\)/);
  assert.match(SRC, /line\.style\.height = `\$\{markLineHeight\(pattern, on\)\}px`/, "hover keeps the double rule readable");
  // The legend is in both panels, under the cards.
  assert.equal((SRC.match(/cardListHtml\(cards\) \+ legendHtml\(\)/g) || []).length, 2);
});
