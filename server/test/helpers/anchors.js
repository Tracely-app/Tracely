/* The comment and code lines server/test slices the extension (and two server
 * files) by. Each must occur EXACTLY ONCE in its file: indexOf of a moved or
 * renamed marker returns -1 and the test quietly slices the wrong region.
 * ext-anchors.test.js checks every entry; sliceBetween() is for new tests.
 *
 * Generated 2026-10-07 from the markers used two or more times across the
 * suite. Add a marker here when a new test slices by it; drop one only
 * together with the tests that use it. In content.js the eight most-used
 * carry a "TEST ANCHOR" comment on the line above. */
export const ANCHORS = {
  "extension/background.js": [
    "async function withBeta", // used by 2 slices
  ],
  "extension/content.js": [
    "  // Bibliography block", // used by 17 slices
    "  function esc(", // used by 15 slices
    "  function wireChrome(", // used by 9 slices
    "function fieldMode()", // used by 5 slices
    "  const ISSUE_VERDICTS =", // used by 5 slices
    "  /* Card titles", // used by 5 slices
    "function docsMode()", // used by 3 slices
    "  const MARK_PATTERN =", // used by 2 slices
    "  const MARK_LINE_RADIUS", // used by 2 slices
    "    function svgLocate(issues) {", // used by 2 slices
    // ext-type-preview.test.js: the Type preview block, its gate, and what it reuses.
    "    /* ── editing the document ──",
    "    // (the bridge \"highlight in doc\" feature was removed",
    "    const TP_GLIDE_MS",
    "    const TP_TOKEN =",
    "    function tpNotePress(",
    "    if (FEATURES.typePreview) {",
    "    // ── widget UI ──",
    "    const nrm = (s) =>",
    "    /* Bars are carried by the COMPOSITOR",
    "    function svgRangeRects(",
    "    function barTextRect(b) {",
    "    // A sentence we just rewrote",
    "    const DM = { // index.css .docmark-*",
    "    /* A hint-styled control",
    "  const REF_HEADINGS =",
    "  // ── citation formatting ──",
    "    async function runDocEdit(key, job) {",
    "    async function undoLastDocEdit() {",
    "    // A repeated sentence from the panel",
  ],
  "server/server.js": [
    "async function spendGate(", // used by 2 slices
    "const WORST_CALL = {", // used by 2 slices
  ],
};

/** The text of `src` between two anchors, throwing with the anchor's name when one is missing or repeated. */
export function sliceBetween(src, from, to, { file = "content.js" } = {}) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`${file}: anchor not found: ${JSON.stringify(from)} (renamed or moved? see server/test/helpers/anchors.js)`);
  if (src.indexOf(from, a + 1) >= 0) throw new Error(`${file}: anchor is not unique: ${JSON.stringify(from)}`);
  const b = to == null ? src.length : src.indexOf(to, a);
  if (b < 0) throw new Error(`${file}: anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return src.slice(a, b);
}
