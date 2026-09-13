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
   postMessage protocol (they are Google's own scripts). */
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
})();
