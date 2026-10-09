/* Never colour alone (CLAUDE.md "UI decisions"), with every line solid.
 * Until 2.21.34 the LINE said what a mark meant as well as its colour —
 * solid for wrong, dashed for worth checking, double for a missing citation.
 * Owner, 2026-10-09: "I don't like the dotted underline, find a different way
 * to differentiate underlines but make them all solid and straight line." So
 * every underline is one solid line, and the kind is said by an ICON in the
 * page's left margin beside the line — the header's own icons — and by the
 * one legend, which shows each line with its icon. Amber #ffb800 is 1.73:1 on
 * white, and red and orange are close under tritanopia: the icon is what
 * keeps the colour from being the only difference. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

function load(extra = {}) {
  const code = `
    ${sliceBetween(SRC, "  const MARK_COLORS =", "\n")}
    const MARK_LINE_HEIGHT = 2, MARK_LINE_HEIGHT_HOVERED = 3;
    ${sliceBetween(SRC, "  const TALLY_ICON = {", "\n  };\n")}
  };
    ${sliceBetween(SRC, "  const MARK_PATTERN =", "  const MARK_LINE_RADIUS")}
    ({ MARK_COLORS, MARK_PATTERN, MARK_ICON, MARK_ICON_RANK, TALLY_ICON, markFill, markLineHeight, svgMarkFill, legendHtml, LEGEND })`;
  return vm.runInContext(code, vm.createContext(extra));
}

test("every line is solid; each kind has its own icon, so colour is never the only difference", () => {
  const { MARK_COLORS, MARK_PATTERN, MARK_ICON, TALLY_ICON } = load();
  const seen = new Map();
  for (const v of Object.keys(MARK_COLORS)) {
    assert.equal(MARK_PATTERN[v], "solid", `${v} is a solid line`);
    assert.ok(TALLY_ICON[MARK_ICON[v]], `${v} has an icon (${MARK_ICON[v]})`);
    seen.set(MARK_ICON[v], MARK_COLORS[v]);
  }
  assert.deepEqual([...seen.keys()].sort(), ["check", "cite", "writing", "wrong"], "the header's four kinds");
  // Two kinds share orange (worth checking, a writing note): their icons differ.
  assert.equal(seen.get("check"), seen.get("writing"));
  assert.notEqual(TALLY_ICON.check, TALLY_ICON.writing);
});

test("the lines themselves: a plain colour, 2px (3px hovered), in a div or in Docs' SVG", () => {
  const { markFill, svgMarkFill, markLineHeight } = load();
  assert.equal(markFill("#ff5900", "solid"), "#ff5900");
  assert.equal(svgMarkFill("#ffb800", "solid"), "#ffb800");
  assert.equal(markLineHeight("solid", false), 2);
  assert.equal(markLineHeight("solid", true), 3);
  assert.ok(!/repeating-linear-gradient|patternUnits|borderBottom: `2px dotted/.test(SRC), "no dashed, double or dotted line is drawn anywhere");
  assert.match(SRC, /borderBottom: `2px solid \$\{color\}`, opacity: "0\.45",/, "still checking: a faint solid grey line");
});

test("one legend: each kind's icon beside its solid line, in the cards' words", () => {
  const { legendHtml, MARK_COLORS, TALLY_ICON } = load();
  const html = legendHtml();
  assert.equal((html.match(/class="legend-item"/g) || []).length, 4);
  for (const [v, label, kind] of [["false", "Contradicted or doesn't make sense", "wrong"], ["questionable", "Worth checking", "check"], ["needs_citation", "Missing or incomplete citation", "cite"], ["note_tip", "Writing note", "writing"]]) {
    assert.ok(html.includes(`<span class="legend-ico" aria-hidden="true" style="color:${MARK_COLORS[v]}">${TALLY_ICON[kind]}</span><span class="legend-line" aria-hidden="true" style="background: ${MARK_COLORS[v]}; height: 2px"></span>${label}`), label);
  }
  assert.match(html, /aria-label="What the underlines and margin icons mean"/);
  assert.equal((SRC.match(/cardListHtml\(cards\) \+ legendHtml\(\)/g) || []).length, 2, "in both panels, under the cards");
});

/* drawMarginIcons over a stand-in of Docs' annotation SVG: one line's runs. */
function fakeSvg() {
  const parent = { children: [], appendChild(c) { this.children.push(c); return c; } };
  const rect = (label, x, y, h = 18, tf = null) => {
    const n = { tagName: "rect", attrs: { "aria-label": label, x: String(x), y: String(y), height: String(h), ...(tf ? { transform: tf } : {}) }, parentNode: parent,
      getAttribute(k) { return this.attrs[k] ?? null; }, hasAttribute(k) { return k in this.attrs; } };
    parent.children.push(n);
    return n;
  };
  const document = { createElementNS: (_ns, tag) => ({ tagName: tag, attrs: {}, style: {}, innerHTML: "", setAttribute(k, v) { this.attrs[k] = v; } }) };
  return { parent, rect, document };
}

test("the margin icon: one a line, the most serious kind on it, left of where the line's text starts, carried with it", () => {
  const { parent, rect, document } = fakeSvg();
  const lineA1 = rect("The Mongols invented", 96, 100, 18, "matrix(1 0 0 1 0 0)");
  const lineA2 = rect(" the dollar (Smith).", 240, 100, 18, "matrix(1 0 0 1 0 0)");
  const lineB = rect("Trade grew.", 96, 130);
  const lineC = rect("It grew because roads were", 96, 160);
  const lineD = rect("safe for merchants.", 96, 190);
  const lastVerdictByHash = new Map([["s1", "needs_citation"], ["s2", "false"], ["s3", "note_tip"], ["s4", "questionable"]]);
  const X = vm.runInContext(`
    ${sliceBetween(SRC, "  const MARK_COLORS =", "\n")}
    ${sliceBetween(SRC, "  const TALLY_ICON = {", "\n  };\n")}
  };
    ${sliceBetween(SRC, "  const MARK_ICON =", "\n")}
    ${sliceBetween(SRC, "  const MARK_ICON_RANK =", "\n")}
    ${sliceBetween(SRC, "    function drawMarginIcons(svgBars) {", "    // Docs' small scrolls blit pixels")}
    ({ drawMarginIcons })`, vm.createContext({ document, lastVerdictByHash }));
  // Line A carries a citation note and a wrong fact; line B a writing note.
  // …and s4 is one sentence wrapped over lines C and D.
  X.drawMarginIcons([{ hash: "s1", node: lineA2 }, { hash: "s2", node: lineA1 }, { hash: "s3", node: lineB }, { hash: "s4", node: lineD }, { hash: "s4", node: lineC }]);
  const icons = parent.children.filter((n) => n.tagName === "svg");
  assert.equal(icons.length, 3, "one icon a line, and a wrapped sentence gets one, beside its first line");
  assert.equal(icons[2].attrs.y, String(160 + (18 - 12) / 2));
  const [a, b] = icons;
  assert.equal(a.attrs["data-tracely-margin-icon"], "wrong", "the most serious kind on the line");
  assert.equal(a.style.color, "#d93636");
  assert.deepEqual([a.attrs.x, a.attrs.y, a.attrs.width], [String(96 - 12 - 8), String(100 + (18 - 12) / 2), "12"], "left of the line's first run, level with it");
  assert.equal(a.attrs.transform, "matrix(1 0 0 1 0 0)", "in the line's own coordinates, so it scrolls and zooms with the text");
  assert.ok("data-tracely-bar" in a.attrs, "ours: swept by the next draw, ignored by the annotation observer");
  assert.match(a.innerHTML, /^<circle /, "the header's icon, inside our own <svg>");
  assert.equal(b.attrs["data-tracely-margin-icon"], "writing");
  assert.match(SRC, /joinBars\(\);\n\s+drawMarginIcons\(svgBars\);/, "drawn with the bars, after they are joined");
});
