/* Tracely — in-editor edit engine for Google Docs (PROTOTYPE, not committed).

   Intended home: extension/docs-hook.js (MAIN world, document_start), as a
   second IIFE after the canvas hook. It needs no manifest change, no Docs API,
   no OAuth: every edit is made by the user's own open editor, through the same
   input paths a person uses (a paste into kix's text-event iframe), and is
   READ BACK before it is reported as done.

   Protocol (window.postMessage, same as tracely-docs-locate):
     in : { type: "tracely-docs-edit", id, op, ...args }
     out: { type: "tracely-docs-edit-result", id, ok, reason?, ...detail }

   ops
     probe                               → { api, mode, viewOnly, status }
     replace     { find, replacement, occurrence?, rects?, html?, dryRun? }
     insertAfter { find, text,        occurrence?, rects?, html?, dryRun? }
     appendLine  { line, dryRun? }
     undo        { tokens: [newest, …] }  (tokens come back on every ok edit)

   Safety rules (each one is load-bearing):
     1. Target by TEXT, confirm by TEXT. The target range is found in Docs' own
        model text (_docs_annotate_getAnnotatedText → getText()), selected by
        offset, and the selection is re-read (getSelection + slice, and a
        synthetic copy readback when available) BEFORE anything is typed. Any
        disagreement aborts; nothing is typed over a selection we did not
        verify.
     2. Locate → select → verify → paste happen in ONE synchronous block, so no
        user keystroke or remote change can land between the check and the
        edit (JS is single-threaded; input events queue behind us).
     3. The edit is the SMALLEST token-aligned change (common prefix/suffix
        kept), so formatting, links and comment anchors outside the changed
        words survive, and the undo step is small.
     4. Success means the model text now reads as expected. A silent no-op
        (view-only, locked/offline editor) or a partial change is reported as
        failure, and content.js falls back to Copy.
     5. The user's selection is restored (shifted by the edit), and their view
        never moves: kix smooth-scrolls to every setSelection, so its
        programmatic scrollTop writes are swallowed while an op runs (user
        scrolling is native and unaffected).
*/
(() => {
  "use strict";
  if (window.__tracelyDocsEdit) return;
  window.__tracelyDocsEdit = "proto-1";

  const REQUESTER = "tracely"; // same value docs-hook.js sets as _docs_annotate_canvas_by_ext
  const MSG_IN = "tracely-docs-edit";
  const MSG_OUT = "tracely-docs-edit-result";
  const APPLY_WAIT_MS = 1500; // paste lands in ~40ms; this is the "it never landed" bound
  const UNDO_WAIT_MS = 1200;
  const CTX = 24; // normalized chars of context used to re-find an edit later
  const MAX_FIND = 4000;

  // Harness-only guard: window.__tracelyEditConfig = { allowEdits: false }
  // makes every non-dry op refuse. Production never sets it.
  const cfg = () => (window.__tracelyEditConfig && typeof window.__tracelyEditConfig === "object" ? window.__tracelyEditConfig : {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  /* ── Docs handles ────────────────────────────────────────────────────── */

  let atCache = null;
  async function getAT(noApi) {
    if (noApi) return null;
    if (atCache) {
      try { if (typeof atCache.getText() === "string") return atCache; } catch { /* stale */ }
      atCache = null;
    }
    const fn = window._docs_annotate_getAnnotatedText;
    if (typeof fn !== "function") return null;
    try {
      const at = await Promise.race([Promise.resolve(fn(REQUESTER)), sleep(2500).then(() => null)]);
      if (at && ["getText", "getSelection", "setSelection"].every((k) => typeof at[k] === "function")) {
        atCache = at;
        return at;
      }
    } catch { /* API absent or changed shape */ }
    return null;
  }

  function target() {
    const fr = document.querySelector(".docs-texteventtarget-iframe");
    let d = null;
    try { d = fr && fr.contentDocument; } catch { d = null; }
    return (d && d.querySelector("[contenteditable]")) || null;
  }
  const editorEl = () => document.querySelector(".kix-appview-editor");

  function editorMode() {
    const label = (document.getElementById("docs-toolbar-mode-switcher")?.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("suggest")) return "suggesting";
    if (label.includes("edit")) return "editing";
    if (label.includes("view")) return "viewing";
    return "unknown";
  }
  // Best-effort hint only — the read-back after the edit is the real test.
  function viewOnlyHint() {
    if (editorMode() === "viewing") return true;
    const els = document.querySelectorAll("#docs-titlebar-container [aria-label], .docs-titlebar-badges *, #docs-toolbar-wrapper [aria-label]");
    for (const el of els) {
      const t = ((el.getAttribute && el.getAttribute("aria-label")) || el.textContent || "").trim().toLowerCase();
      if (t === "view only" || t.startsWith("view only")) return true;
    }
    return false;
  }
  const docStatus = () => document.querySelector('[aria-label^="Document status"]')?.getAttribute("aria-label") || "";

  /* ── synthetic input (the only way anything reaches the document) ───── */

  function paste(text, html) {
    const ce = target();
    if (!ce) return false;
    const W = ce.ownerDocument.defaultView;
    const dt = new W.DataTransfer();
    dt.setData("text/plain", text);
    if (html) dt.setData("text/html", html);
    ce.dispatchEvent(new W.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    return true;
  }

  // Docs fills our own DataTransfer on a synthetic copy; the system clipboard
  // is never touched. null = unverifiable (e.g. copy disabled for viewers).
  function copyReadback() {
    const ce = target();
    if (!ce) return null;
    try {
      const W = ce.ownerDocument.defaultView;
      const dt = new W.DataTransfer();
      const ev = new W.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
      ce.dispatchEvent(ev);
      const txt = dt.getData("text/plain");
      return ev.defaultPrevented || txt ? txt : null;
    } catch {
      return null;
    }
  }

  // kix ignores key events whose legacy keyCode is 0 for control keys, so it
  // is forced via defineProperty (measured: without it nothing happens).
  function keyEv(type, key, code, keyCode, mods = {}) {
    const ce = target();
    if (!ce) return false;
    const W = ce.ownerDocument.defaultView;
    const e = new W.KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true, key, code, view: W,
      shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt,
    });
    Object.defineProperty(e, "keyCode", { get: () => keyCode });
    Object.defineProperty(e, "which", { get: () => keyCode });
    return ce.dispatchEvent(e);
  }
  function press(key, code, keyCode, mods) {
    keyEv("keydown", key, code, keyCode, mods);
    keyEv("keyup", key, code, keyCode, mods);
  }
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
  const undoKey = () => press("z", "KeyZ", 90, IS_MAC ? { meta: true } : { ctrl: true });
  const redoKey = () => (IS_MAC ? press("z", "KeyZ", 90, { meta: true, shift: true }) : press("y", "KeyY", 89, { ctrl: true }));
  const backspace = () => press("Backspace", "Backspace", 8);

  // Synthetic mouse, only ever onto the page surface of the editor — never
  // onto a toolbar, dialog, comment, or our own widget covering the page.
  // kix's own caret (.kix-cursor-caret — measured sitting ON TOP of the text
  // at the caret position), collaborator cursors and selection overlays are
  // seen through; anything else on top (dialog, menu, our widget) refuses.
  const SEE_THROUGH = ".kix-cursor, .kix-cursor-caret, .kix-selection-overlay, .kix-canvas-tile-selection, .docs-text-ui-cursor";
  function hitEditor(x, y) {
    if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) return null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (!el.closest || !el.closest(".kix-appview-editor")) return null;
      if (el.closest(SEE_THROUGH)) continue;
      if (el.tagName === "CANVAS" || el.closest(".kix-page-paginated, .kix-page, .kix-canvas-tile-content")) return el;
      return null;
    }
    return null;
  }
  function clickAt(x, y, mods = {}) {
    const el = hitEditor(x, y);
    if (!el) return false;
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
        button: 0, buttons: type === "mousedown" ? 1 : 0, detail: 1, shiftKey: !!mods.shift,
      }));
    }
    return true;
  }

  /* ── text normalization with an index map back to raw model offsets ─── */
  // Folds what can legitimately differ between the export text content.js
  // segmented, the model text, and a model-written replacement: zero-width
  // chars (Docs keeps U+200B in text), NBSP/whitespace runs, smart quotes,
  // dashes, ellipsis. Control/private-use chars (U+0003 doc sentinels, table
  // and object markers) become a hard "\n" boundary a sentence can't span.
  const DROP = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/;
  const SPACE = /[ \t\u000b\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
  const FOLD = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
    "…": "...",
  };
  function normMap(s) {
    let n = "";
    const map = [];
    let ws = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const code = c.charCodeAt(0);
      if (DROP.test(c)) continue;
      if (SPACE.test(c)) {
        if (ws < 0 && n.length && n[n.length - 1] !== "\n") ws = i;
        continue;
      }
      if (code < 32 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029 || (code >= 0xe000 && code <= 0xf8ff)) {
        ws = -1;
        n += "\n";
        map.push(i);
        continue;
      }
      if (ws >= 0) { n += " "; map.push(ws); ws = -1; }
      const f = FOLD[c];
      if (f) for (const ch of f) { n += ch; map.push(i); }
      else { n += c; map.push(i); }
    }
    return { n, map };
  }
  const nrm = (s) => normMap(String(s)).n;
  const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const WORDCH = /[\p{L}\p{N}\p{M}]/u;
  function goodMatch(N, map, a, b) {
    if (a > 0 && WORDCH.test(N[a]) && WORDCH.test(N[a - 1])) return false; // mid-word start
    if (b < N.length && WORDCH.test(N[b - 1]) && WORDCH.test(N[b])) return false; // mid-word end
    if (a > 0 && map[a - 1] === map[a]) return false; // inside a folded expansion ("…")
    if (b < map.length && map[b] === map[b - 1]) return false;
    return true;
  }
  // loose = context probes (they start/end mid-word by construction), so
  // only the expansion rule applies, not the word-boundary rule.
  function findAll(N, map, needle, loose) {
    const out = [];
    if (!needle) return out;
    let i = N.indexOf(needle);
    while (i >= 0 && out.length < 50) {
      if (loose || goodMatch(N, map, i, i + needle.length)) out.push(i);
      i = N.indexOf(needle, i + 1);
    }
    return out;
  }
  // The txt export writes list bullets/numbers into the line ("* claim.",
  // "2. claim."); the model text does not. Strip one such marker on retry.
  const LIST_MARK = /^(?:[*•◦▪‣·-]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxlcdm]{1,6}[.)])\s+/;

  /* ── minimal token-aligned diff ──────────────────────────────────────── */
  const TOK = /\s+|[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*|[\s\S]/gu;
  const isWs = (t) => /^\s+$/.test(t);
  // Returns normalized [oa,ob) in old and [na,nb) in new such that
  // old[0,oa)==new[0,na) and old[ob,)==new[nb,). Widened until NEITHER middle
  // starts/ends with whitespace (Docs trims pasted edge spaces — the forward
  // paste and the undo paste must both survive that) and neither is empty
  // (so every edit is "select something, paste something": one undo step).
  function planDiff(oldN, newN) {
    const A = oldN.match(TOK) || [];
    const B = newN.match(TOK) || [];
    let P = 0;
    while (P < A.length && P < B.length && A[P] === B[P]) P++;
    let S = 0;
    while (S < A.length - P && S < B.length - P && A[A.length - 1 - S] === B[B.length - 1 - S]) S++;
    for (let guard = 0; guard < 1000; guard++) {
      const om = A.slice(P, A.length - S);
      const nm = B.slice(P, B.length - S);
      const wsHead = (om.length && isWs(om[0])) || (nm.length && isWs(nm[0]));
      const wsTail = (om.length && isWs(om[om.length - 1])) || (nm.length && isWs(nm[nm.length - 1]));
      if (wsHead && P > 0) { P--; continue; }
      if (wsTail && S > 0) { S--; continue; }
      if ((!nm.length && B.length) || (!om.length && A.length)) {
        if (S > 0) { S--; continue; }
        if (P > 0) { P--; continue; }
      }
      break;
    }
    const L = (arr) => arr.reduce((k, t) => k + t.length, 0);
    return {
      oa: L(A.slice(0, P)), ob: oldN.length - L(A.slice(A.length - S)),
      na: L(B.slice(0, P)), nb: newN.length - L(B.slice(B.length - S)),
    };
  }

  /* ── selection bookkeeping ───────────────────────────────────────────── */
  function readSel(at) {
    try {
      const s = at.getSelection();
      return Array.isArray(s) ? s.map((r) => ({ start: r.start, end: r.end })) : null;
    } catch {
      return null;
    }
  }
  function selIs(at, s, e) {
    const sel = readSel(at);
    return !!sel && sel.length === 1 && sel[0].start === s && sel[0].end === e;
  }
  function mapPos(p, s, e, ins) {
    if (p <= s) return p;
    if (p >= e) return p + ins - (e - s);
    return s + ins;
  }
  /* ── view lock ───────────────────────────────────────────────────────── */
  // kix animates the view to EVERY new selection by writing
  // .kix-appview-editor.scrollTop for ~250ms (measured: 8-9 writes, last at
  // ~250ms; setSelection(start,end) has no no-scroll option; restoring the old
  // selection does not scroll back). So while an op runs, kix's programmatic
  // writes on that one element are swallowed. The user's own scrolling (wheel,
  // touch, scrollbar) is native and never goes through this setter, so it is
  // never fought; the lock lifts once kix has been quiet for 300ms.
  const SCROLL_DESC = typeof Element !== "undefined" ? Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") : null;
  let viewLock = null;
  function lockView() {
    const ed = editorEl();
    if (viewLock || !ed || !SCROLL_DESC || !SCROLL_DESC.set) return false;
    const L = { ed, last: now(), swallowed: 0 };
    try {
      Object.defineProperty(ed, "scrollTop", {
        configurable: true,
        get() { return SCROLL_DESC.get.call(this); },
        set() { L.last = now(); L.swallowed++; },
      });
    } catch { return false; }
    viewLock = L;
    return true;
  }
  async function unlockView() {
    const L = viewLock;
    if (!L) return 0;
    const t0 = now();
    while (now() - L.last < 300 && now() - t0 < 2000) await sleep(50);
    try { delete L.ed.scrollTop; } catch { /* ignore */ }
    viewLock = null;
    return L.swallowed;
  }

  function restoreUser(at, saved, edit, scroll) {
    let restored = false;
    if (at && saved && saved.length) {
      const r = saved[0];
      let a = r.start, b = r.end;
      if (edit) { a = mapPos(a, edit.s, edit.e, edit.ins); b = mapPos(b, edit.s, edit.e, edit.ins); }
      try { at.setSelection(a, b); restored = selIs(at, a, b); } catch { /* ignore */ }
    }
    const ed = editorEl();
    if (!viewLock && ed && scroll != null) {
      // Fallback only (lock unavailable): snap back after kix's animation.
      const fix = () => { if (Math.abs(ed.scrollTop - scroll) > 1) ed.scrollTop = scroll; };
      for (const ms of [0, 120, 260, 400]) setTimeout(fix, ms);
    }
    return restored;
  }

  /* ── locating a sentence ─────────────────────────────────────────────── */

  // Offset of the caret a click at (x,y) produces — used ONLY to choose among
  // several identical matches; the caller restores the selection afterwards.
  function caretAtPoint(at, x, y) {
    if (!clickAt(x, y)) return null;
    const sel = readSel(at);
    return sel && sel.length ? sel[0].start : null;
  }

  // Pure: every acceptable match of `find` in model text T.
  function matchText(T, find) {
    const { n: N, map } = normMap(T);
    let needle = nrm(find).trim();
    let stripped = "";
    let hits = findAll(N, map, needle);
    if (!hits.length) {
      const lm = needle.match(LIST_MARK);
      if (lm) {
        stripped = lm[0];
        needle = needle.slice(lm[0].length);
        hits = findAll(N, map, needle);
      }
    }
    return { N, map, needle, stripped, hits };
  }

  function locate(at, T, find, op, why) {
    const { N, map, needle, stripped, hits } = matchText(T, find);
    if (!hits.length) { why.reason = "not-found"; return null; }
    let m = hits[0];
    let via = "unique";
    if (hits.length > 1) {
      m = null;
      const r = Array.isArray(op.rects) && op.rects[0];
      if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) {
        const c = caretAtPoint(at, r.left + 1, r.top + (r.height || 10) / 2);
        if (c != null) {
          let best = null, bestD = Infinity;
          for (const h of hits) {
            const s = map[h], e = map[h + needle.length - 1] + 1;
            const d = c < s ? s - c : c > e ? c - e : 0;
            if (d < bestD) { bestD = d; best = h; }
          }
          if (best != null && bestD <= Math.max(8, needle.length / 4)) { m = best; via = "rects"; }
        }
      }
      if (m == null && Number.isInteger(op.occurrence) && op.occurrence >= 0 && op.occurrence < hits.length &&
          (!Number.isInteger(op.occurrences) || op.occurrences === hits.length)) {
        m = hits[op.occurrence];
        via = "occurrence";
      }
      if (m == null) { why.reason = "ambiguous"; why.matches = hits.length; return null; }
    }
    return {
      N, map, m, needle, stripped, via, matches: hits.length,
      rawS: map[m], rawE: map[m + needle.length - 1] + 1,
    };
  }

  /* ── pure edit planner ───────────────────────────────────────────────── */
  // loc = { map (doc normMap), m (normalized match index), needle }.
  // Returns raw model offsets [s,e) to select and the raw `insert` to paste.
  function planEdit(T1, loc, replacement, whole) {
    const { map: dmap, m, needle: oldN } = loc;
    const oldLen = oldN.length;
    const { n: newN, map: nmap } = normMap(replacement);
    if (newN === oldN) return { noop: true, oldN, newN };
    let { oa, ob, na, nb } = planDiff(oldN, newN);
    // Keep the edges out of folded expansions ("…" <-> "...").
    const inExpDoc = (x) => x > 0 && x < oldLen && dmap[m + x - 1] === dmap[m + x];
    const inExpNew = (x) => x > 0 && x < nmap.length && nmap[x - 1] === nmap[x];
    while (oa > 0 && na > 0 && (inExpDoc(oa) || inExpNew(na))) { oa--; na--; }
    while (ob < oldLen && nb < newN.length && (inExpDoc(ob) || inExpNew(nb))) { ob++; nb++; }
    if (whole) { oa = 0; na = 0; ob = oldLen; nb = newN.length; } // escape hatch
    const s = ob > oa ? dmap[m + oa] : (oa > 0 ? dmap[m + oa - 1] + 1 : dmap[m]);
    const e = ob > oa ? dmap[m + ob - 1] + 1 : s;
    const insert = nb > na ? replacement.slice(nmap[na], nmap[nb - 1] + 1).replace(/[ \t\u00a0]{2,}/g, " ") : "";
    return { oldN, newN, oa, ob, na, nb, s, e, insert, removedRaw: T1.slice(s, e) };
  }

  /* ── core: replace a located sentence (insertAfter is sugar over this) ── */

  async function doReplace(op, kind) {
    const t0 = now();
    const find = String(op.find ?? "");
    if (!find.trim() || find.length > MAX_FIND) return { ok: false, reason: "bad-request" };
    let replacement = kind === "insertAfter" ? null : String(op.replacement ?? "").trim();
    if (kind === "replace" && !replacement) return { ok: false, reason: "bad-request" }; // never delete a sentence outright
    if (kind === "insertAfter" && !String(op.text ?? "").trim()) return { ok: false, reason: "bad-request" };
    if (!target()) return { ok: false, reason: "no-editor" };
    const dry = !!op.dryRun;
    if (!dry && cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
    const mode = editorMode();
    if (!dry && viewOnlyHint()) return { ok: false, reason: "view-only", mode };

    const at = await getAT(!!op._test?.noApi);
    if (!at) return mouseReplace(op, kind, replacement, t0);

    const ed = editorEl();
    const scroll = ed ? ed.scrollTop : null;
    const T1 = at.getText();
    const saved = readSel(at);
    const why = {};
    const loc = locate(at, T1, find, op, why);
    if (!loc) {
      restoreUser(at, saved, null, scroll); // a rects click may have moved the caret
      return { ok: false, reason: why.reason, matches: why.matches, mode };
    }
    const { N: docN, m, needle, stripped } = loc;
    const oldLen = needle.length;

    if (kind === "insertAfter") {
      // Appending after the sentence == replacing it with sentence + text.
      replacement = T1.slice(loc.rawS, loc.rawE) + String(op.text).replace(/\s+$/, "");
    } else if (stripped && replacement.startsWith(stripped.trim())) {
      replacement = replacement.slice(stripped.trim().length).trim();
    }
    const plan = planEdit(T1, loc, replacement, !!op.whole);
    if (plan.noop) {
      restoreUser(at, saved, null, scroll);
      return { ok: true, noop: true, mode, ms: Math.round(now() - t0) };
    }
    const { oldN, newN, oa, ob, na, nb, s, e, insert, removedRaw } = plan;
    // Rich paste (e.g. a linked citation). replace: only when the paste is the
    // whole sentence. insertAfter: op.html describes op.text, and the paste is
    // "<last token(s) of the sentence>" + text, so the widened head is escaped
    // plain text in front of it.
    let html = null;
    if (op.html) {
      const tail = String(op.text ?? "").replace(/\s+$/, "");
      if (kind === "replace" && nb - na === newN.length) html = String(op.html);
      else if (kind === "insertAfter" && insert.endsWith(tail)) html = escHtml(insert.slice(0, insert.length - tail.length)) + String(op.html);
    }

    // ── one synchronous block: select → verify → edit ──
    let copied = null;
    try {
      at.setSelection(s, e);
    } catch {
      restoreUser(at, saved, null, scroll);
      return { ok: false, reason: "selection-failed", mode };
    }
    if (!selIs(at, s, e)) {
      restoreUser(at, saved, null, scroll);
      return { ok: false, reason: "selection-failed", mode, got: readSel(at) };
    }
    const Tnow = at.getText();
    const sentOk = Tnow === T1 && nrm(Tnow.slice(loc.rawS, loc.rawE)).trim() === needle;
    const midOk = nrm(Tnow.slice(s, e)).trim() === oldN.slice(oa, ob).trim();
    if (e > s) copied = copyReadback();
    const copyOk = copied == null ? null : nrm(copied).trim() === oldN.slice(oa, ob).trim();
    if (!sentOk || !midOk || copyOk === false) {
      restoreUser(at, saved, null, scroll);
      return { ok: false, reason: "selection-mismatch", mode, detail: { sentOk, midOk, copyOk, copied: copied?.slice(0, 200) } };
    }
    const planned = {
      target: { start: loc.rawS, end: loc.rawE, via: loc.via, matches: loc.matches, viewOnly: viewOnlyHint() },
      edit: { start: s, end: e, remove: removedRaw, insert, copyVerified: copyOk === true },
    };
    if (dry) {
      if (!op.keepSelection) restoreUser(at, saved, null, scroll);
      return { ok: true, dryRun: true, mode, ...planned, ms: Math.round(now() - t0) };
    }
    if (insert) paste(insert, html);
    else backspace(); // whole replacement empty → delete the selection
    // ── end of synchronous block ──

    const expectN = docN.slice(Math.max(0, m - CTX), m) + newN + docN.slice(m + oldLen, m + oldLen + CTX);
    let T2 = T1;
    let ok = false;
    const until = now() + APPLY_WAIT_MS;
    while (now() < until) {
      await sleep(20);
      T2 = at.getText();
      if (T2 !== T1 && nrm(T2).includes(expectN)) { ok = true; break; }
    }
    const changed = T2 !== T1;
    let verified = ok ? "exact" : null;
    if (!ok && changed && mode === "suggesting" && nrm(T2).includes(nrm(insert))) { ok = true; verified = "relaxed-suggesting"; }
    const ins = T2.length - T1.length + (e - s);
    const restored = restoreUser(at, saved, changed ? { s, e, ins } : null, scroll);
    const ms = Math.round(now() - t0);
    if (!ok) {
      if (!changed) return { ok: false, reason: "not-applied", mode, status: docStatus(), ms, ...planned };
      const rec = remember({ T1, T2, s, e, ins, removedRaw, insertN: nrm(insert), ctxB: docN.slice(Math.max(0, m - CTX), m), ctxA: docN.slice(m + oldLen, m + oldLen + CTX), newN, oldN, na, nb, oa, ob });
      return { ok: false, reason: "mismatch", changed: true, undo: rec.token, mode, ms, ...planned };
    }
    const rec = remember({ T1, T2, s, e, ins, removedRaw, insertN: nrm(insert), ctxB: docN.slice(Math.max(0, m - CTX), m), ctxA: docN.slice(m + oldLen, m + oldLen + CTX), newN, oldN, na, nb, oa, ob });
    return { ok: true, verified, undo: rec.token, selectionRestored: restored, mode, ms, ...planned };
  }

  /* ── no-API fallback: select by the bar rects, verify by copy readback ─ */
  // Replaces the WHOLE sentence (offsets are unknown without the API), and
  // refuses unless the copy readback proves the selection exactly.
  async function mouseReplace(op, kind, replacement, t0) {
    const rects = Array.isArray(op.rects) ? op.rects.filter((r) => r && Number.isFinite(r.left) && Number.isFinite(r.top) && r.width > 0) : [];
    if (!rects.length) return { ok: false, reason: "no-api" };
    const needle = nrm(op.find).trim();
    const r0 = rects[0], rn = rects[rects.length - 1];
    const h0 = r0.height || 12, hn = rn.height || 12;
    const p0 = { x: r0.left + 0.5, y: r0.top + h0 / 2 };
    const p1 = { x: rn.left + rn.width - 0.5, y: rn.top + hn / 2 };
    if (!hitEditor(p0.x, p0.y) || !hitEditor(p1.x, p1.y)) return { ok: false, reason: "offscreen" };
    clickAt(p0.x, p0.y);
    clickAt(p1.x, p1.y, { shift: true });
    const got = copyReadback();
    const collapse = () => press("ArrowLeft", "ArrowLeft", 37);
    if (got == null) { collapse(); return { ok: false, reason: "selection-unverifiable", path: "mouse" }; }
    if (nrm(got).trim() !== needle) { collapse(); return { ok: false, reason: "selection-mismatch", path: "mouse", detail: { copied: got.slice(0, 200) } }; }
    if (op.dryRun) {
      if (!op.keepSelection) collapse();
      return { ok: true, dryRun: true, path: "mouse", ms: Math.round(now() - t0) };
    }
    const text = kind === "insertAfter" ? got.replace(/\s+$/, "") + String(op.text).replace(/\s+$/, "") : replacement;
    paste(text, op.html || null);
    await sleep(120);
    // Read back: shift+click at the (unmoved) start extends from the caret at
    // the end of the pasted text back over it.
    let back = null;
    for (let i = 0; i < 8 && back == null; i++) {
      clickAt(p0.x, p0.y, { shift: true });
      const b = copyReadback();
      if (b != null && nrm(b).trim() === nrm(text).trim()) back = b;
      else await sleep(120);
    }
    press("ArrowRight", "ArrowRight", 39); // collapse to the end of the edit
    const ms = Math.round(now() - t0);
    if (back == null) return { ok: false, reason: "unverified", path: "mouse", ms };
    return { ok: true, verified: "copy-readback", path: "mouse", undo: rememberBlind(), ms };
  }

  /* ── undo ────────────────────────────────────────────────────────────── */

  const history = []; // newest last
  let tokSeq = 0;
  function remember(r) {
    const token = "e" + Date.now().toString(36) + "-" + ++tokSeq;
    history.push({ token, ...r });
    if (history.length > 50) history.shift();
    return { token };
  }
  function rememberBlind() {
    const token = "m" + Date.now().toString(36) + "-" + ++tokSeq;
    history.push({ token, blind: true });
    return token;
  }

  async function waitText(at, pred, ms) {
    const until = now() + ms;
    let t = at.getText();
    while (now() < until) {
      if (pred(t)) return t;
      await sleep(20);
      t = at.getText();
    }
    return pred(t) ? t : null;
  }

  // Semantic undo: find our inserted text by its context and put the removed
  // text back. Used whenever Ctrl/Cmd+Z could hit someone else's edit.
  async function reverseEdit(at, rec) {
    const T = at.getText();
    const { n: N, map } = normMap(T);
    const probe = rec.ctxB + rec.newN + rec.ctxA;
    const hits = findAll(N, map, probe, true);
    if (hits.length !== 1) return { ok: false, reason: hits.length ? "ambiguous" : "not-found" };
    const base = hits[0] + rec.ctxB.length;
    const a = base + rec.na, b = base + rec.nb;
    const s = b > a ? map[a] : (a > 0 ? map[a - 1] + 1 : map[base]);
    const e = b > a ? map[b - 1] + 1 : s;
    at.setSelection(s, e);
    if (!selIs(at, s, e) || nrm(T.slice(s, e)).trim() !== rec.newN.slice(rec.na, rec.nb).trim()) return { ok: false, reason: "selection-mismatch" };
    if (rec.removedRaw.trim()) paste(rec.removedRaw.replace(/^\s+|\s+$/g, ""));
    else backspace();
    const want = rec.ctxB + rec.oldN + rec.ctxA;
    const t = await waitText(at, (x) => x !== T && nrm(x).includes(want), UNDO_WAIT_MS);
    return t ? { ok: true, method: "reverse-edit" } : { ok: false, reason: "not-applied" };
  }

  async function undoOne(at, token) {
    const i = history.findIndex((h) => h.token === token);
    if (i < 0) return { ok: false, reason: "unknown-token" };
    const rec = history[i];
    if (rec.blind) {
      undoKey();
      history.splice(i, 1);
      return { ok: true, method: "undo-key", verified: false };
    }
    // Fast path: nothing at all has changed since our edit, and it is our
    // newest one, so the top of the user's undo stack IS our paste.
    if (i === history.length - 1 && at.getText() === rec.T2) {
      undoKey();
      const t = await waitText(at, (x) => x !== rec.T2, UNDO_WAIT_MS);
      if (t === rec.T1) { history.splice(i, 1); return { ok: true, method: "undo-key" }; }
      if (t != null) {
        // Undid more (or something else): put it back, then go semantic.
        redoKey();
        await waitText(at, (x) => x === rec.T2, UNDO_WAIT_MS);
        if (at.getText() !== rec.T2) return { ok: false, reason: "undo-overshoot" };
      }
    }
    const r = await reverseEdit(at, rec);
    if (r.ok) history.splice(i, 1);
    return r;
  }

  async function doUndo(op) {
    if (!op._test?.allowUndoWhenDisabled && cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
    const tokens = (Array.isArray(op.tokens) ? op.tokens : [op.token]).filter(Boolean).map(String);
    if (!tokens.length) return { ok: false, reason: "bad-request" };
    const at = await getAT(!!op._test?.noApi);
    if (!at) {
      if (tokens.every((t) => history.some((h) => h.token === t && h.blind))) {
        for (const t of tokens) { undoKey(); await sleep(150); history.splice(history.findIndex((h) => h.token === t), 1); }
        return { ok: true, method: "undo-key", verified: false };
      }
      return { ok: false, reason: "no-api" };
    }
    const ed = editorEl();
    const scroll = ed ? ed.scrollTop : null;
    const saved = readSel(at);
    const out = [];
    for (const t of tokens) {
      const r = await undoOne(at, t);
      out.push({ token: t, ...r });
      if (!r.ok) break;
    }
    restoreUser(at, saved, null, scroll); // offsets may shift a little; good enough for a caret
    const ok = out.length === tokens.length && out.every((r) => r.ok);
    return { ok, reason: ok ? undefined : out[out.length - 1]?.reason, steps: out };
  }

  /* ── append a line at the end of the document ───────────────────────── */

  async function doAppendLine(op) {
    const t0 = now();
    const line = String(op.line ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!line || line.length > MAX_FIND) return { ok: false, reason: "bad-request" };
    if (!target()) return { ok: false, reason: "no-editor" };
    const dry = !!op.dryRun;
    if (!dry && cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
    const mode = editorMode();
    if (!dry && viewOnlyHint()) return { ok: false, reason: "view-only", mode };
    const at = await getAT(!!op._test?.noApi);
    if (!at) return { ok: false, reason: "no-api" }; // no-API append: Cmd+Down then paste is possible, but unverifiable
    const ed = editorEl();
    const scroll = ed ? ed.scrollTop : null;
    const saved = readSel(at);
    const T1 = at.getText();
    // Model text ends "…last paragraph\n\u0003\n": the caret before that final
    // "\n" is the document end (== where Cmd+Down lands; measured).
    const endMark = T1.lastIndexOf("\u0003");
    const c0 = endMark - 1;
    if (endMark < 2 || T1[c0] !== "\n") return { ok: false, reason: "doc-end-unknown", mode };
    // Insert like a person would: at the end of the last paragraph that has
    // text, as "\n" + line, so the new paragraph inherits the BODY style.
    // (Pasting into a trailing empty paragraph measured: it takes that empty
    // paragraph's formatting — default Arial 11 in the test Doc, not the
    // Roboto 14 body.) Structure markers (tables etc.) before the trailing
    // paragraph → stay in the trailing paragraph instead.
    let c = c0;
    while (c > 1 && T1[c - 1] === "\n") c--;
    const prev = T1.charCodeAt(c - 1);
    if (c !== c0 && prev < 32 && prev !== 3) c = c0;
    const docEmpty = T1[c - 1] === "\u0003";
    const lastEmpty = docEmpty || T1[c - 1] === "\n";
    const text = (lastEmpty ? "" : "\n") + line;
    at.setSelection(c, c);
    if (!selIs(at, c, c)) { restoreUser(at, saved, null, scroll); return { ok: false, reason: "selection-failed", mode }; }
    const planned = { edit: { start: c, end: c, insert: text, newParagraph: !lastEmpty } };
    if (dry) {
      if (!op.keepSelection) restoreUser(at, saved, null, scroll);
      return { ok: true, dryRun: true, mode, ...planned, ms: Math.round(now() - t0) };
    }
    paste(text);
    const expected = T1.slice(0, c) + text + T1.slice(c);
    const K = nrm(line).length + CTX;
    const wantTail = nrm(expected).slice(-K);
    const T2 = (await waitText(at, (x) => x !== T1 && nrm(x).slice(-K) === wantTail, APPLY_WAIT_MS)) ?? at.getText();
    const changed = T2 !== T1;
    const ok = changed && nrm(T2).slice(-K) === wantTail;
    const ins = T2.length - T1.length;
    const restored = restoreUser(at, saved, changed ? { s: c, e: c, ins } : null, scroll);
    const ms = Math.round(now() - t0);
    if (!ok && !changed) return { ok: false, reason: "not-applied", mode, status: docStatus(), ms, ...planned };
    const N1 = nrm(T1);
    const cN = nrm(T1.slice(0, c)).length; // normalized position of the caret
    const rec = remember({
      T1, T2, s: c, e: c, ins, removedRaw: "", insertN: nrm(text),
      ctxB: N1.slice(Math.max(0, cN - CTX), cN), ctxA: N1.slice(cN, cN + CTX),
      newN: nrm(text), oldN: "", na: 0, nb: nrm(text).length, oa: 0, ob: 0,
    });
    if (!ok) return { ok: false, reason: "mismatch", changed: true, undo: rec.token, mode, ms, ...planned };
    return { ok: true, verified: "exact", undo: rec.token, selectionRestored: restored, mode, ms, ...planned };
  }

  async function doProbe() {
    const at = await getAT(false);
    let textLen = null;
    try { textLen = at ? at.getText().length : null; } catch { /* ignore */ }
    return { ok: true, version: window.__tracelyDocsEdit, api: !!at, editor: !!target(), mode: editorMode(), viewOnly: viewOnlyHint(), status: docStatus(), textLen };
  }

  // Test hook (harness/unit tests only): pure helpers, no side effects.
  if (window.__tracelyEditExpose) window.__tracelyEditInternals = { normMap, planDiff, findAll, matchText, planEdit, LIST_MARK };

  /* ── dispatch: one op at a time ──────────────────────────────────────── */

  let chain = Promise.resolve();
  function enqueue(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }
  const OPS = {
    probe: () => doProbe(),
    replace: (op) => doReplace(op, "replace"),
    insertAfter: (op) => doReplace(op, "insertAfter"),
    appendLine: (op) => doAppendLine(op),
    undo: (op) => doUndo(op),
  };

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== MSG_IN) return;
    const msg = ev.data;
    const run = OPS[msg.op];
    const reply = (r) => window.postMessage({ type: MSG_OUT, id: msg.id, op: msg.op, ...r }, "*");
    if (!run) { reply({ ok: false, reason: "bad-request" }); return; }
    enqueue(async () => {
      if (msg.op !== "probe") lockView();
      try { reply(await run(msg)); }
      catch (e) { reply({ ok: false, reason: "error", detail: String((e && e.message) || e).slice(0, 200) }); }
      finally { await unlockView(); } // after the reply: the caller never waits on this
    });
  });
})();
