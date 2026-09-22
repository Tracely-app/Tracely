/* Tracely — Google Docs canvas hook (runs in the PAGE world, document_start).

   Google Docs draws the document onto <canvas> tiles, so there are no DOM
   text nodes to underline. This script wraps the canvas text-drawing calls
   before Docs' code runs, keeping a ledger of every text run painted: which
   canvas, what text, where (after the current transform), and how wide. The
   content script (isolated world) asks "where is this sentence?" over
   window.postMessage, and gets back viewport rects it can draw wavy
   underlines on.

   Two design rules, learned from an adversarial review of the first draft:
   1. The paint path must stay allocation-light — kix calls fillText at kHz
      rates while typing/scrolling, so widths and font sizes are memoized,
      evictions amortize, and the no-op cases exit before any allocation.
   2. Anything that can repaint or invalidate pixels (clearRect, fillRect,
      drawImage, putImageData, bitmap resets) must evict the ledger region,
      or stale entries draw ghost underlines. When in doubt, evict — a
      missing underline heals on the next repaint; a ghost one lies.

   If Docs ever changes shape (offscreen painting, new APIs), locate() simply
   finds nothing and the extension stays widget-only, as before this file.
   Known accepted limits: assumes textAlign left / LTR (RTL runs may offset),
   and page-world scripts on docs.google.com could observe/forge the
   postMessage protocol (they are Google's own scripts).

   Second job, same world: the in-editor edit engine behind "Fix in doc",
   "Cite in doc" and "Add transition" — see installEditEngine() at the end. */
(() => {
  "use strict";
  if (window.__tracelyDocsHook) return;
  window.__tracelyDocsHook = true;

  /* Ask Docs to render its SVG annotation layer — the extension-compat layer
     Google added when Docs moved to canvas. Must be set before kix bootstraps,
     which is why this file is MAIN world / document_start.

     THERE IS NO ALLOWLIST. This line used to carry Grammarly's extension id
     (kbfnbcaeplbcioakkpcpgfkobkghlhen) on the widely-repeated belief that kix
     checks the value against a list of approved extensions. That was true once
     and is not true now. Read out of the live production bundle on 2026-09-13
     (docs.client_js_prod.en.p7BVCzq-328, kix_core, sha256 9fcecfd3…84a3bb,
     confirmed by three independent fetches):

       rQf=function(a,c){return a?!1:c.Pa("kix-ealct")||sQf()!=""};
       sQf=function(){return _.Fl._docs_annotate_canvas_by_ext||""};

     The gate is a string-emptiness test. `_docs_annotate_canvas_by_ext` occurs
     exactly once across kix_core/kix_app/kix_tertiary/kix_docos, and Grammarly's
     id appears ZERO times in ~36MB of Docs client JS. The ~121-id array that was
     dumped out of the bundle in December 2022 has been removed. Verified live in
     a browser: the layer renders for a random unpublished id, and for the literal
     string "totally-not-a-real-extension-id".

     So the value buys nothing beyond being non-empty — but it is NOT inert, and
     that is the reason this must be ours. Immediately after the gate passes kix
     does:

       this.VDa&&(r=sQf(),this.gb.jq("kixAnnotatedCanvasRequester",r),vMc(this.Vb,r))

     — writing the string into the Docs error reporter's context map AND into a
     client telemetry proto (field 172). Shipping Grammarly's id would file every
     Docs error a Tracely install provokes under Grammarly's name in Google's own
     telemetry. That is a misattribution we'd be authoring, quite apart from the
     Chrome Web Store's "impersonates another entity" line.

     Set this to Tracely's Web Store id once one is assigned — an id is what the
     field means, and it is what every comparable extension (LanguageTool,
     QuillBot, Wordtune, Ginger, ProWritingAid) sends. Until then a name that is
     unambiguously ours is the honest value. test/models.test.js fails the build
     if this ever becomes a third party's id again.

     If Google restores a real allowlist, this simply stops rendering and
     content.js falls through to the canvas-ledger path — see svgLocate() → null
     in content.js. That fallback is why this was never worth impersonating for. */
  const ANNOTATION_REQUESTER = "tracely";
  try {
    window._docs_annotate_canvas_by_ext = ANNOTATION_REQUESTER;
  } catch { /* never interfere */ }

  // The in-editor edit engine (bottom of this file). Installing it only adds
  // a message listener — it touches Docs lazily, on the first request — and it
  // goes in before the canvas hook so neither can take the other down.
  try {
    installEditEngine(ANNOTATION_REQUESTER);
  } catch { /* never interfere */ }

  const MAX_ENTRIES_PER_CANVAS = 4000;
  const EVICT_BLOCK = 1000; // amortize cap eviction: one splice per ~block, not per push
  const ledgers = new Map(); // canvas → [{text, x, y, w, size}] in canvas device px
  const versions = new WeakMap(); // canvas → int, bumped on any ledger change
  const lineCache = new WeakMap(); // canvas → {v, lines} — assembled lines, reused until dirty

  function bump(canvas) {
    versions.set(canvas, (versions.get(canvas) || 0) + 1);
  }

  // Every ledgered canvas gets a stable tile id, stamped onto the element so
  // the isolated-world content script (same DOM) can find it and anchor its
  // underline overlay to the tile — anchored bars ride DOM scrolling natively
  // instead of lagging a locate round-trip behind.
  let nextTileId = 1;
  const tileIds = new WeakMap();
  function tileIdFor(canvas) {
    let id = tileIds.get(canvas);
    if (!id) {
      id = nextTileId++;
      tileIds.set(canvas, id);
      try { canvas.setAttribute("data-tracely-tile", String(id)); } catch { /* never interfere */ }
    }
    return id;
  }

  function ledgerFor(canvas) {
    let l = ledgers.get(canvas);
    if (!l) { l = []; ledgers.set(canvas, l); tileIdFor(canvas); }
    return l;
  }

  /* ── memoized per-call lookups (the paint path's dominant costs) ─────── */

  const fontPxCache = new Map(); // font string → px
  function fontPx(font) {
    let v = fontPxCache.get(font);
    if (v === undefined) {
      const m = /(\d+(?:\.\d+)?)px/.exec(font || "");
      v = m ? Number(m[1]) : 12;
      if (fontPxCache.size > 500) fontPxCache.clear();
      fontPxCache.set(font, v);
    }
    return v;
  }

  const widthCache = new Map(); // font \0 letterSpacing \0 text → untransformed width
  function measureWidth(ctx, text) {
    const key = ctx.font + "\u0000" + (ctx.letterSpacing || "") + "\u0000" + text;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      // Crude cap beats LRU here: Docs repaints everything visible within one
      // frame cycle, so the cache rewarms instantly after a clear.
      if (widthCache.size >= 4000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }

  function record(ctx, text, x, y) {
    try {
      const canvas = ctx.canvas;
      if (!canvas || typeof text !== "string" || !text.trim()) return;
      const t = ctx.getTransform();
      // Docs body text isn't rotated; treat the transform as scale+translate.
      const dx = t.a * x + t.c * y + t.e;
      const dy = t.b * x + t.d * y + t.f;
      const l = ledgerFor(canvas);
      // Repainting the identical run in place (very common) must not duplicate
      // the entry — duplicates corrupt the assembled line text.
      const last = l[l.length - 1];
      if (last && last.text === text && last.x === dx && last.y === dy) return;
      // font + sx are kept so locate() can measure SUBSTRINGS of a run later:
      // real Docs paints whole lines as single runs, so underlining matched
      // runs wholesale would underline whole lines. (font is a shared string
      // ref; sx is one number — negligible ledger weight.)
      l.push({ text, x: dx, y: dy, w: measureWidth(ctx, text) * t.a, size: fontPx(ctx.font) * t.d, font: ctx.font, sx: t.a });
      if (l.length > MAX_ENTRIES_PER_CANVAS) l.splice(0, l.length - (MAX_ENTRIES_PER_CANVAS - EVICT_BLOCK));
      bump(canvas);
    } catch { /* never interfere with painting */ }
  }

  /* ── evictions: anything that repaints pixels invalidates the region ── */

  // device=true → x/y/w/h are already in canvas device px (putImageData
  // ignores the current transform, so its rect must not be re-transformed).
  function clearRegion(ctx, x, y, w, h, device) {
    try {
      const canvas = ctx.canvas;
      const l = ledgers.get(canvas);
      if (!l || l.length === 0) return;
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      // Tiny fills — the blinking caret (~2px), thin rules — can never be a
      // region repaint that invalidates a run. Skip before any allocation,
      // and never let the caret evict the very run it blinks on.
      if (Math.min(w, h) < 8) return;
      let cx = x, cy = y, cw = w, ch = h;
      if (!device) {
        const t = ctx.getTransform();
        cx = t.a * x + t.c * y + t.e;
        cy = t.b * x + t.d * y + t.f;
        cw = w * t.a;
        ch = h * t.d;
        if (cw < 0) { cx += cw; cw = -cw; }
        if (ch < 0) { cy += ch; ch = -ch; }
      }
      if (cw >= canvas.width * 0.8 && ch >= canvas.height * 0.8) {
        l.length = 0;
        bump(canvas);
        return;
      }
      const kept = (e) => e.y < cy || e.y - e.size > cy + ch || e.x + e.w < cx || e.x > cx + cw;
      // Pass 1: alloc-free scan — the common case (nothing evicted) exits here.
      let i = 0;
      while (i < l.length && kept(l[i])) i++;
      if (i === l.length) return;
      // Pass 2: compact in place from the first evicted entry.
      let wIdx = i;
      for (i++; i < l.length; i++) if (kept(l[i])) l[wIdx++] = l[i];
      l.length = wIdx;
      bump(canvas);
    } catch { /* never interfere */ }
  }

  const proto = CanvasRenderingContext2D.prototype;
  const origFill = proto.fillText;
  const origStroke = proto.strokeText;
  const origClear = proto.clearRect;
  const origFillRect = proto.fillRect;
  const origDrawImage = proto.drawImage;
  const origPutImageData = proto.putImageData;

  proto.fillText = function (text, x, y, ...rest) {
    record(this, text, x, y);
    return origFill.call(this, text, x, y, ...rest);
  };
  proto.strokeText = function (text, x, y, ...rest) {
    record(this, text, x, y);
    return origStroke.call(this, text, x, y, ...rest);
  };
  proto.clearRect = function (x, y, w, h) {
    clearRegion(this, x, y, w, h, false);
    return origClear.call(this, x, y, w, h);
  };
  // Docs often repaints by FILLING the background over a region rather than
  // clearing it — text under the fill is gone either way. But a TRANSLUCENT
  // fill (selection highlight, comment wash, find-match tint) paints over
  // text that stays visible and is NOT repainted afterwards — evicting there
  // is how underlines vanished from any line the user selected or commented.
  const alphaCache = new Map(); // fillStyle string → has-alpha?
  function overlayFill(ctx) {
    try {
      if (ctx.globalAlpha < 1) return true;
      const fs = ctx.fillStyle;
      if (typeof fs !== "string") return false; // gradients/patterns: treat as opaque
      let a = alphaCache.get(fs);
      if (a === undefined) {
        const m = /^(?:rgba|hsla)\(([^)]*)\)/i.exec(fs);
        a = false;
        if (m) {
          const parts = m[1].split(",");
          const alpha = parseFloat(parts[parts.length - 1]);
          a = Number.isFinite(alpha) && alpha < 0.99;
        } else if (fs.startsWith("#") && (fs.length === 5 || fs.length === 9)) {
          const hex = fs.length === 5 ? fs[4] + fs[4] : fs.slice(7, 9);
          a = parseInt(hex, 16) < 253;
        }
        if (alphaCache.size > 300) alphaCache.clear();
        alphaCache.set(fs, a);
      }
      return a;
    } catch {
      return false;
    }
  }
  proto.fillRect = function (x, y, w, h) {
    if (!overlayFill(this)) clearRegion(this, x, y, w, h, false);
    return origFillRect.call(this, x, y, w, h);
  };
  // Blits: kix SCROLLS by copying the tile onto itself (drawImage self-blit)
  // and only repaints the newly exposed strip. Evicting the destination — the
  // first version's behavior — threw away every shifted line's entries, so
  // after any scroll/edit only the most recently painted sentence still had
  // an underline ("it only underlines one thing at a time"). A pure-translation
  // self-blit now MOVES the entries with the pixels; anything else evicts.
  proto.drawImage = function (...args) {
    try {
      const im = args[0];
      let sx = 0, sy = 0, sw = 0, sh = 0, dx, dy, dw, dh;
      if (args.length >= 9) { sx = args[1]; sy = args[2]; sw = args[3]; sh = args[4]; dx = args[5]; dy = args[6]; dw = args[7]; dh = args[8]; }
      else if (args.length >= 5) { dx = args[1]; dy = args[2]; dw = args[3]; dh = args[4]; sw = dw; sh = dh; }
      else {
        dx = args[1]; dy = args[2];
        dw = sw = (im && (im.width || im.videoWidth)) || 0;
        dh = sh = (im && (im.height || im.videoHeight)) || 0;
      }
      if (dw && dh) {
        const l = ledgers.get(this.canvas);
        if (l && l.length && im === this.canvas) {
          /* Self-blit — kix's scroll. Coordinate rules from the canvas spec,
             which the first version got wrong (and the harness masked by
             blitting under an identity transform): the SOURCE rect is always
             in raw canvas device pixels — the transform never applies to it —
             while the DEST rect does go through the current transform. Mixing
             those up doubled the rects at DPR 2, misclassified every entry,
             and evicted the whole ledger on each repaint blit: zero
             underlines. Fail-safe now: when geometry looks unusual, KEEP
             entries (a brief ghost heals on repaint; mass eviction blanks
             the feature). */
          const t = this.getTransform();
          if (t.b === 0 && t.c === 0) { // axis-aligned only; else leave ledger alone
            const rdx = t.a * dx + t.e;
            const rdy = t.d * dy + t.f;
            const rdw = dw * t.a, rdh = dh * t.d;
            const oneToOne = Math.abs(rdw - sw) < 1 && Math.abs(rdh - sh) < 1;
            if (oneToOne) {
              const shiftX = rdx - sx, shiftY = rdy - sy;
              if (shiftX !== 0 || shiftY !== 0) {
                // Classify by baseline midpoint — edge-clipped ascents must not
                // fall out of the source region on a full-tile scroll.
                const moved = [], kept = [];
                for (const e of l) {
                  const mx = e.x + e.w / 2, my = e.y - e.size / 2;
                  const inSrc = mx >= sx && mx <= sx + sw && my >= sy && my <= sy + sh;
                  if (inSrc) { moved.push({ ...e, x: e.x + shiftX, y: e.y + shiftY }); continue; }
                  const inDst = mx >= rdx && mx <= rdx + rdw && my >= rdy && my <= rdy + rdh;
                  if (!inDst) kept.push(e); // dest-region non-source entries are painted over
                }
                l.length = 0;
                l.push(...kept, ...moved);
                bump(this.canvas);
                // Push the shift immediately so the overlay moves the bars in
                // this same frame — waiting for the next locate poll is what
                // made underlines lag behind blit-scrolled text.
                window.postMessage({ type: "tracely-docs-shift", tile: tileIdFor(this.canvas), dx: shiftX, dy: shiftY }, "*");
              }
              // zero shift = recomposite-in-place: pixels unchanged, keep all
            } else {
              clearRegion(this, rdx, rdy, rdw, rdh, true); // scaled self-blit: evict dest
            }
          }
        } else {
          clearRegion(this, dx, dy, dw, dh, false); // foreign image/buffer: evict dest
        }
      }
    } catch { /* never interfere */ }
    return origDrawImage.apply(this, args);
  };
  proto.putImageData = function (...args) {
    try {
      const data = args[0];
      if (data && data.width && data.height) clearRegion(this, args[1], args[2], data.width, data.height, true);
    } catch { /* never interfere */ }
    return origPutImageData.apply(this, args);
  };

  // Setting canvas.width/height resets the bitmap — the ledger must reset
  // with it or every stored coordinate (and the locate scale factor) is wrong.
  for (const prop of ["width", "height"]) {
    const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
    if (desc && desc.set) {
      Object.defineProperty(HTMLCanvasElement.prototype, prop, {
        ...desc,
        set(v) {
          try {
            const l = ledgers.get(this);
            if (l && l.length) { l.length = 0; bump(this); }
          } catch { /* never interfere */ }
          return desc.set.call(this, v);
        },
      });
    }
  }

  /* ── locating sentences ─────────────────────────────────────────────── */

  // Whitespace-free normalization makes matching immune to how Docs splits
  // runs and whether spaces are drawn or implied by advances.
  function norm(s) {
    return s.toLowerCase().replace(/[​‌﻿ ]/g, " ").replace(/\s+/g, "");
  }
  // The char class norm() strips — needed to map a NORMALIZED index back to a
  // RAW index inside a run's original text.
  const STRIPPED = /[\s​‌﻿ ]/;
  function rawIndexAt(text, normIdx) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      if (STRIPPED.test(text[i])) continue;
      if (n === normIdx) return i;
      n++;
    }
    return text.length;
  }

  // Offscreen context for measuring substrings of already-painted runs. Real
  // Docs paints a whole LINE as one run, so precise underlines require
  // measuring how far into the run the matched sentence starts and ends.
  let meas = null;
  function subRunX(run, normStart, normEnd) {
    if (!meas) meas = document.createElement("canvas").getContext("2d");
    try {
      meas.font = run.font || "16px Arial";
      const rawStart = rawIndexAt(run.text, normStart);
      const rawEnd = rawIndexAt(run.text, normEnd);
      const x0 = run.x + meas.measureText(run.text.slice(0, rawStart)).width * run.sx;
      const x1 = run.x + meas.measureText(run.text.slice(0, rawEnd)).width * run.sx;
      return [x0, x1];
    } catch {
      return [run.x, run.x + run.w]; // degrade to whole-run, never throw
    }
  }

  // Assemble a canvas's ledger into visual lines (baseline buckets, sorted by x).
  function linesOf(entries) {
    const buckets = new Map();
    for (const e of entries) {
      const key = Math.round(e.y / 4) * 4;
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push(e);
    }
    const lines = [];
    for (const runs of buckets.values()) {
      runs.sort((a, b) => a.x - b.x);
      let joined = "";
      const spans = []; // per-run [startIdx, endIdx, run] into the joined norm string
      for (const r of runs) {
        const n = norm(r.text);
        spans.push([joined.length, joined.length + n.length, r]);
        joined += n;
      }
      if (joined) lines.push({ joined, spans });
    }
    return lines;
  }

  // Longest p ≥ min such that L ends with S's first p chars (alloc-free).
  function tailHeadOverlap(L, S, min) {
    const max = Math.min(L.length, S.length);
    for (let p = max; p >= min; p--) {
      const off = L.length - p;
      let ok = true;
      for (let i = 0; i < p; i++) {
        if (L.charCodeAt(off + i) !== S.charCodeAt(i)) { ok = false; break; }
      }
      if (ok) return p;
    }
    return 0;
  }
  // Longest p ≥ min such that L starts with S's last p chars (alloc-free).
  function headTailOverlap(L, S, min) {
    const max = Math.min(L.length, S.length);
    for (let p = max; p >= min; p--) {
      const off = S.length - p;
      let ok = true;
      for (let i = 0; i < p; i++) {
        if (L.charCodeAt(i) !== S.charCodeAt(off + i)) { ok = false; break; }
      }
      if (ok) return p;
    }
    return 0;
  }

  /* Where does sentence S overlap line L? Sentences are contiguous in the
     doc, so a line either contains S, sits inside S, or holds S's start or
     end. Boundary thresholds are asymmetric on purpose:
     - a line ENDING with S's start needs 12 chars — short prefixes ("hewas")
       collide with ordinary prose constantly, and the cost of missing is
       only that the underline starts on the next line;
     - a line STARTING with S's end accepts 5 chars when the fragment is S's
       exact punctuation-terminated tail (the common wrap "player." case) —
       a random collision would have to sit at the line start AND end with
       the sentence's own terminal punctuation. */
  const EDGE_STRICT = 12;
  const EDGE_TAIL = 5;
  const TERMINAL = /[.!?…"'’”)\]]$/;
  function overlapRange(L, S) {
    const i = L.indexOf(S);
    if (i >= 0) return [i, i + S.length];
    if (L.length >= 6 && S.includes(L)) return [0, L.length];
    let p = tailHeadOverlap(L, S, EDGE_STRICT);
    if (p) return [L.length - p, L.length];
    p = headTailOverlap(L, S, TERMINAL.test(S) ? EDGE_TAIL : EDGE_STRICT);
    if (p) return [0, p];
    return null;
  }

  function locate(wants) {
    const out = {};
    for (const [canvas, entries] of ledgers) {
      if (!canvas.isConnected) {
        // A detached tile can never draw on screen again; if Docs reattaches
        // one it repaints it, which re-records.
        ledgers.delete(canvas);
        continue;
      }
      if (entries.length === 0 || wants.length === 0) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const sx = rect.width / (canvas.width || 1);
      const sy = rect.height / (canvas.height || 1);
      // Reuse assembled lines until the ledger actually changes.
      const v = versions.get(canvas) || 0;
      let cached = lineCache.get(canvas);
      if (!cached || cached.v !== v) {
        cached = { v, lines: linesOf(entries) };
        lineCache.set(canvas, cached);
      }
      for (const want of wants) {
        const S = want.n;
        if (!S || S.length < 4) continue;
        for (const line of cached.lines) {
          const range = overlapRange(line.joined, S);
          if (!range) continue;
          let x0 = Infinity, x1 = -Infinity, base = 0, size = 12, any = false;
          for (const [s, e, run] of line.spans) {
            if (e <= range[0] || s >= range[1]) continue;
            any = true;
            // Only the covered slice of the run is underlined. A fully-covered
            // run keeps its cheap recorded bounds; a boundary run (which, on
            // real Docs, is usually the WHOLE line) is measured precisely.
            let rx0 = run.x, rx1 = run.x + run.w;
            if (range[0] > s || range[1] < e) {
              [rx0, rx1] = subRunX(run, Math.max(range[0] - s, 0), Math.min(range[1], e) - s);
            }
            x0 = Math.min(x0, rx0);
            x1 = Math.max(x1, rx1);
            base = Math.max(base, run.y);
            size = Math.max(size, run.size);
          }
          if (!any) continue;
          // BOTH coordinate forms: canvas-relative (tile/x/y — the content
          // script re-derives live viewport positions from the canvas rect
          // every frame, which is what keeps bars glued during scroll) and
          // plain viewport left/top as a fallback for when the tile element
          // can't be resolved from the isolated world.
          (out[want.hash] = out[want.hash] || []).push({
            tile: tileIdFor(canvas),
            x: x0 * sx,
            y: (base + 2) * sy,
            left: rect.left + x0 * sx,
            top: rect.top + (base + 2) * sy,
            width: (x1 - x0) * sx,
            size: size * sy,
          });
        }
      }
    }
    return out;
  }

  /* ── debug probe ────────────────────────────────────────────────────── */
  // Page console: __tracelyDocsDebug() prints what the hook sees, fully
  // expanded (screenshot-friendly). Pass a sentence to ALSO test locating it:
  //   __tracelyDocsDebug("Einstein was a basketball player")
  // Read-only; exists because real Docs can't be driven from the harness.
  window.__tracelyDocsDebug = function (probeText) {
    const ann = document.querySelectorAll(".kix-canvas-tile-content svg rect[aria-label]").length;
    const lines = [
      `tracely-docs-hook: ${ledgers.size} canvas(es) in ledger`,
      `annotation layer: ${ann} rect(s) ${ann ? "(SVG mode available)" : "(NOT rendered — canvas fallback in use)"}`,
    ];
    for (const [canvas, entries] of ledgers) {
      const r = canvas.isConnected ? canvas.getBoundingClientRect() : null;
      lines.push(
        `— canvas ${canvas.width}x${canvas.height} ` +
          (r ? `css ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}` : "DETACHED") +
          ` · ${entries.length} entries`
      );
      for (const e of entries.slice(-4)) {
        lines.push(`    "${e.text.slice(0, 44)}" @${Math.round(e.x)},${Math.round(e.y)} w${Math.round(e.w)} f:${String(e.font).slice(0, 24)}`);
      }
    }
    if (typeof probeText === "string" && probeText.trim()) {
      const rects = locate([{ hash: "probe", n: norm(probeText) }]).probe ?? [];
      lines.push(`probe "${probeText.slice(0, 40)}" → ${rects.length} rect(s)`);
      for (const r of rects) lines.push(`    @${Math.round(r.left)},${Math.round(r.top)} w${Math.round(r.width)}`);
    }
    console.log(lines.join("\n"));
    return `${ledgers.size} canvases — details logged above`;
  };

  /* ── protocol ───────────────────────────────────────────────────────── */

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.type !== "tracely-docs-locate") return;
    try {
      const wants = (Array.isArray(ev.data.wants) ? ev.data.wants : [])
        .slice(0, 40)
        .map((w) => ({ hash: String(w.hash ?? ""), n: norm(String(w.text ?? "")) }));
      // An empty wants list is a maintenance ping: locate() still prunes
      // detached canvases, so clean documents don't accumulate ledgers.
      window.postMessage({ type: "tracely-docs-rects", id: ev.data.id, rects: locate(wants) }, "*");
    } catch {
      window.postMessage({ type: "tracely-docs-rects", id: ev.data.id, rects: {} }, "*");
    }
  });

  /* ════════════════════════════════════════════════════════════════════════
     IN-EDITOR EDITS — "Fix in doc", "Cite in doc", "Add transition"

     Every edit is made by the user's own open editor, through the input path a
     person uses (a paste into kix's text-event iframe), and is READ BACK before
     it is reported as done. No Docs API, no OAuth, no new permission. Proven on
     a live Doc behind a severed network (extension/dev/fix-in-doc/, 46/46).

     Protocol (window.postMessage, content.js ⇄ here, same window only):
       in : { source: "tracely", type: "tracely-docs-edit", id, op, ...args }
       out: { source: "tracely-hook", type: "tracely-docs-edit-result", id, op,
              ok, reason?, undoToken?, ...detail }
     ops
       ping                                  → { api, editor, editable, mode, viewOnly }
       replace     { find, replacement, hint? }
       insertAfter { find, text, html?, hint? }
       appendLine  { line, html? }
       undo        { undoToken, rollback? }  (a token, or an array of them, newest first;
                                              rollback = the immediate take-back of a failed group)
     hint = { occurrence?, occurrences?, rects? } picks among repeated copies of
     `find`; it never overrides the text check.

     Safety rules (each one is load-bearing):
       1. Target by TEXT, confirm by TEXT. The range is found in Docs' own model
          text (_docs_annotate_getAnnotatedText → getText()), selected by offset,
          and the selection is re-read (getSelection + slice, plus a synthetic
          copy read-back) BEFORE anything is pasted. Any disagreement aborts.
       2. Locate → select → verify → paste run in ONE synchronous block, so no
          keystroke or remote change can land between the check and the edit.
       3. The edit is the SMALLEST token-aligned change, so formatting, links
          and comment anchors outside the changed words survive.
       4. Success means the model text now reads as expected. A silent no-op
          (view-only, locked or offline editor) is a failure, and content.js
          falls back to Copy.
       5. The user's selection is restored (shifted by the edit) and their view
          never moves: kix's programmatic scrollTop writes are swallowed while
          an op runs (the user's own scrolling is native and unaffected).
     Docs facts this relies on (measured): getText() has U+0003 at 0, keeps
     U+200B, and ends "\n\u0003\n"; setSelection(start, end) is end-exclusive
     and silently ignores bad offsets (so getSelection is always checked);
     synthetic keys need keyCode forced; leading ASCII spaces of a paste are
     dropped; a locked editor ignores input silently (so always re-read). */
  function installEditEngine(REQUESTER) {
    const MSG_IN = "tracely-docs-edit";
    const MSG_OUT = "tracely-docs-edit-result";
    const SOURCE_IN = "tracely";
    const SOURCE_OUT = "tracely-hook";
    const VERSION = 1;
    const APPLY_WAIT_MS = 1500; // a paste lands in ~40ms; this is the "it never landed" bound
    const UNDO_WAIT_MS = 1200;
    const BLIND_UNDO_MS = 10000; // an unverifiable (no-API) edit can be rolled back only this soon
    const CTX = 24;             // normalized chars of context used to re-find an edit later
    const MAX_FIND = 4000;
    const MAX_HTML = 20000;

    // Harness-only guard: window.__tracelyEditConfig = { allowEdits: false }
    // makes every non-dry edit refuse. Nothing in the extension sets it.
    const cfg = () => {
      const c = window.__tracelyEditConfig;
      return c && typeof c === "object" ? c : {};
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const str = (v) => (typeof v === "string" ? v : null);

    /* ── Docs handles (all lazy) ─────────────────────────────────────────── */

    let atCache = null;
    async function getAT() {
      if (atCache) {
        try { if (typeof atCache.getText() === "string") return atCache; } catch { /* stale */ }
        atCache = null;
      }
      const fn = window._docs_annotate_getAnnotatedText;
      if (typeof fn !== "function") return null;
      try {
        // Our own requester id, the same honest value the canvas flag carries —
        // never a third party's (the argument may be reported like the flag is).
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
      const el = document.getElementById("docs-toolbar-mode-switcher");
      const label = ((el && el.getAttribute("aria-label")) || "").toLowerCase();
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
    function docStatus() {
      const el = document.querySelector('[aria-label^="Document status"]');
      return (el && el.getAttribute("aria-label")) || "";
    }

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

    // Docs fills our own DataTransfer on a synthetic copy; the system
    // clipboard is never touched. null = unverifiable (e.g. copy disabled).
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

    // kix ignores key events whose legacy keyCode is 0 for control keys, so
    // it is forced via defineProperty (measured: without it nothing happens).
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
    const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
    const undoKey = () => press("z", "KeyZ", 90, isMac() ? { meta: true } : { ctrl: true });
    const redoKey = () => (isMac() ? press("z", "KeyZ", 90, { meta: true, shift: true }) : press("y", "KeyY", 89, { ctrl: true }));
    const backspace = () => press("Backspace", "Backspace", 8);

    // Synthetic mouse, only ever onto the page surface of the editor — never a
    // toolbar, dialog, comment, or our own widget over the page. kix's caret,
    // collaborator cursors and selection overlays are seen through; anything
    // else on top refuses.
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
    // chars (Docs keeps U+200B), NBSP/whitespace runs, smart quotes, dashes,
    // ellipsis. Control/private-use chars (U+0003 sentinels, table and object
    // markers) become a hard "\n" boundary a sentence can't span.
    const DROP = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/;
    const SPACE = /[ \t\u000b\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
    const FOLD = {
      "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
      "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
      "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
      "\u2026": "...",
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
    // old[0,oa)==new[0,na) and old[ob,)==new[nb,). Widened until NEITHER
    // middle starts/ends with whitespace (Docs trims pasted edge spaces — the
    // forward paste and the undo paste must both survive that) and neither is
    // empty (every edit is "select something, paste something": one undo step).
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
    // .kix-appview-editor.scrollTop for ~250ms (8-9 writes; setSelection has
    // no no-scroll option; restoring the old selection does not scroll back).
    // While an op runs, kix's programmatic writes on that one element are
    // swallowed. The user's own scrolling never goes through this setter, so
    // it is never fought; the lock lifts once kix has been quiet for 300ms.
    let scrollDesc;
    let viewLock = null;
    function lockView() {
      if (scrollDesc === undefined) {
        scrollDesc = typeof Element !== "undefined" ? Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") || null : null;
      }
      const ed = editorEl();
      if (viewLock || !ed || !scrollDesc || !scrollDesc.set) return false;
      const L = { ed, last: now(), swallowed: 0 };
      const desc = scrollDesc;
      try {
        Object.defineProperty(ed, "scrollTop", {
          configurable: true,
          get() { return desc.get.call(this); },
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

    // Only what the protocol allows through: numbers, a few rects.
    function hintOf(m) {
      const h = m && m.hint && typeof m.hint === "object" ? m.hint : {};
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const rects = (Array.isArray(h.rects) ? h.rects.slice(0, 8) : [])
        .filter((r) => r && typeof r === "object" && num(r.left) != null && num(r.top) != null)
        .map((r) => ({ left: r.left, top: r.top, width: num(r.width) ?? 0, height: num(r.height) ?? 0 }));
      return {
        occurrence: Number.isInteger(h.occurrence) && h.occurrence >= 0 ? h.occurrence : null,
        occurrences: Number.isInteger(h.occurrences) && h.occurrences > 0 ? h.occurrences : null,
        rects,
      };
    }

    // Offset of the caret a click at (x,y) produces — used ONLY to choose
    // among identical matches; the caller restores the selection afterwards.
    function caretAtPoint(at, x, y) {
      if (!clickAt(x, y)) return null;
      const sel = readSel(at);
      return sel && sel.length ? sel[0].start : null;
    }

    // A find is a whole sentence as content.js segments the export
    // (segmentText: /[^.!?]+(?:[.!?]+["')\]]*|$)/ per line). So a real copy
    // starts where a line starts or right after the previous sentence's end
    // punctuation (+ closers, + whitespace) — never as the tail of a longer
    // sentence: "The myth that Einstein failed math." holds "Einstein failed
    // math." but is not it. Read on the RAW text, so "…" (not a sentence end
    // there) stays distinct from "...", and a soft line break (U+000B) or an
    // object/structure marker counts as a line start.
    const isHard = (c) => {
      const code = c.charCodeAt(0);
      return code < 32 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029 || (code >= 0xe000 && code <= 0xf8ff);
    };
    function atSentenceStart(T, rs) {
      let i = rs - 1;
      while (i >= 0 && T[i] !== "\u000b" && (DROP.test(T[i]) || SPACE.test(T[i]))) i--;
      if (i < 0 || isHard(T[i])) return true;
      while (i >= 0 && "\"')]".includes(T[i])) i--;
      return i >= 0 && ".!?".includes(T[i]);
    }
    // ...and ends where segmentText ended it: after the WHOLE punctuation run
    // ("Wait." is not a sentence of "Wait..."), or — unpunctuated — at the
    // end of its line.
    const SENT_END = /[.!?\u2026]["'\u201d\u2019)\]]*$/;
    function atSentenceEnd(T, re, terminal) {
      let i = re;
      while (i < T.length && DROP.test(T[i])) i++;
      if (terminal) return i >= T.length || !".!?\"')]".includes(T[i]);
      while (i < T.length && T[i] !== "\u000b" && (DROP.test(T[i]) || SPACE.test(T[i]))) i++;
      return i >= T.length || isHard(T[i]);
    }

    // Pure: every acceptable match of `find` in model text T. sentence: only
    // whole-sentence copies (what every protocol find is).
    function matchText(T, find, { sentence = false } = {}) {
      const { n: N, map } = normMap(T);
      let needle = nrm(find).trim();
      let stripped = "";
      const terminal = SENT_END.test(String(find).trim());
      const whole = (h) => !sentence || (atSentenceStart(T, map[h]) && atSentenceEnd(T, map[h + needle.length - 1] + 1, terminal));
      let hits = findAll(N, map, needle).filter(whole);
      if (!hits.length) {
        const lm = needle.match(LIST_MARK);
        if (lm) {
          stripped = lm[0];
          needle = needle.slice(lm[0].length);
          hits = findAll(N, map, needle).filter(whole);
        }
      }
      return { N, map, needle, stripped, hits };
    }

    // Pure choice among several hits: the caret a rect click produced, else
    // the export's occurrence index. Either way only while the export and the
    // live model agree on how many copies there are — a disagreement means
    // one of them is stale, and then even a lone hit may be a different
    // sentence from the one on the card. null = refuse (see pickWhy).
    function pickWhy(hits, hint) {
      return hint.occurrences != null && hint.occurrences !== hits.length ? "stale" : "ambiguous";
    }
    function pickHit(hits, map, needleLen, hint, caret) {
      if (hint.occurrences != null && hint.occurrences !== hits.length) return null;
      if (hits.length === 1) return { m: hits[0], via: "unique" };
      if (caret != null) {
        let best = null, bestD = Infinity;
        for (const h of hits) {
          const s = map[h], e = map[h + needleLen - 1] + 1;
          const d = caret < s ? s - caret : caret > e ? caret - e : 0;
          if (d < bestD) { bestD = d; best = h; }
        }
        if (best != null && bestD <= Math.max(8, needleLen / 4)) return { m: best, via: "rects" };
      }
      if (hint.occurrence != null && hint.occurrence < hits.length) {
        return { m: hits[hint.occurrence], via: "occurrence" };
      }
      return null;
    }

    function locate(at, T, find, hint, why) {
      const { N, map, needle, stripped, hits } = matchText(T, find, { sentence: true });
      if (!hits.length) { why.reason = "not-found"; return null; }
      let caret = null;
      if (hits.length > 1 && hint.rects.length && pickWhy(hits, hint) !== "stale") {
        const r = hint.rects[0];
        caret = caretAtPoint(at, r.left + 1, r.top + (r.height || 10) / 2);
      }
      const pick = pickHit(hits, map, needle.length, hint, caret);
      if (!pick) { why.reason = pickWhy(hits, hint); why.matches = hits.length; return null; }
      return {
        N, map, m: pick.m, needle, stripped, via: pick.via, matches: hits.length,
        rawS: map[pick.m], rawE: map[pick.m + needle.length - 1] + 1,
      };
    }

    /* ── pure edit planner ───────────────────────────────────────────────── */
    // loc = { map (doc normMap), m (normalized match index), needle }.
    // Returns raw model offsets [s,e) to select and the raw `insert` to paste.
    function planEdit(T1, loc, replacement) {
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
      const s = ob > oa ? dmap[m + oa] : (oa > 0 ? dmap[m + oa - 1] + 1 : dmap[m]);
      const e = ob > oa ? dmap[m + ob - 1] + 1 : s;
      const insert = nb > na ? replacement.slice(nmap[na], nmap[nb - 1] + 1).replace(/[ \t\u00a0]{2,}/g, " ") : "";
      return { oldN, newN, oa, ob, na, nb, s, e, insert, removedRaw: T1.slice(s, e) };
    }

    /* ── core: replace a located sentence (insertAfter is sugar over this) ── */

    async function doReplace(op, kind) {
      const t0 = now();
      const find = str(op.find);
      if (find == null || !find.trim() || find.length > MAX_FIND) return { ok: false, reason: "bad-request" };
      let replacement = null;
      const text = str(op.text);
      const html = op.html == null ? null : str(op.html);
      if (kind === "replace") {
        replacement = str(op.replacement);
        // Never delete a sentence outright.
        if (replacement == null || !replacement.trim() || replacement.length > MAX_FIND) return { ok: false, reason: "bad-request" };
        replacement = replacement.trim();
      } else {
        if (text == null || !text.trim() || text.length > MAX_FIND) return { ok: false, reason: "bad-request" };
        if (op.html != null && (html == null || html.length > MAX_HTML)) return { ok: false, reason: "bad-request" };
      }
      const hint = hintOf(op);
      if (!target()) return { ok: false, reason: "no-editor" };
      const dry = op.dryRun === true;
      if (!dry && cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
      const mode = editorMode();
      if (!dry && viewOnlyHint()) return { ok: false, reason: "view-only", mode };

      const at = await getAT();
      if (!at) return mouseReplace({ find, text, html, dry, hint }, kind, replacement, t0);

      const ed = editorEl();
      const scroll = ed ? ed.scrollTop : null;
      const T1 = at.getText();
      const saved = readSel(at);
      const why = {};
      const loc = locate(at, T1, find, hint, why);
      if (!loc) {
        restoreUser(at, saved, null, scroll); // a rects click may have moved the caret
        return { ok: false, reason: why.reason, matches: why.matches, mode };
      }
      const { N: docN, m, needle, stripped } = loc;
      const oldLen = needle.length;

      if (kind === "insertAfter") {
        // Appending after the sentence == replacing it with sentence + text.
        replacement = T1.slice(loc.rawS, loc.rawE) + text.replace(/\s+$/, "");
      } else if (stripped && replacement.startsWith(stripped.trim())) {
        replacement = replacement.slice(stripped.trim().length).trim();
      }
      const plan = planEdit(T1, loc, replacement);
      if (plan.noop) {
        restoreUser(at, saved, null, scroll);
        return { ok: true, noop: true, mode, ms: Math.round(now() - t0) };
      }
      const { oldN, newN, oa, ob, na, nb, s, e, insert, removedRaw } = plan;
      // Rich paste (a linked citation): op.html describes op.text, and the
      // paste is "<last token(s) of the sentence>" + text, so the widened head
      // goes in front of it as escaped plain text.
      let pasteHtml = null;
      if (kind === "insertAfter" && html) {
        const tail = text.replace(/\s+$/, "");
        if (insert.endsWith(tail)) pasteHtml = escHtml(insert.slice(0, insert.length - tail.length)) + html;
      }

      // ── one synchronous block: select → verify → edit ──
      try {
        at.setSelection(s, e);
      } catch {
        restoreUser(at, saved, null, scroll);
        return { ok: false, reason: "selection-failed", mode };
      }
      if (!selIs(at, s, e)) {
        restoreUser(at, saved, null, scroll);
        return { ok: false, reason: "selection-failed", mode };
      }
      const Tnow = at.getText();
      const sentOk = Tnow === T1 && nrm(Tnow.slice(loc.rawS, loc.rawE)).trim() === needle;
      const midOk = nrm(Tnow.slice(s, e)).trim() === oldN.slice(oa, ob).trim();
      const copied = e > s ? copyReadback() : null;
      const copyOk = copied == null ? null : nrm(copied).trim() === oldN.slice(oa, ob).trim();
      if (!sentOk || !midOk || copyOk === false) {
        restoreUser(at, saved, null, scroll);
        return { ok: false, reason: "selection-mismatch", mode };
      }
      const planned = {
        target: { start: loc.rawS, end: loc.rawE, via: loc.via, matches: loc.matches },
        edit: { start: s, end: e, remove: removedRaw, insert, copyVerified: copyOk === true },
      };
      if (dry) {
        restoreUser(at, saved, null, scroll);
        return { ok: true, dryRun: true, mode, ...planned, ms: Math.round(now() - t0) };
      }
      if (insert) paste(insert, pasteHtml);
      else backspace(); // (unreachable for replace/insertAfter: planDiff never empties the new side)
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
      if (!ok && !changed) return { ok: false, reason: "not-applied", mode, status: docStatus(), ms, ...planned };
      const rec = remember({
        T1, T2, removedRaw,
        ctxB: docN.slice(Math.max(0, m - CTX), m), ctxA: docN.slice(m + oldLen, m + oldLen + CTX),
        newN, oldN, na, nb,
      });
      if (!ok) return { ok: false, reason: "mismatch", changed: true, undoToken: rec.token, mode, ms, ...planned };
      return { ok: true, verified, undoToken: rec.token, selectionRestored: restored, mode, ms, ...planned };
    }

    /* ── no-API fallback: select by the bar rects, verify by copy read-back ─ */
    // Replaces the WHOLE sentence (offsets are unknown without the API), and
    // refuses unless the copy read-back proves the selection exactly.
    async function mouseReplace(req, kind, replacement, t0) {
      const rects = req.hint.rects.filter((r) => r.width > 0);
      if (!rects.length) return { ok: false, reason: "no-api" };
      const needle = nrm(req.find).trim();
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
      if (nrm(got).trim() !== needle) { collapse(); return { ok: false, reason: "selection-mismatch", path: "mouse" }; }
      if (req.dry) {
        collapse();
        return { ok: true, dryRun: true, path: "mouse", ms: Math.round(now() - t0) };
      }
      const text = kind === "insertAfter" ? got.replace(/\s+$/, "") + req.text.replace(/\s+$/, "") : replacement;
      paste(text, kind === "insertAfter" && req.html ? escHtml(got.replace(/\s+$/, "")) + req.html : null);
      await sleep(120);
      // Read back: shift+click at the (unmoved) start extends from the caret
      // at the end of the pasted text back over it.
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
      // rollbackOnly: the token can take this edit back only as the immediate
      // rollback of a failed group (see blindUndoOk) — never as a later Undo.
      return { ok: true, verified: "copy-readback", path: "mouse", undoToken: rememberBlind(), rollbackOnly: true, ms };
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
      history.push({ token, blind: true, at: now() });
      if (history.length > 50) history.shift();
      return token;
    }
    // A blind edit (made without the text API) can only be taken back by an
    // unverified Cmd/Ctrl+Z, which undoes whatever is newest — the user's
    // typing, if they typed since. So only the immediate rollback of a group
    // that just failed may do it (content.js sends rollback:true only there,
    // while the button still says "Applying…"), only for our newest edit, and
    // only within seconds of it. A later Undo is refused.
    const blindUndoOk = (op, i, rec) => op.rollback === true && i === history.length - 1 && now() - rec.at < BLIND_UNDO_MS;

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

    // Semantic undo: find our inserted text by its context and put the
    // removed text back. Used whenever Ctrl/Cmd+Z could hit someone else's edit.
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

    async function undoOne(at, token, op) {
      const i = history.findIndex((h) => h.token === token);
      if (i < 0) return { ok: false, reason: "unknown-token" };
      const rec = history[i];
      if (rec.blind) {
        if (!blindUndoOk(op, i, rec)) return { ok: false, reason: "blind" };
        undoKey();
        history.splice(i, 1);
        return { ok: true, method: "undo-key", verified: false };
      }
      // Fast path: the text is exactly as our edit left it, and it is our
      // newest one, so the top of the user's undo stack is USUALLY our paste.
      // Not always: bold, a link, a heading style or a colour change leaves
      // the text alone, and then Cmd+Z takes THAT back instead.
      if (i === history.length - 1 && at.getText() === rec.T2) {
        undoKey();
        const t = await waitText(at, (x) => x !== rec.T2, UNDO_WAIT_MS);
        if (t === rec.T1) { history.splice(i, 1); return { ok: true, method: "undo-key" }; }
        // Undid something else — a text change (t != null) or a step that
        // changes no text (t == null; redo does nothing if nothing was undone).
        // Put it back either way, then go semantic.
        redoKey();
        if (t != null) {
          await waitText(at, (x) => x === rec.T2, UNDO_WAIT_MS);
          if (at.getText() !== rec.T2) return { ok: false, reason: "undo-overshoot" };
        }
      }
      const r = await reverseEdit(at, rec);
      if (r.ok) history.splice(i, 1);
      return r;
    }

    async function doUndo(op) {
      const raw = Array.isArray(op.undoToken) ? op.undoToken : [op.undoToken];
      const tokens = raw.filter((t) => typeof t === "string" && t && t.length <= 100);
      if (!tokens.length || tokens.length !== raw.length || tokens.length > 20) return { ok: false, reason: "bad-request" };
      if (cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
      if (!target()) return { ok: false, reason: "no-editor" };
      const at = await getAT();
      if (!at) {
        if (tokens.every((t) => history.some((h) => h.token === t && h.blind))) {
          // All or nothing: every token must be the next-newest edit, in order.
          const n = history.length;
          if (!tokens.every((t, k) => history[n - 1 - k]?.token === t && blindUndoOk(op, n - 1, history[n - 1 - k]))) {
            return { ok: false, reason: "blind" };
          }
          for (let k = 0; k < tokens.length; k++) {
            undoKey();
            await sleep(150);
            history.pop();
          }
          return { ok: true, method: "undo-key", verified: false };
        }
        return { ok: false, reason: "no-api" };
      }
      const ed = editorEl();
      const scroll = ed ? ed.scrollTop : null;
      const saved = readSel(at);
      const steps = [];
      for (const t of tokens) {
        const r = await undoOne(at, t, op);
        steps.push({ token: t, ...r });
        if (!r.ok) break;
      }
      restoreUser(at, saved, null, scroll); // offsets may shift a little; good enough for a caret
      const ok = steps.length === tokens.length && steps.every((r) => r.ok);
      return ok ? { ok: true, steps } : { ok: false, reason: steps[steps.length - 1]?.reason || "error", steps };
    }

    /* ── append a line at the end of the document ───────────────────────── */

    async function doAppendLine(op) {
      const t0 = now();
      const rawLine = str(op.line);
      const html = op.html == null ? null : str(op.html);
      if (rawLine == null || (op.html != null && (html == null || html.length > MAX_HTML))) return { ok: false, reason: "bad-request" };
      const line = rawLine.replace(/[\r\n]+/g, " ").trim();
      if (!line || line.length > MAX_FIND) return { ok: false, reason: "bad-request" };
      if (!target()) return { ok: false, reason: "no-editor" };
      const dry = op.dryRun === true;
      if (!dry && cfg().allowEdits === false) return { ok: false, reason: "edits-disabled" };
      const mode = editorMode();
      if (!dry && viewOnlyHint()) return { ok: false, reason: "view-only", mode };
      const at = await getAT();
      if (!at) return { ok: false, reason: "no-api" }; // a blind append would be unverifiable
      const ed = editorEl();
      const scroll = ed ? ed.scrollTop : null;
      const saved = readSel(at);
      const T1 = at.getText();
      const plan = planAppend(T1, line);
      if (!plan) return { ok: false, reason: "doc-end-unknown", mode };
      const { c, text, newParagraph } = plan;
      // A rich paste only where no paragraph break has to be made in the same
      // paste (verified path: plain text); the line's text is checked either way.
      const pasteHtml = html && !newParagraph ? html : null;
      at.setSelection(c, c);
      if (!selIs(at, c, c)) { restoreUser(at, saved, null, scroll); return { ok: false, reason: "selection-failed", mode }; }
      const planned = { edit: { start: c, end: c, insert: text, newParagraph, html: !!pasteHtml } };
      if (dry) {
        restoreUser(at, saved, null, scroll);
        return { ok: true, dryRun: true, mode, ...planned, ms: Math.round(now() - t0) };
      }
      paste(text, pasteHtml);
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
        T1, T2, removedRaw: "",
        ctxB: N1.slice(Math.max(0, cN - CTX), cN), ctxA: N1.slice(cN, cN + CTX),
        newN: nrm(text), oldN: "", na: 0, nb: nrm(text).length,
      });
      if (!ok) return { ok: false, reason: "mismatch", changed: true, undoToken: rec.token, mode, ms, ...planned };
      return { ok: true, verified: "exact", undoToken: rec.token, selectionRestored: restored, mode, ms, ...planned };
    }

    // Pure: where the new line goes. Model text ends "…last paragraph\n\u0003\n";
    // the caret before that final "\n" is the document end (== where Cmd+Down
    // lands; measured). Insert like a person would: at the end of the last
    // paragraph that has text, as "\n" + line, so the new paragraph inherits
    // the BODY style (pasting into a trailing empty paragraph measured: it took
    // that paragraph's default Arial 11, not the Roboto 14 body). Structure
    // markers (tables etc.) before the trailing paragraph → stay in it.
    function planAppend(T1, line) {
      const endMark = T1.lastIndexOf("\u0003");
      const c0 = endMark - 1;
      if (endMark < 2 || T1[c0] !== "\n") return null;
      let c = c0;
      while (c > 1 && T1[c - 1] === "\n") c--;
      const prev = T1.charCodeAt(c - 1);
      if (c !== c0 && prev < 32 && prev !== 3) c = c0;
      const lastEmpty = T1[c - 1] === "\u0003" || T1[c - 1] === "\n";
      return { c, text: (lastEmpty ? "" : "\n") + line, newParagraph: !lastEmpty };
    }

    async function doPing() {
      const at = await getAT();
      let textLen = null;
      try { textLen = at ? at.getText().length : null; } catch { /* ignore */ }
      const editor = !!target();
      const viewOnly = viewOnlyHint();
      return {
        ok: true, version: VERSION, api: !!at, editor, mode: editorMode(), viewOnly,
        editable: !!at && editor && !viewOnly && cfg().allowEdits !== false,
        status: docStatus(), textLen,
      };
    }

    // Test hook (unit tests and the dev harness only): pure helpers, no side effects.
    if (window.__tracelyEditExpose) {
      window.__tracelyEditInternals = { normMap, planDiff, findAll, matchText, planEdit, planAppend, pickHit, pickWhy, hintOf, LIST_MARK };
    }

    /* ── dispatch: one edit at a time ────────────────────────────────────── */

    let chain = Promise.resolve();
    function enqueue(fn) {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    }
    const OPS = {
      replace: (m) => doReplace(m, "replace"),
      insertAfter: (m) => doReplace(m, "insertAfter"),
      appendLine: (m) => doAppendLine(m),
      undo: (m) => doUndo(m),
    };
    const hasOp = (op) => typeof op === "string" && Object.prototype.hasOwnProperty.call(OPS, op);

    window.addEventListener("message", (ev) => {
      try {
        // Same window, same origin, our tag — anything else is not for us.
        if (ev.source !== window || ev.origin !== location.origin) return;
        const msg = ev.data;
        if (!msg || typeof msg !== "object" || msg.source !== SOURCE_IN || msg.type !== MSG_IN) return;
        const id = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id)) ? msg.id : null;
        const op = typeof msg.op === "string" ? msg.op.slice(0, 40) : null;
        const reply = (r) => {
          try {
            window.postMessage({ ...r, source: SOURCE_OUT, type: MSG_OUT, id, op }, location.origin);
          } catch { /* never throw out of the listener */ }
        };
        const fail = (e) => reply({ ok: false, reason: "error", detail: String((e && e.message) || e).slice(0, 200) });
        if (id == null || (op !== "ping" && !hasOp(op))) { reply({ ok: false, reason: "bad-request" }); return; }
        if (op === "ping") { doPing().then(reply, fail); return; } // read-only: never waits behind an edit
        enqueue(async () => {
          lockView();
          try { reply(await OPS[op](msg)); }
          catch (e) { fail(e); }
          finally { await unlockView(); } // after the reply: the caller never waits on this
        });
      } catch { /* never throw out of the listener */ }
    });
  }
})();
