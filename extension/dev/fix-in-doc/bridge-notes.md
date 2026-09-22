# Wiring engine.js into the extension

This is a prototype. Nothing here is committed. The code targets main `67120d1` (2.19.4).

## 1. Where the code goes

- Append the `engine.js` IIFE to `extension/docs-hook.js`, after the existing canvas hook.
  - That file already runs in the MAIN world at `document_start` on `/document/d/*` and `/document/u/*/d/*`.
  - No manifest change and no new permissions. The engine does not need `document_start`; it only reads the API lazily.
- `REQUESTER` must stay the same honest value that `ANNOTATION_REQUESTER` sets (`"tracely"`). Share one constant.
  - Unverified: whether `getAnnotatedText(id)`'s argument is also written to telemetry, the way `_docs_annotate_canvas_by_ext` is. Treat it as if it is: never use a third party's id.
- Delete two things from the engine before shipping:
  - the `__tracelyEditConfig` guard
  - the `__tracelyEditExpose` test hook

  Or keep them: both are inert unless the page sets them. `_test.noApi` only makes the engine weaker.

## 2. Transport (content.js, isolated world)

```js
let docsEditSeq = 0;

// onLate(result): a reply that arrives AFTER the timeout — an ok one means the doc DID change.
function docsEdit(op, args = {}, { timeoutMs = 6000, onLate } = {}) {
  return new Promise((resolve) => {
    const id = `te${++docsEditSeq}-${Date.now()}`;
    let settled = false;
    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-edit-result" || ev.data.id !== id) return;
      removeEventListener("message", onMsg);
      if (settled) { onLate?.(ev.data); return; }
      settled = true;
      clearTimeout(t);
      resolve(ev.data);
    };
    const t = setTimeout(() => {
      settled = true;
      resolve({ ok: false, reason: "timeout" });
      setTimeout(() => removeEventListener("message", onMsg), 15000); // keep listening for a late reply
    }, timeoutMs);
    addEventListener("message", onMsg);
    window.postMessage({ type: "tracely-docs-edit", id, op, ...args }, "*");
  });
}
```

- Messages, in both directions:
  - In: `{type:"tracely-docs-edit", id, op, ...}`
  - Out: `{type:"tracely-docs-edit-result", id, op, ok, reason?, undo?, verified?, mode?, ms?, edit?, target?}`
- The engine runs one op at a time.
  - Measured timings: a replace takes 30–45 ms end to end, a dry run about 10–20 ms, and a refused edit about 1.5 s (the wait for a paste that never lands).
  - A 6 s timeout is generous.
- A late `ok:true` (via `onLate`) after a timeout means the doc did change. Flip the card to "Applied · Undo" and keep its `undo` token.

## 3. `canEditDoc()`

Right now it is `bridgeReady && !harness`, which only works on the developer's own Docs. Replace it:

```js
let inDoc = { api: false, editor: false, viewOnly: true, mode: "unknown" };
async function probeInDoc() { const r = await docsEdit("probe", {}, { timeoutMs: 3000 }); if (r.ok) inDoc = r; }
// at docsMode start, on window focus, and every ~30s while the panel is open
const canEditDoc = () => !harness && ((inDoc.api && inDoc.editor && !inDoc.viewOnly) || bridgeReady);
```

- `viewOnly` is only a hint. It comes from the mode-switcher aria-label ("Editing mode" and "Suggesting mode" were seen; the viewer label is unverified).
- The real test is the read-back. A view-only or locked editor returns `reason:"not-applied"`, and the UI falls back to Copy.
- Keep the Apps Script bridge as the second path only while `bridgeReady` (developer builds). The order is: in-editor engine, then the server bridge, then Copy.

## 4. What each caller sends

| Caller | Now | New |
|---|---|---|
| `docFix(hash)` | `docApply({action:"replace", find: seg.text, replacement})` | `docsEdit("replace", {find: seg.text, replacement: withMarkers(seg.text, f.revision), ...hint(seg)})` |
| `docCite(hash,i)` | appendLine "Sources:"?, appendLine entry, replace with `[n]` | Same three ops through `docsEdit`, **as one group** (below) |
| `addTransition` | replace the whole paragraph line | `docsEdit("replace", {find: issue.passage, replacement: bridge + " " + issue.passage})`. This is a narrower, less stale target, and the minimal diff inserts only the bridge |
| `citeUrlWidget` | `docCite` | unchanged |

`hint(seg)` tells the engine which copy of the sentence to edit when it appears more than once. It never overrides the text check.

```js
function hint(seg) {
  const occ = (hay, needle) => { let n = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) n++; return n; };
  const rects = docsBars.filter((b) => b.hash === seg.hash).map(barViewportRect).filter(Boolean);
  return { occurrence: occ(docText.slice(0, seg.start), seg.text), occurrences: occ(docText, seg.text), rects };
}
// SVG mode:     node.getBoundingClientRect() → {left: r.left + f0*r.width, top: r.top, width: (f1-f0)*r.width, height: r.height}
// Canvas mode:  bars are baselines → {left, top: baseline - size, width, height: size}
// Only pass bars that are inside the viewport. The engine refuses any point that is not on the kix page surface.
```

- If there are several matches, the engine tries the rects first. It clicks once to read the caret offset, then restores the selection. Then it tries `occurrence`, but only when the export's count equals the live count. Otherwise it returns `ambiguous`.

**Citing is a group.** Collect the `undo` tokens, newest first. If any step fails, undo the steps already done, then copy:

```js
const tokens = [];
for (const step of steps) {             // [{op:"appendLine",line:"Sources:"}, {op:"appendLine",line}, {op:"replace",find,replacement}]
  const r = await docsEdit(step.op, step);
  if (!r.ok) { if (tokens.length) await docsEdit("undo", { tokens }); return fallbackCopy(r); }
  if (r.undo) tokens.unshift(r.undo);
}
card.undoTokens = tokens;
```

## 5. UI states (per button: "Fix in doc", "Cite in doc", "Add transition")

| State | Button / status line | Notes |
|---|---|---|
| idle | **Fix in doc** (primary) · Copy fix | shown when `canEditDoc()` |
| applying | **Applying…** (disabled). The other doc buttons are disabled (`docBusy`) | usually shorter than a frame; a refused edit takes about 1.5 s |
| applied | **Applied ✓ · Undo** | the status line says "fixed in doc". Keep `undoTokens` on the card for the session |
| undoing | **Undoing…** | `docsEdit("undo", {tokens})` |
| undone | back to idle; status "undone" | |
| undo failed | "Couldn't undo automatically — press ⌘Z / Ctrl+Z" | `reason` is `not-found` or `ambiguous` once the text has been edited again |
| failed | **Couldn't apply — copied instead** (about 4 s, then idle) | `navigator.clipboard.writeText(text)`. The click's transient activation (about 5 s in Chrome) normally covers this. If the write throws, show **Copy fix** as the primary button instead |
| failed + `changed:true` | "Something changed unexpectedly — **Undo**" | `reason:"mismatch"`: the paste landed, but the read-back differs |

Reason → copy text:

| Reason | Status line |
|---|---|
| `not-found` | "That sentence changed since the last check — copied the fix instead" |
| `ambiguous` | "That sentence appears more than once — copied instead" |
| `view-only`, `not-applied` | "This doc isn't editable right now — copied instead" (covers view-only, offline, and locked editors) |
| `selection-mismatch`, `selection-failed`, `offscreen`, `no-api`, `no-editor`, `timeout`, `error` | "Couldn't apply — copied instead" |

## 6. After an applied edit

Keep the current behaviour:
- `cache.delete(hash)`
- move the new hash's caches over (as `docCite` already does)
- `lastCheckEnd = Date.now() - CHECK_INTERVAL_MS + 3000`

The export lags by a few seconds. Until the next read, `docText` is stale, so drop the old sentence's underline straight away rather than waiting for it to be located.

## 7. Behaviour to expect

- **Author.** Edits are the user's own: they show in revision history under the user's name, and collaborators briefly see the user's cursor jump to the sentence and back.
- **Selection.** The user's selection is restored and shifted by the edit's growth. If it overlapped the edit, it collapses to the edit's end.
- **Scroll.** The user's view does not move.
  - `setSelection` makes kix smooth-scroll to the selection: 8–9 `scrollTop` writes on `.kix-appview-editor` over about 250 ms. It has no no-scroll option, and restoring the old selection does not scroll back.
  - While an op runs, the engine puts an instance-level `scrollTop` setter override on that element, which swallows kix's writes. It lifts after 300 ms with no writes.
  - Native user scrolling bypasses the setter. Measured: the view stayed at 0 through an off-screen edit, and a real wheel scroll afterwards moved it to 300.
  - Side effect: kix's caret-follow scroll is suppressed for about 0.3–0.5 s after an op.
- **Formatting.** Only the changed words are replaced, so formatting, links, and comment anchors on the rest of the sentence survive. Pasted text takes the formatting of its surroundings.
- **appendLine.** It pastes `"\n" + line` at the end of the last paragraph that has text, so the bibliography gets the body style. Pasting into Docs' trailing empty paragraph instead produced default Arial 11 under a Roboto 14 body (measured). Near tables or other structure it stays in the trailing paragraph. Unverified: when the last text paragraph is a list item or heading, the new line may inherit the bullet or heading style.
- **Undo.**
  - If nothing has changed since our edit, the engine uses Cmd+Z / Ctrl+Z and checks the text returned exactly to what it was. If the undo went too far, it presses redo.
  - Otherwise it does a reverse edit: it finds our text by its context and pastes the old text back.
  - A reverse edit cannot bring back inline objects (chips, footnotes) that were inside the replaced words. Sentences that contain those normally do not match in the first place, so they fall back to Copy.
- **Page-world trust.** Page scripts could forge `tracely-docs-edit-result`. Only Google's own scripts and other extensions' MAIN-world scripts run there, and those could edit the Doc directly anyway. Treat results as advisory: the next export read is the source of truth.
