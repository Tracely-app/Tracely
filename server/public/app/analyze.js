/**
 * Analyze tab — a contentEditable document with mark layers stacked over it.
 *
 * OFFSET MODEL (used consistently for marks AND claims):
 *   The canonical plain text of the document is produced by buildTextIndex():
 *   - every text node contributes its characters in document order
 *     (NBSP is normalized to a plain space, 1:1, so offsets never shift);
 *   - every <br> contributes "\n";
 *   - every block-element boundary (DIV, P, H1-6, LI, BLOCKQUOTE, PRE)
 *     contributes "\n" when the text does not already end with one.
 *   editorText() returns exactly this string, and the same index maps any
 *   [start, end) span of it back to a DOM Range. Because the text that is sent
 *   to detect/grade/structure and the text used to place underline rects come
 *   from the same function, offsets agree by construction.
 *
 * INCREMENTAL DETECTION (token cost scales with the EDIT, not the document):
 *   The canonical text is split into paragraph blocks (runs of non-empty lines
 *   separated by blank lines, offsets tracked) and each block is hashed (djb2).
 *   state.blockClaims maps blockHash → detected claims stored with
 *   BLOCK-RELATIVE offsets. When the detect gate fires, only blocks whose hash
 *   has no entry ("dirty") are sent — joined with "\n\n", boundaries tracked —
 *   and returned claim offsets are mapped back through the boundaries into
 *   block-relative form. When no block is dirty the call is skipped entirely
 *   and the gate is NOT stamped. Rendering walks the current blocks in order
 *   and projects block-relative claims onto document offsets, so claims in
 *   untouched paragraphs survive edits elsewhere with their evidence/critique
 *   state intact. Claim identity is (blockHash + relStart + djb2(claimText)) —
 *   stable across re-detections — never the server-assigned id.
 *
 * LAYERING (the two traps are stacking contexts and pointer events):
 *   .ed-stack (position:relative)
 *     #edDoc (contenteditable)
 *     .ed-layer[data-layer=pending]  z1 — grey dotted, NO hover card
 *     .ed-layer[data-layer=prose]    z2 — grammar/style
 *     .ed-layer[data-layer=claim]    z3 — credibility marks
 *     .ed-popover                    z4 — SIBLING of the layers, never a child
 *   All mark layers are pointer-events:none so the caret can be placed through
 *   them; only the popover takes the pointer. Hover is hit-tested on the stack.
 */
import { showReport } from "/app/report.js";
import { applyAppearance } from "/app/settings.js";
import { clearTracerDraft } from "/app/tracer.js";

/* ── section: styles (injected once, namespaced under .an-root) ─────────── */

const STYLE_ID = "an-style";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.dataset.tab = "analyze";
  s.textContent = `
.an-root { display: flex; flex-direction: column; flex: 1; min-height: 0; }

/* focus, caret, selection — the accent carries the interaction language */
.an-root :is(button, select, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.an-root .an-group :focus-visible { outline-offset: -2px; } /* groups clip overflow — keep the ring inside */
.an-root ::selection { background: var(--accent-soft); }
.an-root #edDoc { caret-color: var(--accent-deep); }

/* thin scrollbars, both engines */
.an-root * { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.an-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.an-root ::-webkit-scrollbar-track { background: transparent; }
.an-root ::-webkit-scrollbar-thumb {
  background: var(--line-strong); border-radius: 999px;
  border: 2px solid transparent; background-clip: padding-box;
}
.an-root ::-webkit-scrollbar-thumb:hover { background: var(--ink-faint); }

/* toolbar — grouped segments with hairline dividers */
.an-root .an-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 16px; border-bottom: 1px solid var(--line);
  background: var(--bg-raised); flex-shrink: 0;
}
.an-root .an-group {
  display: inline-flex; align-items: stretch; height: 32px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--bg-panel); overflow: hidden;
}
.an-root .an-group > * + * { border-left: 1px solid var(--line); }
.an-root .an-name { width: 200px; font-weight: 600; transition: border-color .16s ease, box-shadow .16s ease; }
.an-root .an-tool {
  border: none; background: none; border-radius: 0;
  min-width: 32px; cursor: pointer; font-size: 13.5px; color: var(--ink-dim);
  display: inline-flex; align-items: center; justify-content: center; padding: 0 8px;
  transition: background .15s ease, color .15s ease;
}
.an-root .an-tool:hover { background: var(--bg); color: var(--ink); }
.an-root .an-tool:active { background: var(--accent-soft); color: var(--accent-deep); }
.an-root .an-tool.on { background: var(--accent-soft); color: var(--accent-deep); }
.an-root .an-tool.b { font-weight: 700; }
.an-root .an-tool.i { font-style: italic; font-family: var(--serif); }
.an-root .an-tool.u { text-decoration: underline; }
.an-root .an-group .input, .an-root .an-group select.input {
  border: none; border-radius: 0; background: transparent;
  padding: 0 8px; font-size: 12.5px; color: var(--ink-dim);
  transition: background .15s ease, color .15s ease;
}
.an-root .an-group .input:hover { background: var(--bg); color: var(--ink); }
.an-root .an-color { width: 34px; padding: 7px 8px; border: none; background: transparent; cursor: pointer; }
.an-root .an-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.an-root .an-words {
  font-size: 12.5px; color: var(--ink-faint); min-width: 64px; text-align: right;
  font-variant-numeric: tabular-nums;
}

/* body: scroller + structure rail */
.an-root .an-body { display: flex; flex: 1; min-height: 0; }
.an-root .an-scroll { flex: 1; overflow: auto; padding: 32px 24px 96px; }
.an-root .an-page {
  max-width: 860px; margin: 0 auto; padding: 64px 72px;
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow);
}

/* the stack */
.an-root .ed-stack { position: relative; }
.an-root #edDoc {
  outline: none; min-height: 480px;
  font-family: var(--serif); font-size: 16px; line-height: 1.75; color: var(--ink);
  white-space: pre-wrap; word-wrap: break-word;
}
.an-root #edDoc:empty::before { content: "Start typing..."; color: var(--ink-faint); pointer-events: none; }
.an-root .ed-layer { position: absolute; inset: 0; pointer-events: none; transition: opacity .18s ease; }
.an-root .ed-layer[data-layer="pending"] { z-index: 1; }
.an-root .ed-layer[data-layer="prose"]   { z-index: 2; }
.an-root .ed-layer[data-layer="claim"]   { z-index: 3; }
.an-root .ed-mark { position: absolute; height: 2.5px; border-radius: 1px; }

/* the popover — one card, four states; 160ms fade-lift enter */
.an-root .ed-popover {
  position: absolute; z-index: 4; width: 352px;
  background: var(--bg-raised); border: 1px solid var(--line-strong);
  border-radius: 14px; box-shadow: var(--shadow);
  font-family: var(--sans); font-size: 13px;
  opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(5px);
  transition: opacity .16s ease, transform .16s ease, visibility .16s;
}
.an-root .ed-popover.open { opacity: 1; visibility: visible; pointer-events: auto; transform: none; }
.an-root .ed-pop-tail {
  position: absolute; width: 12px; height: 12px; background: var(--bg-raised);
}
.an-root .ed-pop-tail.top    { top: -6.5px; border-left: 1px solid var(--line-strong); border-top: 1px solid var(--line-strong); transform: rotate(45deg); }
.an-root .ed-pop-tail.bottom { bottom: -6.5px; border-right: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); transform: rotate(45deg); }
.an-root .ed-pop-body { padding: 14px 16px; position: relative; }
.an-root .pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.an-root .pop-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.an-root .pop-label { font-weight: 700; font-size: 13.5px; }
.an-root .pop-diag { color: var(--ink-dim); font-size: 13px; line-height: 1.5; margin-bottom: 10px; }
.an-root .pop-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.an-root .pop-actions .btn { padding: 5px 10px; font-size: 12px; }
.an-root .pop-empty { color: var(--ink-dim); font-style: italic; margin-bottom: 10px; line-height: 1.5; }

/* searching skeletons */
.an-root .pop-skel { height: 34px; border-radius: 8px; margin-bottom: 7px;
  background: linear-gradient(90deg, var(--bg) 25%, var(--accent-soft) 50%, var(--bg) 75%);
  background-size: 200% 100%; animation: an-shimmer 1.1s infinite linear; }
@keyframes an-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* result rows — fade-slide in with a short stagger */
.an-root .pop-styles { display: flex; gap: 4px; margin: 2px 0 8px; }
.an-root .pop-style {
  border: 1px solid var(--line-strong); background: var(--bg-raised); border-radius: 999px;
  font-size: 11px; padding: 2px 9px; cursor: pointer; color: var(--ink-dim);
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.an-root .pop-style:hover { border-color: var(--accent); color: var(--accent-deep); }
.an-root .pop-style.on { background: var(--accent-soft); color: var(--accent-deep); border-color: var(--accent); font-weight: 600; }
.an-root .pop-srcs { max-height: 240px; overflow-y: auto; margin-bottom: 8px; }
.an-root .pop-src {
  display: flex; gap: 8px; padding: 7px 6px; border-radius: 8px; align-items: flex-start;
  transition: background .15s ease;
  animation: an-in .18s ease both;
}
@keyframes an-in { from { opacity: 0; transform: translateY(4px); } }
.an-root .pop-src:hover { background: var(--bg); }
.an-root .pop-src img { width: 16px; height: 16px; border-radius: 3px; margin-top: 2px; flex-shrink: 0; }
.an-root .pop-src-main { flex: 1; min-width: 0; }
.an-root .pop-src-title { font-weight: 600; font-size: 12.5px; line-height: 1.35; }
.an-root .pop-src-meta { color: var(--ink-faint); font-size: 11.5px; margin-top: 1px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.an-root .pop-chip { border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; font-size: 10px; background: var(--bg); color: var(--ink-dim); }
.an-root .pop-match { font-family: var(--mono); font-size: 11px; color: var(--accent-deep); }
.an-root .pop-src-btns { display: flex; flex-direction: column; gap: 4px; }
.an-root .pop-src-btns .btn { padding: 3px 8px; font-size: 11px; white-space: nowrap; }
.an-root .pop-preview {
  font-family: var(--serif); font-size: 12px; color: var(--ink-dim); line-height: 1.5;
  background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 10px; margin-bottom: 8px; word-wrap: break-word;
}
.an-root .pop-entry {
  font-family: var(--serif); font-size: 12.5px; line-height: 1.5; word-wrap: break-word;
  background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 9px 11px; margin: 8px 0 10px;
}
.an-root .pop-ok { color: var(--accent-deep); font-weight: 700; }

/* compare-sources side by side */
.an-root .pop-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.an-root .pop-compare-col { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 9px; min-width: 0; }
.an-root .pop-compare-col .eyebrow { margin-bottom: 5px; }
.an-root .pop-compare-col .t { font-weight: 600; font-size: 12px; line-height: 1.35; }
.an-root .pop-compare-col .m { color: var(--ink-faint); font-size: 11px; margin-top: 2px; }

/* structure rail */
.an-root .an-rail {
  width: 0; overflow: hidden; border-left: 1px solid var(--line); background: var(--bg-panel);
  transition: width .2s ease; flex-shrink: 0;
}
.an-root .an-rail.open { width: 248px; overflow-y: auto; }
.an-root .an-rail-inner { padding: 16px; width: 248px; }
.an-root .an-rail h3 { font-family: var(--serif); font-size: 15px; line-height: 1.25; margin-bottom: 10px; }
.an-root .an-para {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px;
  background: var(--bg-raised); animation: an-in .18s ease both;
  transition: transform .16s ease, box-shadow .16s ease;
}
.an-root .an-para:hover { transform: translateY(-1px); box-shadow: var(--shadow); }
.an-root .an-para .role { font-weight: 700; font-size: 12px; }
.an-root .an-para .idx { color: var(--ink-faint); font-family: var(--mono); font-size: 10.5px; }
.an-root .an-fault { display: inline-block; margin: 3px 3px 0 0; font-size: 10.5px; border-radius: 999px; padding: 1px 8px; background: var(--accent-soft); color: var(--accent-deep); }
.an-root .an-rail-empty { color: var(--ink-faint); font-size: 12px; }
`;
  document.head.appendChild(s);
}

/* ── section: small utilities ───────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function debounce(fn, ms) {
  let t = null;
  let pendingArgs = null;
  const d = (...args) => {
    pendingArgs = args;
    clearTimeout(t);
    t = setTimeout(() => { t = null; const a = pendingArgs; pendingArgs = null; fn(...a); }, ms);
  };
  d.cancel = () => { clearTimeout(t); t = null; pendingArgs = null; };
  // Run a pending call NOW (no-op when nothing is pending) — used by teardown
  // so a save scheduled just before navigation cannot land after a re-open.
  d.flush = () => {
    if (t == null) return;
    clearTimeout(t);
    t = null;
    const a = pendingArgs ?? [];
    pendingArgs = null;
    fn(...a);
  };
  return d;
}

function normWs(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/* djb2 — same hash the rest of the app uses. Raw text, no normalization:
   a whitespace edit must invalidate the block, or its stored block-relative
   offsets would silently drift. */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Split canonical text into paragraph blocks: runs of non-empty lines
 * separated by blank lines. Offsets index into the canonical text, so
 * blockText === text.slice(start, end) always holds.
 */
function splitBlocks(text) {
  const out = [];
  let cur = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    const start = pos;
    const end = pos + line.length;
    if (line.trim()) {
      if (cur) cur.end = end;
      else cur = { start, end };
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
    pos = end + 1; // the "\n" itself
  }
  if (cur) out.push(cur);
  return out.map((b) => {
    const t = text.slice(b.start, b.end);
    return { start: b.start, end: b.end, text: t, hash: djb2(t) };
  });
}

/* The mark DECISION comes from /shared/marks.js; the PAINT goes through the
   theme tokens so dark mode can retune the hexes. Never paint COLORS.hex. */
const MARK_TOKENS = {
  red: "var(--mark-red)",
  amber: "var(--mark-amber)",
  orange: "var(--mark-orange)",
  grey: "var(--mark-grey)",
};
function markPaint(color) {
  return MARK_TOKENS[color] ?? MARK_TOKENS.grey;
}

/* Concurrency-limited pool over items; fn(item, index). */
async function pool(items, limit, fn) {
  const queue = items.map((item, i) => [item, i]);
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) {
      const [item, i] = queue.shift();
      await fn(item, i);
    }
  });
  await Promise.all(workers);
}

/* ── section: canonical text index (the offset model) ───────────────────── */

const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE"]);

/**
 * Walks the editable root and produces:
 *   text     — the canonical plain text (see file-header offset model)
 *   segments — [{ node, start, end }] mapping each text node onto canonical
 *              offsets (end exclusive). "\n" characters produced by <br> or
 *              block boundaries own no node and can never anchor a mark.
 */
function buildTextIndex(root) {
  let text = "";
  const segments = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = child.data.replace(/\u00a0/g, " "); // NBSP → space, 1:1
        segments.push({ node: child, start: text.length, end: text.length + data.length });
        text += data;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.nodeName === "BR") { text += "\n"; continue; }
        const isBlock = BLOCK_TAGS.has(child.nodeName);
        if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
        walk(child);
        if (isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
      }
    }
  })(root);
  return { text, segments };
}

/** Map a canonical [start, end) span to a DOM Range, or null if unmappable. */
function rangeForOffsets(index, start, end) {
  const { segments } = index;
  let a = null;
  let b = null;
  for (const seg of segments) {
    if (a == null && start >= seg.start && start < seg.end) a = { node: seg.node, off: start - seg.start };
    if (end > seg.start && end <= seg.end) b = { node: seg.node, off: end - seg.start };
  }
  // A collapsed position at the very end of a text node.
  if (a == null) {
    for (const seg of segments) {
      if (start === seg.end) { a = { node: seg.node, off: seg.end - seg.start }; break; }
    }
  }
  if (a == null || b == null) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.off);
    range.setEnd(b.node, b.off);
  } catch { return null; }
  return range;
}

/* ── section: sentence splitting (offsets into canonical text) ──────────── */

function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      if (text.slice(start, i).trim()) out.push({ start, end: i });
      start = i + 1;
    } else if (ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < text.length && /["'’”)\]]/.test(text[j])) j++;
      if (j >= text.length || /\s/.test(text[j])) {
        if (text.slice(start, j).trim()) out.push({ start, end: j });
        while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
        start = j;
        i = j - 1;
      }
    }
  }
  if (start < text.length && text.slice(start).trim()) out.push({ start, end: text.length });
  return out.map((s) => ({ ...s, text: text.slice(s.start, s.end) }));
}

/* ── section: prose rules — pure, local, precise ────────────────────────── */
/* Each rule yields { start, end, solid } spans over the canonical text.
   Small set on purpose: no false-positive-prone rules. */

function proseMarks(text) {
  const out = [];
  let m;
  // repeated word ("the the") — error
  const rep = /\b([A-Za-z]+) +\1\b/gi;
  while ((m = rep.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, solid: true });
  // double space between words — error
  const dbl = /(?<=\S) {2,}(?=\S)/g;
  while ((m = dbl.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, solid: true });
  // "alot" — error
  const alot = /\balot\b/gi;
  while ((m = alot.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, solid: true });
  // could of / should of / would of — error
  const modalOf = /\b(?:could|should|would) +of\b/gi;
  while ((m = modalOf.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, solid: true });
  // sentence longer than 45 words — suggestion (dotted)
  for (const s of splitSentences(text)) {
    const words = s.text.trim().split(/\s+/).filter(Boolean).length;
    if (words > 45) out.push({ start: s.start, end: s.end, solid: false });
  }
  return out;
}

/* ── section: citation-module adapters ──────────────────────────────────── */
/* The shared citations module is built by a sibling agent; these adapters
   tolerate both its planned surface (hasOwnCitation/detectCitationDefects)
   and the stub surface (detectDefects/detectProseAttribution). */

function lastParenRef(sentence) {
  const all = [...String(sentence ?? "").matchAll(/\(([^()]{2,220})\)/g)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

function makeCitationHelpers(citations) {
  const hasOwnCitation = (sentence) => {
    if (typeof citations.hasOwnCitation === "function") return Boolean(citations.hasOwnCitation(sentence));
    if (lastParenRef(sentence)) return true;
    if (typeof citations.detectProseAttribution === "function") {
      try { return Boolean(citations.detectProseAttribution(sentence)); } catch { return false; }
    }
    return false;
  };
  const citationDefects = (sentence) => {
    const fn = typeof citations.detectCitationDefects === "function" ? citations.detectCitationDefects
      : typeof citations.detectDefects === "function" ? citations.detectDefects : null;
    if (!fn) return [];
    try { return fn(sentence) ?? []; } catch { return []; }
  };
  const formatCitation = (source, style) => {
    try {
      const out = citations.formatCitation(source, style);
      if (out && (out.entry || out.inText)) return out;
    } catch { /* fall through to the minimal formatter */ }
    // Minimal fallback so the insert flow still works against the stub.
    const authors = (source.authors ?? []).map(String);
    const first = authors[0] ?? "";
    const surname = first.includes(",") ? first.split(",")[0] : first.split(" ").pop() ?? "";
    const year = source.year ?? "n.d.";
    const entry = `${authors.join(", ") || "Unknown author"} (${year}). ${source.title ?? ""}. ${source.venue ?? ""}.`.replace(/\s+/g, " ").trim();
    const inText = surname ? `(${surname}, ${year})` : `(${(source.title ?? "").split(/\s+/).slice(0, 3).join(" ")}, ${year})`;
    return { entry, inText };
  };
  return { hasOwnCitation, citationDefects, formatCitation };
}

/* ── section: render ────────────────────────────────────────────────────── */


/* The desktop grader's six components, in the shape report.js and
   shared/rubric.js already read. `reason` is the grader's word for `note`;
   counterargument is dropped from the denominator when the grader says the
   essay's genre does not call for one (rubric: "Do not require
   counterarguments for every essay"). */
function fromRubricGrade(res) {
  const out = {};
  for (const [key, c] of Object.entries(res?.components ?? {})) {
    if (!c) continue;
    out[key] = { score: c.score, quote: c.quote || undefined, note: c.reason || "" };
  }
  if (res?.counterargumentApplicable === false && out.counterargument) out.counterargument.absent = true;
  return out;
}

/* What the structure rail prints under a paragraph. The classifier answers in
   fields — does it state a claim, is there a warrant, which reasoning fault —
   and the rail shows the ones that are problems. */
const REASONING_FAULT_LABEL = {
  circular: "Circular reasoning",
  "sequence-as-cause": "Treats sequence as cause",
  "single-case": "Generalises from one case",
  leap: "Logical leap",
};
function structureFaults(p) {
  const out = [];
  if (REASONING_FAULT_LABEL[p?.reasoningFailure]) out.push(REASONING_FAULT_LABEL[p.reasoningFailure]);
  const argues = ["claim", "evidence", "reasoning", "counterargument"].includes(p?.role);
  if (argues && p?.hasWarrant === false && !out.length) out.push("No warrant");
  return out;
}

export async function render(mount, ctx) {
  ensureStyles();
  applyAppearance(ctx.settings);
  const { api, marks, rubric, guards, settings } = ctx;
  const cite = makeCitationHelpers(ctx.citations);
  const GUARDS = guards.GUARDS;

  /* ── staleness guard ──────────────────────────────────────────────────────
     This render awaits BEFORE building any DOM, so by the time the document
     arrives the user may have navigated elsewhere (or to a different doc).
     Injecting the editor then would stack it under whatever tab is showing
     and leave a live detect pipeline running. Bail instead. */
  const requestedDocId = ctx.params.docId ?? null;
  function currentHashDocId() {
    const qs = location.hash.split("?")[1] ?? "";
    return new URLSearchParams(qs).get("docId");
  }
  function isStale() {
    if (mount.dataset.tab !== "analyze") return true;
    // If we were opened for a specific doc, the hash must still point at it.
    if (requestedDocId != null && currentHashDocId() !== requestedDocId) return true;
    // If we were opened without a doc, a docId appearing in the hash means a
    // different analyze render claimed the view.
    if (requestedDocId == null && currentHashDocId() != null) return true;
    return false;
  }

  /* ── document load ── */
  // Navigating to #/analyze without a docId must NOT create a document as a
  // side effect: open the most recently opened document when one exists, and
  // only create an Untitled when the user has none at all.
  let doc;
  try {
    if (requestedDocId) {
      doc = await api.documents.get(requestedDocId);
    } else {
      const listed = await api.documents.list("opened");
      const recent = (listed.documents ?? [])[0];
      doc = recent
        ? await api.documents.get(recent.id)
        : await api.documents.create({ title: "Untitled" });
    }
  } catch (e) {
    if (isStale()) return;
    mount.innerHTML = "";
    mount.appendChild(el("div", "an-root", `Could not open document: ${e.message}`));
    return;
  }
  if (isStale()) return; // navigated away while loading — do not touch the DOM
  const docId = doc.id;
  if (!ctx.params.docId) {
    // Put the id in the hash without re-triggering the router.
    history.replaceState(null, "", `#/analyze?docId=${docId}`);
  }

  /* ── DOM chrome ── */
  const root = el("div", "an-root");
  const bar = el("div", "an-toolbar");

  const backBtn = el("button", "btn btn-ghost", "← Back");
  const nameInput = el("input", "input an-name");
  nameInput.placeholder = "Doc name";
  nameInput.value = doc.title === "Untitled" ? "" : (doc.title ?? "");

  const fontSel = el("select", "input");
  for (const f of ["Georgia", "Times New Roman", "Arial", "Verdana"]) {
    const o = el("option", null, f);
    o.value = f;
    fontSel.appendChild(o);
  }
  const sizeSel = el("select", "input");
  for (const z of ["12", "14", "16", "18", "20", "24"]) {
    const o = el("option", null, z);
    o.value = z;
    if (z === "16") o.selected = true;
    sizeSel.appendChild(o);
  }

  const boldBtn = el("button", "an-tool b", "B");
  const italicBtn = el("button", "an-tool i", "I");
  const underBtn = el("button", "an-tool u", "U");
  const colorInput = el("input", "an-color");
  colorInput.type = "color";
  colorInput.value = "#23201a";
  colorInput.title = "Text colour";
  const alignL = el("button", "an-tool", "≡");
  alignL.title = "Align left";
  const alignC = el("button", "an-tool", "≣");
  alignC.title = "Align centre";
  const alignR = el("button", "an-tool", "≡");
  alignR.title = "Align right";
  const structBtn = el("button", "btn btn-ghost", "Structure");

  const right = el("div", "an-right");
  const tracerBtn = el("button", "btn", "Tracer");
  tracerBtn.title = "Chat with Tracer about this draft";
  const insightsBtn = el("button", "btn btn-primary", "AI Insights");
  const gradeChip = el("span", "grade-chip", `Grade ${settings.gradingLevel ?? 12}`);
  const wordsEl = el("span", "an-words", "0 words");
  right.append(tracerBtn, insightsBtn, gradeChip, wordsEl);

  const group = (...kids) => {
    const g = el("span", "an-group");
    g.append(...kids);
    return g;
  };
  bar.append(
    backBtn, nameInput,
    group(fontSel, sizeSel),
    group(boldBtn, italicBtn, underBtn, colorInput),
    group(alignL, alignC, alignR),
    structBtn, right
  );

  const body = el("div", "an-body");
  const scroller = el("div", "an-scroll");
  const page = el("div", "an-page");
  const stack = el("div", "ed-stack");
  const edDoc = el("div");
  edDoc.id = "edDoc";
  edDoc.contentEditable = "true";
  edDoc.spellcheck = true;
  edDoc.innerHTML = doc.body_html ?? "";
  const layerPending = el("div", "ed-layer");
  layerPending.dataset.layer = "pending";
  const layerProse = el("div", "ed-layer");
  layerProse.dataset.layer = "prose";
  const layerClaim = el("div", "ed-layer");
  layerClaim.dataset.layer = "claim";
  const popover = el("div", "ed-popover"); // sibling of the layers, never a child
  stack.append(edDoc, layerPending, layerProse, layerClaim, popover);
  page.appendChild(stack);
  scroller.appendChild(page);

  const rail = el("div", "an-rail");
  const railInner = el("div", "an-rail-inner");
  rail.appendChild(railInner);
  body.append(scroller, rail);
  root.append(bar, body);
  mount.appendChild(root);

  /* ── teardown plumbing ── */
  const ac = new AbortController();
  const signal = ac.signal;
  const timers = new Set();
  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); if (root.isConnected) fn(); }, ms);
    timers.add(t);
    return t;
  }
  function teardown() {
    ac.abort();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // Flush pending debounced saves NOW: a save left on its timer can land
    // AFTER the same document is re-opened and stale-overwrite new writing.
    saveName.flush();
    saveBody.flush();
    // Drop the dock's draft getter so Tracer stops reading (and pinning in
    // memory) this torn-down editor's DOM.
    clearTracerDraft();
  }
  window.addEventListener("hashchange", teardown, { signal });

  /* ── state ── */
  const state = {
    claims: [],            // projection of blockClaims onto the current doc: [{ key, id, text, sentence, claimType, confidence, query, start, end, state, sources, critique, dismissed }]
    blockClaims: new Map(),// blockHash → [{ key, text, sentence, claimType, confidence, query, relStart, relEnd }] (block-relative)
    claimByKey: new Map(), // stable claim key → the ONE live claim record (evidence/critique state lives here)
    dismissed: new Set(),  // stable claim keys dismissed by the writer — survive re-detection
    analysisSeq: 0,        // stale-run token
    lastStampAt: 0,
    grading: false,
    index: null,           // latest buildTextIndex result (rebuilt each paint) — see paint()
    hitRects: [],          // [{ claim, rect }] in stack coordinates, claim layer only
    card: { open: false, claim: null, mode: null, pinned: false, hideTimer: null, style: settings.citationStyle ?? "apa", insertArmed: false },
  };
  const gate = guards.detectGate();

  function editorText() {
    return buildTextIndex(edDoc).text;
  }

  /* ── toolbar behaviour ── */
  backBtn.addEventListener("click", () => ctx.navigate("documents"), { signal });
  const saveName = debounce(() => {
    api.documents.update(docId, { title: nameInput.value.trim() || "Untitled" }).catch(() => {});
  }, 600);
  nameInput.addEventListener("input", saveName, { signal });
  fontSel.addEventListener("change", () => { edDoc.style.fontFamily = fontSel.value; schedulePaint(); }, { signal });
  sizeSel.addEventListener("change", () => { edDoc.style.fontSize = `${sizeSel.value}px`; schedulePaint(); }, { signal });
  const cmd = (name, value) => { edDoc.focus(); document.execCommand(name, false, value); schedulePaint(); };
  boldBtn.addEventListener("click", () => cmd("bold"), { signal });
  italicBtn.addEventListener("click", () => cmd("italic"), { signal });
  underBtn.addEventListener("click", () => cmd("underline"), { signal });
  colorInput.addEventListener("input", () => cmd("foreColor", colorInput.value), { signal });
  alignL.addEventListener("click", () => cmd("justifyLeft"), { signal });
  alignC.addEventListener("click", () => cmd("justifyCenter"), { signal });
  alignR.addEventListener("click", () => cmd("justifyRight"), { signal });
  // Active states for the format toggles, synced to wherever the caret sits.
  function syncToolStates() {
    if (!root.isConnected) return;
    const sel = window.getSelection();
    const inDoc = Boolean(sel && sel.anchorNode && edDoc.contains(sel.anchorNode));
    let b = false, i = false, u = false;
    if (inDoc) {
      try {
        b = document.queryCommandState("bold");
        i = document.queryCommandState("italic");
        u = document.queryCommandState("underline");
      } catch { /* queryCommandState unsupported — leave toggles off */ }
    }
    boldBtn.classList.toggle("on", b);
    italicBtn.classList.toggle("on", i);
    underBtn.classList.toggle("on", u);
  }
  document.addEventListener("selectionchange", syncToolStates, { signal });
  // The getter self-invalidates: once this editor is detached it must not
  // keep feeding its (stale) full text to the paid tracer endpoint.
  tracerBtn.addEventListener("click", () => ctx.openTracer(docId, () => (root.isConnected ? editorText() : "")), { signal });

  /* ── document persistence (debounced 800ms) ── */
  const saveBody = debounce(() => {
    api.documents.update(docId, { bodyHtml: edDoc.innerHTML }).catch(() => {});
  }, 800);

  /* ── mark painting ──────────────────────────────────────────────────────
     Prose and claim marks are recomputed in the SAME frame so the layers
     always agree about where the text is. */
  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (root.isConnected) paint();
    });
  }

  function stackRectsFor(range) {
    const stackBox = stack.getBoundingClientRect();
    const out = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      out.push({ x: r.left - stackBox.left, y: r.top - stackBox.top, w: r.width, h: r.height });
    }
    return out;
  }

  function drawUnderline(layer, rects, paint, dotted) {
    // `paint` is a var(--mark-…) token, never a raw hex — dark mode retunes it.
    for (const r of rects) {
      const m = el("div", "ed-mark");
      m.style.left = `${r.x}px`;
      m.style.top = `${r.y + r.h - 2.5}px`;
      m.style.width = `${r.w}px`;
      if (dotted) m.style.backgroundImage = `repeating-linear-gradient(90deg, ${paint} 0 4px, transparent 4px 8px)`;
      else m.style.background = paint;
      layer.appendChild(m);
    }
  }

  /** Re-anchor a stored span against the current canonical text. */
  function anchorSpan(text, needle, hintStart) {
    if (!needle) return null;
    if (Number.isInteger(hintStart) && text.slice(hintStart, hintStart + needle.length) === needle) {
      return { start: hintStart, end: hintStart + needle.length };
    }
    const from = Number.isInteger(hintStart) ? Math.max(0, hintStart - needle.length - 40) : 0;
    let at = text.indexOf(needle, from);
    if (at < 0) at = text.indexOf(needle);
    if (at < 0) return null;
    return { start: at, end: at + needle.length };
  }

  function paint() {
    const index = buildTextIndex(edDoc);
    state.index = index;
    const text = index.text;

    wordsEl.textContent = `${text.trim() ? text.trim().split(/\s+/).length : 0} words`;

    layerPending.textContent = "";
    layerProse.textContent = "";
    layerClaim.textContent = "";
    state.hitRects = [];

    // prose layer — amber from the shared vocabulary; dotted = suggestion, solid = error
    for (const p of proseMarks(text)) {
      const range = rangeForOffsets(index, p.start, p.end);
      if (range) drawUnderline(layerProse, stackRectsFor(range), markPaint("amber"), !p.solid);
    }

    // pending + claim layers — the DECISION is marks.markFor(state); the paint
    // is the matching theme token. Offsets come straight from block projection.
    projectClaims(text);
    for (const c of state.claims) {
      if (c.dismissed) continue;
      const mark = marks.markFor(c.state);
      if (!mark) continue; // clean claim — no underline
      const range = rangeForOffsets(index, c.start, c.end);
      if (!range) continue;
      const rects = stackRectsFor(range);
      if (c.state.status === "pending") {
        drawUnderline(layerPending, rects, markPaint(mark.color), true); // grey dotted, no hover card
      } else {
        drawUnderline(layerClaim, rects, markPaint(mark.color), false);
        for (const r of rects) state.hitRects.push({ claim: c, rect: r });
      }
    }

    // keep an open card glued to its (possibly re-wrapped) sentence
    if (state.card.open && state.card.claim) positionCard(state.card.claim);
  }

  /* ── typing pipeline ── */
  edDoc.addEventListener("input", () => {
    state.card.insertArmed = false; // any edit invalidates the two-step citation Undo
    saveBody();
    schedulePaint();       // instant, local prose marks
    scheduleDetect();      // claim detection after a typing pause
  }, { signal });
  scroller.addEventListener("scroll", schedulePaint, { signal, passive: true });
  window.addEventListener("resize", schedulePaint, { signal });

  /* ── claim detection (guards debounce + floor) ── */
  let idleTimer = null;
  let retryTimer = null;
  function scheduleDetect() {
    clearTimeout(idleTimer);
    // New typing also cancels a pending floor-lift retry: the idle timer must
    // be the sole trigger while the user is active, or detection fires
    // mid-keystroke the moment the interval floor lifts.
    clearTimeout(retryTimer);
    retryTimer = null;
    idleTimer = later(attemptDetect, GUARDS.detect.idleMs);
  }
  function attemptDetect() {
    const text = editorText();
    if (!gate.shouldRun(text)) {
      // If the block is purely the interval floor, retry once when it lifts.
      const wait = GUARDS.detect.minIntervalMs - (Date.now() - state.lastStampAt);
      if (text.length >= GUARDS.detect.minChars && wait > 0 && !retryTimer) {
        retryTimer = later(() => { retryTimer = null; attemptDetect(); }, wait + 100);
      }
      return;
    }
    // Incremental: only blocks whose hash has no stored result cost anything.
    const blocks = splitBlocks(text);
    stampBibliography(blocks);
    const dirty = blocks.filter((b) => !state.blockClaims.has(b.hash));
    if (dirty.length === 0) return; // every paragraph already analysed — skip the call, do NOT stamp
    gate.stamp(text); // BEFORE the call
    state.lastStampAt = Date.now();
    runAnalysis(dirty);
  }

  /** Blocks in a trailing "Works Cited" section are stamped as claim-free
      without ever being sent — a bibliography is not fact-checkable prose. */
  function stampBibliography(blocks) {
    let inBib = false;
    for (const b of blocks) {
      if (!inBib && /^\s*works cited\s*$/i.test(b.text.split("\n")[0] ?? "")) inBib = true;
      if (inBib && !state.blockClaims.has(b.hash)) state.blockClaims.set(b.hash, []);
    }
  }

  /** Map one detected claim (offsets relative to the SENT text) back through
      the block boundaries into a block-relative record with a stable key. */
  function placeClaim(raw, boundaries, sent) {
    const ctext = String(raw.text ?? "");
    if (!ctext.trim()) return null;
    // Trust the server offset when it agrees with the text; else re-anchor.
    let at = Number.isInteger(raw.start) && sent.slice(raw.start, raw.start + ctext.length) === ctext
      ? raw.start
      : sent.indexOf(ctext);
    if (at < 0) return null;
    let owner = null;
    for (const b of boundaries) {
      if (at >= b.sentStart && at < b.sentStart + b.block.text.length) { owner = b; break; }
    }
    if (!owner) return null;
    const relStart = at - owner.sentStart;
    const relEnd = Math.min(relStart + ctext.length, owner.block.text.length);
    if (relEnd <= relStart) return null;
    const clipped = owner.block.text.slice(relStart, relEnd); // a claim never spans blocks
    return {
      blockHash: owner.block.hash,
      entry: {
        // Stable identity: (blockHash + relStart + claim-text hash). NEVER the
        // server id — that is salted with sent-text offsets and churns per call.
        key: `${owner.block.hash}:${relStart}:${djb2(clipped)}`,
        text: clipped,
        sentence: raw.sentence ?? clipped,
        claimType: raw.claimType,
        confidence: raw.confidence,
        query: raw.query,
        relStart,
        relEnd,
      },
    };
  }

  /** Rebuild state.claims by walking the current blocks in order and
      projecting stored block-relative claims onto document offsets. Records
      are reused via their stable key, so evidence/critique/dismissed state
      survives re-detection of OTHER paragraphs untouched. */
  function projectClaims(text) {
    const out = [];
    const seen = new Set();
    for (const b of splitBlocks(text)) {
      const entries = state.blockClaims.get(b.hash);
      if (!entries) continue;
      for (const d of entries) {
        if (seen.has(d.key)) continue; // duplicate paragraph — one record, one mark
        seen.add(d.key);
        let c = state.claimByKey.get(d.key);
        if (!c) {
          c = {
            id: d.key, key: d.key, text: d.text, sentence: d.sentence,
            claimType: d.claimType, confidence: d.confidence, query: d.query,
            state: { status: "pending" }, sources: [], critique: null,
            dismissed: state.dismissed.has(d.key),
          };
          state.claimByKey.set(d.key, c);
        }
        c.start = b.start + d.relStart;
        c.end = b.start + d.relEnd;
        out.push(c);
      }
    }
    // Cap the union: keep the highest-confidence claims, in document order.
    let claims = out;
    if (claims.length > GUARDS.maxClaimsPerAnalysis) {
      const keep = new Set(
        [...claims]
          .sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0))
          .slice(0, GUARDS.maxClaimsPerAnalysis)
          .map((c) => c.key)
      );
      claims = claims.filter((c) => keep.has(c.key));
    }
    state.claims = claims;
  }

  /** The block cache only grows during a session; keep it bounded without
      ever evicting a block that is still in the document. */
  function pruneBlockCache() {
    const MAX_BLOCK_ENTRIES = 400;
    if (state.blockClaims.size <= MAX_BLOCK_ENTRIES) return;
    const live = new Set(splitBlocks(editorText()).map((b) => b.hash));
    for (const h of state.blockClaims.keys()) {
      if (state.blockClaims.size <= MAX_BLOCK_ENTRIES) break;
      if (!live.has(h)) state.blockClaims.delete(h);
    }
  }

  /** New detection results fade their layers in rather than popping. */
  function fadeMarkLayersIn() {
    for (const layer of [layerPending, layerClaim]) {
      layer.style.opacity = "0";
      requestAnimationFrame(() => requestAnimationFrame(() => { layer.style.opacity = "1"; }));
    }
  }

  async function runAnalysis(dirtyBlocks) {
    const run = ++state.analysisSeq;

    // Send ONLY the dirty blocks, joined with "\n\n", boundaries tracked.
    // Clip by the input guard on whole-block boundaries: blocks that don't fit
    // stay dirty and go out on the next gate pass instead of being truncated.
    const sendable = [];
    let len = 0;
    for (const b of dirtyBlocks) {
      const extra = (sendable.length ? 2 : 0) + b.text.length;
      if (sendable.length && len + extra > GUARDS.maxInputChars) break;
      sendable.push(b);
      len += extra;
    }
    const boundaries = [];
    let sent = "";
    for (const b of sendable) {
      if (sent) sent += "\n\n";
      boundaries.push({ block: b, sentStart: sent.length });
      sent += b.text;
    }

    let detected;
    try {
      detected = await api.detectClaims(sent, { model: settings.model, effort: settings.effort });
    } catch (e) {
      if (e.kind !== "rate_limit") ctx.toast(`Claim detection failed: ${e.message}`, true);
      return;
    }
    if (run !== state.analysisSeq || !root.isConnected) return;

    // Store results per block, keyed by block hash, offsets block-relative.
    // Blocks that produced no claims get an EMPTY entry — analysed and clean,
    // never re-sent while their text is unchanged.
    const perBlock = new Map(sendable.map((b) => [b.hash, []]));
    for (const raw of detected.claims ?? []) {
      const placed = placeClaim(raw, boundaries, sent);
      if (placed) perBlock.get(placed.blockHash).push(placed.entry);
    }
    for (const b of sendable) state.blockClaims.set(b.hash, perBlock.get(b.hash));
    pruneBlockCache();

    projectClaims(editorText());
    fadeMarkLayersIn();
    schedulePaint(); // grey pending marks appear for every claim found

    // Evidence sweep — bounded concurrency, marks refresh after EACH result.
    const toSweep = state.claims.filter((c) => c.state.status === "pending" && !c.dismissed);
    await pool(toSweep, GUARDS.evidenceConcurrency, async (c) => {
      if (run !== state.analysisSeq) return;
      await sweepClaim(c);
      if (run !== state.analysisSeq) return;
      schedulePaint();
    });
    if (run !== state.analysisSeq || !root.isConnected) return;

    // Auto-critique — button-free, but capped and sequential; once per analysis.
    if (settings.autoCritique) {
      const flagged = state.claims.filter((c) => {
        if (c.dismissed || c.state.status !== "checked" || c.state.critique) return false;
        const mark = marks.markFor(c.state);
        return mark && (mark.color === "red" || mark.color === "orange" || mark.color === "amber");
      }).slice(0, GUARDS.maxAutoCritiqueClaims);
      for (const c of flagged) {
        if (run !== state.analysisSeq) return;
        await critiqueClaim(c);
        if (run !== state.analysisSeq) return;
        schedulePaint();
      }
    }
  }

  async function sweepClaim(c) {
    let res;
    try {
      res = await api.evidence({ claim: c.text, query: c.query, claimType: c.claimType });
    } catch {
      // A failed sweep is NOT "no sources": leave the claim pending-grey.
      return;
    }
    const searched = res.searched ?? {};
    c.sources = res.sources ?? [];
    c.state = {
      status: "checked",
      claimType: c.claimType,
      confidence: c.confidence,
      hasOwnCitation: cite.hasOwnCitation(c.sentence),
      citationDefects: cite.citationDefects(c.sentence),
      searched: true,
      sources: {
        count: c.sources.length,
        aboveFloor: searched.aboveFloor ?? 0,
        citableAboveFloor: searched.citableAboveFloor ?? 0,
        providers: searched.providers ?? [],
      },
      outsideIndex: Boolean(searched.outsideIndex),
      strength: res.strength ?? null,
      critique: null,
    };
  }

  async function critiqueClaim(c) {
    try {
      const r = await api.critique({
        claim: c.text,
        sentence: c.sentence,
        citedRef: lastParenRef(c.sentence) ?? undefined,
        sources: (c.sources ?? []).slice(0, 4),
        model: settings.model,
      });
      // The relay's shape since the desktop's critique moved into the server:
      // { critique, verdict, suggestedRevision, citationFix }. The verdict and
      // the corrected reference are what shared/marks.js decides the mark from.
      c.critique = r;
      c.state.critique = { verdict: r.verdict, citationFix: r.citationFix ?? null };
    } catch { /* critique is best-effort; the retrieval mark stands */ }
  }

  /* ── hover card ─────────────────────────────────────────────────────────
     Layers are pointer-events:none, so hover is hit-tested on the stack.
     A running flow PINS the card: while sources load, results are up, or a
     citation was just inserted, the hit-test must not swap the card to a
     different mark. Unpin on close or on mouse-leave-after-settle. */

  function stackPoint(e) {
    const b = stack.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  function claimAt(p) {
    for (const { claim, rect } of state.hitRects) {
      if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y - 2 && p.y <= rect.y + rect.h + 3) return claim;
    }
    return null;
  }

  stack.addEventListener("mousemove", (e) => {
    if (e.target.closest(".ed-popover")) { cancelHide(); return; }
    const hit = claimAt(stackPoint(e));
    if (hit) {
      cancelHide();
      if (state.card.open && state.card.claim === hit) return;
      if (state.card.pinned) return; // never steal a running flow
      openCard(hit, "detection");
    } else if (state.card.open && !state.card.pinned) {
      scheduleHide(300);
    }
  }, { signal });
  stack.addEventListener("mouseleave", () => {
    if (state.card.open) scheduleHide(state.card.pinned ? 900 : 300);
  }, { signal });
  popover.addEventListener("mouseenter", cancelHide, { signal });
  popover.addEventListener("mouseleave", () => scheduleHide(state.card.pinned ? 900 : 300), { signal });

  function cancelHide() { clearTimeout(state.card.hideTimer); state.card.hideTimer = null; }
  function scheduleHide(ms) {
    cancelHide();
    state.card.hideTimer = later(closeCard, ms);
  }
  function closeCard() {
    cancelHide();
    state.card.open = false;
    state.card.pinned = false;
    state.card.claim = null;
    state.card.mode = null;
    popover.classList.remove("open");
  }

  function positionCard(claim) {
    const rects = state.hitRects.filter((h) => h.claim === claim).map((h) => h.rect);
    if (rects.length === 0) return;
    const anchor = rects[rects.length - 1];
    popover.classList.add("open");
    const cardW = popover.offsetWidth || 344;
    const cardH = popover.offsetHeight || 160;
    const stackW = stack.clientWidth;
    const cx = anchor.x + Math.min(anchor.w / 2, 120);
    let x = Math.max(0, Math.min(cx - cardW / 2, stackW - cardW));
    // below by default; flip above when the card would fall off the visible pane
    const stackTopInScroller = stack.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const visibleBottom = scroller.scrollTop + scroller.clientHeight - stackTopInScroller;
    const below = anchor.y + anchor.h + 10;
    const flip = below + cardH > visibleBottom && anchor.y - cardH - 10 > 0;
    const y = flip ? anchor.y - cardH - 10 : below;
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
    const tail = popover.querySelector(".ed-pop-tail");
    if (tail) {
      tail.className = `ed-pop-tail ${flip ? "bottom" : "top"}`;
      tail.style.left = `${Math.max(12, Math.min(cx - x - 6, cardW - 24))}px`;
    }
  }

  function cardShell() {
    popover.textContent = "";
    const tail = el("div", "ed-pop-tail top");
    const bodyEl = el("div", "ed-pop-body");
    popover.append(tail, bodyEl);
    return bodyEl;
  }

  function openCard(claim, mode) {
    state.card.open = true;
    state.card.claim = claim;
    state.card.mode = mode;
    state.card.pinned = mode === "searching" || mode === "results" || mode === "inserted" || mode === "compare";
    const bodyEl = cardShell();
    if (mode === "detection") renderDetection(bodyEl, claim);
    else if (mode === "searching") renderSearching(bodyEl);
    else if (mode === "results") renderResults(bodyEl, claim);
    else if (mode === "inserted") renderInserted(bodyEl, claim);
    else if (mode === "compare") renderCompare(bodyEl, claim);
    positionCard(claim);
  }

  /* — card state: detection — */
  function renderDetection(bodyEl, claim) {
    const mark = marks.markFor(claim.state);
    if (!mark) { closeCard(); return; }
    const info = marks.kindInfo(mark.kind);
    const head = el("div", "pop-head");
    const dot = el("span", "pop-dot");
    dot.style.background = markPaint(mark.color);
    head.append(dot, el("span", "pop-label", info?.label ?? mark.kind));
    bodyEl.appendChild(head);

    const noHits = claim.state.searched && claim.state.sources.count === 0;
    if (noHits) {
      // The empty-state rule: say WHAT was searched — never a zero score.
      const provs = claim.state.sources.providers?.length
        ? claim.state.sources.providers.join(", ")
        : "OpenAlex, Crossref, Semantic Scholar";
      bodyEl.appendChild(el("div", "pop-empty", `Searched ${provs} — nothing relevant.`));
    } else {
      bodyEl.appendChild(el("div", "pop-diag", diagnosisFor(claim, mark)));
    }

    const actions = el("div", "pop-actions");
    if (!noHits) {
      const find = el("button", "btn btn-primary", "Find sources");
      find.addEventListener("click", () => startSourceFlow(claim, false));
      actions.appendChild(find);
    } else {
      const again = el("button", "btn", "Search again");
      again.addEventListener("click", () => startSourceFlow(claim, true));
      actions.appendChild(again);
    }
    if (claim.critique?.suggestedRevision) {
      const fix = el("button", "btn", "Fix sentence");
      fix.addEventListener("click", () => fixSentence(claim));
      actions.appendChild(fix);
    }
    if (claim.state.hasOwnCitation) {
      const cmp = el("button", "btn", "Compare sources");
      cmp.addEventListener("click", () => startCompare(claim));
      actions.appendChild(cmp);
    }
    const dismiss = el("button", "btn btn-ghost", "Dismiss");
    dismiss.addEventListener("click", () => {
      claim.dismissed = true;
      state.dismissed.add(claim.id);
      closeCard();
      schedulePaint();
    });
    actions.appendChild(dismiss);
    bodyEl.appendChild(actions);
  }

  function diagnosisFor(claim, mark) {
    if (claim.critique?.critique) {
      // A malformed-but-real reference comes back corrected; show the fix
      // under the reasoning so the writer can copy it.
      return claim.critique.citationFix
        ? `${claim.critique.critique}\n\nCorrected reference: ${claim.critique.citationFix}`
        : claim.critique.critique;
    }
    const s = claim.state;
    switch (mark.kind) {
      case "citation-defect": return `The citation looks incomplete: ${(s.citationDefects ?? []).join("; ") || "a required part is missing"}.`;
      case "missing-citation": return "This looks checkable and citable, but the sentence carries no citation.";
      case "outside-index": return "This claim's territory isn't covered by the scholarly indexes searched — it needs a hand-checked source.";
      case "weak-evidence": return "What the search found only weakly matches what this sentence says.";
      case "partial-evidence": return "The evidence found supports part of this sentence, but not all of it.";
      case "unverified-statistic": return "A number this specific needs a source the check could actually verify.";
      case "no-sources": return "No supporting sources turned up for this claim.";
      default: return marks.kindInfo(mark.kind)?.label ?? "This sentence needs attention.";
    }
  }

  /* — card state: searching → results — */
  async function startSourceFlow(claim, cacheBust) {
    openCard(claim, "searching"); // pins the card
    if (!cacheBust && claim.sources.length > 0) {
      openCard(claim, "results");
      return;
    }
    let query = claim.query ?? claim.text;
    if (cacheBust) {
      // cache-busted re-run: append a refinement word drawn from the claim
      const q = String(query).toLowerCase();
      const refine = claim.text.split(/\W+/).filter((w) => w.length > 4 && !q.includes(w.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
      query = refine ? `${query} ${refine}` : `${query} evidence`;
    }
    try {
      const res = await api.evidence({ claim: claim.text, query, claimType: claim.claimType });
      if (!state.card.open || state.card.claim !== claim) return;
      claim.sources = res.sources ?? [];
      const searched = res.searched ?? {};
      if (claim.state.status === "checked") {
        claim.state.sources = {
          count: claim.sources.length,
          aboveFloor: searched.aboveFloor ?? 0,
          citableAboveFloor: searched.citableAboveFloor ?? 0,
          providers: searched.providers ?? claim.state.sources.providers,
        };
        claim.state.strength = res.strength ?? claim.state.strength;
        claim.state.outsideIndex = Boolean(searched.outsideIndex);
      }
      schedulePaint();
      openCard(claim, claim.sources.length ? "results" : "detection");
    } catch (e) {
      ctx.toast(`Source search failed: ${e.message}`, true);
      if (state.card.claim === claim) openCard(claim, "detection");
    }
  }

  function renderSearching(bodyEl) {
    bodyEl.appendChild(el("div", "pop-label", "Searching sources…"));
    for (let i = 0; i < 3; i++) bodyEl.appendChild(el("div", "pop-skel"));
  }

  function renderResults(bodyEl, claim) {
    const head = el("div", "pop-head");
    const mark = marks.markFor(claim.state);
    const dot = el("span", "pop-dot");
    dot.style.background = markPaint(mark ? mark.color : "grey");
    head.append(dot, el("span", "pop-label", `${claim.sources.length} source${claim.sources.length === 1 ? "" : "s"} found`));
    bodyEl.appendChild(head);

    // style pills switch the preview
    const styles = el("div", "pop-styles");
    const preview = el("div", "pop-preview");
    let selected = claim.sources[0] ?? null;
    const setPreview = () => {
      if (!selected) { preview.textContent = ""; return; }
      preview.textContent = cite.formatCitation(normalizeSource(selected), state.card.style).entry;
    };
    for (const st of ["apa", "mla", "chicago"]) {
      const b = el("button", `pop-style${state.card.style === st ? " on" : ""}`, st.toUpperCase());
      b.addEventListener("click", () => {
        state.card.style = st;
        for (const x of styles.children) x.classList.toggle("on", x === b);
        setPreview();
      });
      styles.appendChild(b);
    }
    bodyEl.appendChild(styles);

    const list = el("div", "pop-srcs");
    for (const [i, src] of claim.sources.entries()) {
      const row = el("div", "pop-src");
      row.style.animationDelay = `${Math.min(i, 6) * 60}ms`; // fade-slide stagger
      const domain = hostOf(src.url ?? src.oaUrl ?? "");
      if (domain) {
        const img = document.createElement("img");
        img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
        img.alt = "";
        img.addEventListener("error", () => img.remove());
        row.appendChild(img);
      }
      const main = el("div", "pop-src-main");
      main.appendChild(el("div", "pop-src-title", src.title ?? "Untitled"));
      const meta = el("div", "pop-src-meta");
      meta.appendChild(el("span", null, [src.venue, src.year].filter(Boolean).join(" · ") || (src.provider ?? "")));
      if (src.venueType) meta.appendChild(el("span", "pop-chip", src.venueType));
      if (typeof src.relevance === "number") meta.appendChild(el("span", "pop-match", `${Math.round(src.relevance * 100)}% match`));
      main.appendChild(meta);
      row.appendChild(main);
      const btns = el("div", "pop-src-btns");
      const use = el("button", "btn btn-primary", "Use");
      use.addEventListener("click", () => insertCitation(claim, src));
      const save = el("button", "btn", "Save to library");
      save.addEventListener("click", async () => {
        try {
          const r = await api.library.add({ source: normalizeSource(src), note: "" });
          ctx.toast(r.duplicate ? "Already in your library" : "Saved to library");
        } catch (e) { ctx.toast(`Could not save: ${e.message}`, true); }
      });
      btns.append(use, save);
      row.appendChild(btns);
      row.addEventListener("mouseenter", () => { selected = src; setPreview(); });
      list.appendChild(row);
    }
    bodyEl.appendChild(list);
    setPreview();
    bodyEl.appendChild(preview);

    const actions = el("div", "pop-actions");
    const again = el("button", "btn", "Search again");
    again.addEventListener("click", () => startSourceFlow(claim, true));
    const close = el("button", "btn btn-ghost", "Close");
    close.addEventListener("click", closeCard);
    actions.append(again, close);
    bodyEl.appendChild(actions);
  }

  function normalizeSource(src) {
    return {
      id: src.id, doi: src.doi, title: src.title, authors: src.authors ?? [],
      year: src.year, venue: src.venue, venueType: src.venueType,
      url: src.url, abstract: src.abstract, provider: src.provider, oaUrl: src.oaUrl,
    };
  }

  /* — inserting a citation ————————————————————————————————————————————
     Both halves go through the browser undo stack via execCommand insertText
     at collapsed selections. A single execCommand cannot write two separate
     document positions, so this is a documented TWO-STEP undo: the first
     Ctrl+Z removes the works-cited entry, the second removes the in-text
     marker (the card's Undo button performs both). */
  /** Map the user's current caret (selection anchor) to a canonical offset
      in `index`, or null when it cannot be recovered. */
  function caretOffsetIn(index) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const { anchorNode, anchorOffset } = sel;
    if (!anchorNode || !edDoc.contains(anchorNode)) return null;
    if (anchorNode.nodeType === Node.TEXT_NODE) {
      for (const seg of index.segments) {
        if (seg.node === anchorNode) {
          return seg.start + Math.max(0, Math.min(anchorOffset, seg.end - seg.start));
        }
      }
      return null;
    }
    if (anchorNode.nodeType === Node.ELEMENT_NODE) {
      // Element anchor: walk to the child text position.
      const child = anchorNode.childNodes[anchorOffset] ?? null;
      if (child) {
        for (const seg of index.segments) {
          if (child === seg.node || child.contains(seg.node)) return seg.start;
        }
        return null; // child holds no text (e.g. <br>) — unmappable, bail
      }
      // Offset past the last child: end of the element's own text content.
      let last = null;
      for (const seg of index.segments) {
        if (anchorNode.contains(seg.node)) last = seg;
      }
      return last ? last.end : null;
    }
    return null;
  }

  function insertCitation(claim, src) {
    const fmt = cite.formatCitation(normalizeSource(src), state.card.style);
    const index = buildTextIndex(edDoc);
    const text = index.text;
    const sent = anchorSpan(text, claim.sentence, claim.start) ?? anchorSpan(text, claim.text, claim.start);
    if (!sent) { ctx.toast("Couldn't find the sentence to cite — it may have changed.", true); return; }

    // Remember where the user was writing so we can put them back there.
    const savedOffset = caretOffsetIn(index);

    // 1) in-text marker right after the sentence, before terminal punctuation
    let at = sent.end;
    while (at > sent.start && /[\s"'’”)\]]/.test(text[at - 1])) at--;
    if (at > sent.start && /[.!?…]/.test(text[at - 1])) at--;
    const marker = (at > 0 && !/\s/.test(text[at - 1]) ? " " : "") + fmt.inText;
    if (!placeCaretAt(index, at)) { ctx.toast("Couldn't place the citation.", true); return; }
    document.execCommand("insertText", false, marker);

    // 2) works-cited entry appended under a trailing "Works Cited" block
    const after = buildTextIndex(edDoc);
    const hasBlock = /(^|\n)\s*works cited\s*(\n|$)/i.test(after.text);
    const sel = window.getSelection();
    const endRange = document.createRange();
    endRange.selectNodeContents(edDoc);
    endRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(endRange);
    document.execCommand("insertText", false, hasBlock ? `\n${fmt.entry}` : `\n\nWorks Cited\n${fmt.entry}`);

    // 3) restore the user's caret — the two inserts left it at the very end
    //    of the Works Cited block, where resumed typing would corrupt the
    //    bibliography. Offsets at/after the marker insertion point shifted by
    //    the FULL marker length (optional leading space + in-text form); the
    //    works-cited entry went to the document end and shifts nothing.
    const restored = buildTextIndex(edDoc);
    const target = savedOffset != null
      ? (savedOffset >= at ? savedOffset + marker.length : savedOffset)
      : at + marker.length; // no recoverable caret — sit just after the marker
    if (!placeCaretAt(restored, target)) {
      // Mapped node vanished — collapse after the freshly inserted marker
      // rather than silently leaving the caret in the bibliography.
      const mspan = anchorSpan(restored.text, fmt.inText, at);
      if (mspan) placeCaretAt(restored, mspan.end);
    }

    // the sentence now carries its own citation — the mark must not linger
    if (claim.state.status === "checked") {
      claim.state.hasOwnCitation = true;
      claim.state.citationDefects = [];
    }
    claim.insertedEntry = fmt.entry;
    state.card.insertArmed = true; // two-step Undo is valid until the user types
    saveBody();
    schedulePaint();
    openCard(claim, "inserted"); // pinned — confirmation state
  }

  function placeCaretAt(index, offset) {
    const range = rangeForOffsets(index, offset, offset);
    if (!range) return false;
    edDoc.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    range.collapse(true);
    sel.addRange(range);
    return true;
  }

  function renderInserted(bodyEl, claim) {
    const head = el("div", "pop-head");
    head.append(el("span", "pop-ok", "✓"), el("span", "pop-label", "Citation inserted"));
    bodyEl.appendChild(head);
    bodyEl.appendChild(el("div", "pop-diag", "Added the in-text citation and its works-cited entry."));
    bodyEl.appendChild(el("div", "pop-entry", claim.insertedEntry ?? ""));
    const actions = el("div", "pop-actions");
    const copy = el("button", "btn", "Copy entry");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(claim.insertedEntry ?? ""); ctx.toast("Entry copied"); }
      catch { ctx.toast("Copy failed — select the text manually", true); }
    });
    const undo = el("button", "btn", "Undo");
    // The two-step undo is only valid while the top two undo entries are still
    // the works-cited entry and the in-text marker. Any typing after insertion
    // pushes new entries — blind undos would then destroy the user's writing
    // while leaving the citation. Disarm the button the moment input occurs.
    const disarmUndo = () => {
      undo.disabled = true;
      undo.title = "Undo unavailable — document changed since the citation was inserted";
    };
    if (!state.card.insertArmed) disarmUndo();
    else edDoc.addEventListener("input", disarmUndo, { once: true, signal });
    undo.addEventListener("click", () => {
      if (!state.card.insertArmed) { disarmUndo(); return; }
      state.card.insertArmed = false;
      edDoc.focus();
      document.execCommand("undo"); // works-cited entry
      document.execCommand("undo"); // in-text marker (two-step: see insertCitation)
      if (claim.state.status === "checked") claim.state.hasOwnCitation = cite.hasOwnCitation(claim.sentence);
      saveBody();
      closeCard();
      schedulePaint();
    });
    const done = el("button", "btn btn-ghost", "Done");
    done.addEventListener("click", closeCard);
    actions.append(copy, undo, done);
    bodyEl.appendChild(actions);
  }

  /* — fix sentence (critique revision, one undo step) — */
  function fixSentence(claim) {
    const revision = claim.critique?.suggestedRevision;
    if (!revision) return;
    const index = buildTextIndex(edDoc);
    const sent = anchorSpan(index.text, claim.sentence, claim.start);
    if (!sent) { ctx.toast("Couldn't find the sentence — it may have changed.", true); return; }
    const range = rangeForOffsets(index, sent.start, sent.end);
    if (!range) return;
    edDoc.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, revision);
    claim.sentence = revision;
    claim.text = revision;
    saveBody();
    closeCard();
    schedulePaint();
  }

  /* — compare sources: writer's citation vs what search recommends — */
  async function startCompare(claim) {
    const citedRef = lastParenRef(claim.sentence) ?? claim.sentence;
    openCard(claim, "compare"); // pinned
    const bodyEl = popover.querySelector(".ed-pop-body");
    bodyEl.textContent = "";
    bodyEl.appendChild(el("div", "pop-label", "Comparing sources…"));
    for (let i = 0; i < 2; i++) bodyEl.appendChild(el("div", "pop-skel"));
    let result = null;
    try {
      result = await api.compareSource({ citedRef });
    } catch { result = null; }
    if (!state.card.open || state.card.claim !== claim || state.card.mode !== "compare") return;
    claim.compareResult = result;
    const fresh = cardShell();
    renderCompare(fresh, claim);
    positionCard(claim);
  }

  function renderCompare(bodyEl, claim) {
    bodyEl.appendChild(el("div", "pop-label", "Your source vs. search"));
    const grid = el("div", "pop-compare");

    const yours = el("div", "pop-compare-col");
    yours.appendChild(el("div", "eyebrow", "You cited"));
    const r = claim.compareResult;
    // compareSource returns { matches: [...], resolved: <boolean>, resolvedNote? }:
    // `resolved` says WHETHER the lookup matched; the match itself is matches[0].
    const best = r?.resolved ? (r.matches?.[0] ?? null) : null;
    if (best) {
      yours.appendChild(el("div", "t", best.title ?? "Untitled"));
      const metaBits = [best.venue, best.year].filter(Boolean).join(" · ");
      const meta = el("div", "m", metaBits);
      if (typeof best.relevance === "number") {
        meta.appendChild(el("span", "pop-match", `${metaBits ? " · " : ""}${Math.round(best.relevance * 100)}% match`));
      }
      yours.appendChild(meta);
    } else {
      // NEVER "your source is fake" — a failed lookup is a scope statement.
      yours.appendChild(el("div", "m", r?.resolvedNote ?? "Couldn't resolve — journals and books only."));
    }
    grid.appendChild(yours);

    const rec = el("div", "pop-compare-col");
    rec.appendChild(el("div", "eyebrow", "Search recommends"));
    const top = (claim.sources ?? [])[0];
    if (top) {
      rec.appendChild(el("div", "t", top.title ?? "Untitled"));
      rec.appendChild(el("div", "m", [top.venue, top.year].filter(Boolean).join(" · ")));
    } else {
      rec.appendChild(el("div", "m", "No recommendation yet — run Find sources."));
    }
    grid.appendChild(rec);
    bodyEl.appendChild(grid);

    const actions = el("div", "pop-actions");
    const back = el("button", "btn btn-ghost", "Back");
    back.addEventListener("click", () => openCard(claim, "detection"));
    const close = el("button", "btn btn-ghost", "Close");
    close.addEventListener("click", closeCard);
    actions.append(back, close);
    bodyEl.appendChild(actions);
  }

  /* ── AI Insights (grading — button-triggered ONLY) ─────────────────────── */
  insightsBtn.addEventListener("click", async () => {
    if (state.grading) return;
    const text = editorText();
    if (text.trim().length < 40) { ctx.toast("Write a little more before grading.", true); return; }
    state.grading = true;
    insightsBtn.disabled = true;
    insightsBtn.textContent = "Analyzing…";
    try {
      const level = settings.gradingLevel ?? 12;
      // A pasted rubric (Settings → Custom rubric) replaces the built-in one.
      const customRubric = String(settings.customRubric ?? "").trim();
      const res = await api.grade({ draft: text, level, model: settings.model, rubric: customRubric || undefined });
      const custom = res.custom === true && Array.isArray(res.components);
      // The built-in grade is the desktop's rubric grader now: six components
      // as {score, quote, reason}, with counterargument's applicability as its
      // own flag. The report and rubric.js read {score, quote, note, absent},
      // so it is mapped here rather than taught a second shape in two files.
      const components = custom ? (res.components ?? []) : fromRubricGrade(res);

      // Verify EVERY component quote exists verbatim in the draft.
      const haystack = normWs(text);
      for (const key of Object.keys(components)) {
        const comp = components[key];
        if (!comp || typeof comp.quote !== "string" || !comp.quote.trim()) continue;
        if (!haystack.includes(normWs(comp.quote))) {
          delete comp.quote;
          comp.note = `${comp.note ? comp.note + " " : ""}(quote could not be verified)`;
        }
      }

      const rubricScore = custom
        ? rubric.sumCustomComponents(components)
        : rubric.sumComponents(components);
      const grade = rubric.applyGradeLevel(rubricScore, level);

      const flags = state.claims
        .filter((c) => !c.dismissed && c.state.status === "checked")
        .map((c) => ({ c, mark: marks.markFor(c.state) }))
        .filter(({ mark }) => mark && mark.kind !== "searching")
        .map(({ c, mark }) => ({
          kind: mark.kind,
          label: mark.label,
          clause: rubric.FLAG_CLAUSES[mark.kind]?.clause ?? "",
          sentence: c.sentence,
        }));

      const meta = {
        title: nameInput.value.trim() || "Untitled",
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
      };
      showReport({ grade: { components, custom, ...grade }, flags, meta });

      await api.documents.update(docId, { gradeLetter: grade.letter, gradeScore: grade.total }).catch(() => {});
      await api.analyses.create({
        documentId: docId,
        sourceText: text,
        gradeJson: { components, custom, ...grade, flags },
      }).catch(() => {});
    } catch (e) {
      ctx.toast(`Grading failed: ${e.message}`, true);
    } finally {
      state.grading = false;
      insightsBtn.disabled = false;
      insightsBtn.textContent = "AI Insights";
    }
  });

  /* ── structure rail ── */
  let railOpen = false;
  structBtn.addEventListener("click", async () => {
    railOpen = !railOpen;
    rail.classList.toggle("open", railOpen);
    if (!railOpen) return;
    railInner.textContent = "";
    const h = el("h3", null, "Structure");
    railInner.append(h, el("div", "an-rail-empty", "Reading the draft…"));
    try {
      const res = await api.structure(editorText());
      if (!railOpen || !root.isConnected) return;
      railInner.textContent = "";
      railInner.appendChild(h);
      const paras = res.paragraphs ?? [];
      if (paras.length === 0) {
        railInner.appendChild(el("div", "an-rail-empty", "No paragraphs to classify yet."));
        return;
      }
      for (const p of paras) {
        const box = el("div", "an-para");
        const line = el("div");
        // 1-based now: the classifier numbers paragraphs the way the desktop
        // prompt does, [1] first.
        line.append(el("span", "idx", `¶${p.index ?? "?"} `), el("span", "role", p.role ?? "paragraph"));
        box.appendChild(line);
        for (const f of structureFaults(p)) box.appendChild(el("span", "an-fault", f));
        railInner.appendChild(box);
      }
    } catch (e) {
      if (!railOpen) return;
      railInner.textContent = "";
      railInner.append(h, el("div", "an-rail-empty", `Structure unavailable: ${e.message}`));
    }
  }, { signal });

  /* ── first paint + first detection pass over a loaded document ── */
  schedulePaint();
  if (editorText().length >= GUARDS.detect.minChars) scheduleDetect();
  edDoc.focus();
}
