# The design file and the UI decisions

<!-- Moved verbatim from the root CLAUDE.md on 2026-10-07 (cleanup 6 of 6). History and decision log; edit here, link from CLAUDE.md. -->

## The design file

**[Real Tracely UI](https://www.figma.com/design/k7R5x1M9alKktaMLlZFSJn/Real-Tracely-UI)** — file key
`k7R5x1M9alKktaMLlZFSJn`, one page, `0:1`. Every overlay/widget/settings frame
lives there.

Recorded here because it was not recorded anywhere. A dozen comments in this
codebase cite "the Figma mockup" — the 56px launcher, the 870x606 frame, the
thin-line icons — without a link, so the UI was being built from *prose
descriptions of* the design rather than the design. That drift is what produced
a near-miss palette (`#17171b` for `#1c1c1c`, `#f47b20` for `#ff5900`), pill
buttons where the design has 8px rounded rectangles, and an overlay that never
loaded Instrument Sans at all.

Read it with the Figma MCP (`get_metadata` on `0:1` to list frames, then
`get_design_context` on a node). The overlay frames are named
`Overlay Mockup - <state>`.

**The overlay's frames, and what each one governs:**

| frame | governs |
|---|---|
| `Widget over Document` (+ Refresh / Critique / Show All results) | the panel the launcher opens |
| `Inline Detection (Grammarly-style / Statistic / Citation / Reasoning)` | the hover popover — `ProblemCard` |
| `Find a Source (Searching / Results)`, `Add Citation (Choose Source / Inserted)` | `CitationFlowCard` |
| `Collapsed Launcher` | the 56px circle and its 31px count badge |
| `Inline Detection (Resting State)` | the underline marks with nothing hovered |

**Three underline colours, not thirteen.** `#ff5900` for an unverified figure,
`#ffb800` for a missing citation, `#d93636` for weak reasoning — read off the
marks in those frames, with the popover's dot always matching the mark that
opened it. `PROBLEM_COLOR` in `components/problemCopy.ts` (shared by the
editor and the overlay, and mirrored in `server/shared/marks.js` for every
kind except the desktop-only `off-topic`, which
`server/test/mirror-contracts.test.js` pins) groups all
thirteen problem kinds onto those three, plus grey `#9a9ba1` for `searching`,
because inventing a fourth hue is what produced a purple statistic underline
and an orange "missing citation" one — the design's two colours, swapped.
**The extension follows it since #267** (`extension/content.js`
`MARK_COLORS`: false and incoherent red, questionable orange,
needs_citation amber); see "UI decisions" below.

**Every popover has a 16x10 tail** (`PopoverTail`, path from node `288:545`)
pointing at the sentence, overlapping the card border by 2px so the strokes
meet. The overlay shipped without one for months; on a paragraph with three
flagged sentences a card floating nearby is genuinely ambiguous.

**Two deliberate departures:**

- Source rows show the real favicon, not the design's two-letter provider tile.
  It identifies the publication rather than which API returned it. The tile
  remains as the fallback, in the design's 28px / 8px-radius box so both line up
  on the same grid.
- `Add Citation (Choose Source)`'s library list and text search field are not
  built. Screen Watch persists nothing, so there is no per-document library to
  list, and `overlayWindow.ts` sets `focusable: false` — this window can never
  host a real text input. Its style pills ARE used, in the Results step. (A
  filter box over the results list was built once anyway; it could not be typed
  into, for that same reason, and the frame's full-width **"Search again"** is
  what stands in that slot.)

**The hover popover runs the whole flow, on both surfaces.** `Inline Detection`
→ `Find a Source (Searching)` → `Find a Source (Results)` → `Add Citation
(Inserted)` are four states of one card, and Screen Watch's overlay
(`CitationFlowCard` in `OverlayApp.tsx`) and the document editor's marks
(`DocumentMarkLayer.tsx`) both draw all four. The editor used to answer "Add
citation" by opening the report modal instead — a full-screen context switch
away from the paragraph being written, to answer a question asked about one of
its lines.

- **The wording is shared (`components/citationFlowCopy.ts`), the markup is
  not.** Same rule as `problemCopy.ts`, and for the same reason: the overlay is
  inline styles in a window that loads no stylesheet, the editor is `.docmark-*`
  classes from `index.css`. Two copies of the strings would be two products.
- **The confirmation says different things on the two surfaces, because they do
  different things.** The editor appends a real reference section to the
  document (`shared/worksCited.ts`, written through the same `execCommand` path
  as the marker, so one Undo unwinds both), and "ADDED TO WORKS CITED" is true
  there. The overlay writes the in-text marker into another application through
  UIA and nothing else — it owns no document and cannot see that window's
  reference list — so it says `ADD THIS TO YOUR REFERENCE LIST` over an
  always-visible entry with **Copy entry**, where the frame draws "View Works
  Cited". It carried the editor's label for a while over a list it had added
  nothing to, which is a card that makes a student hand in an essay one
  reference short and hear about it from a marker.
- **`Preview` earns its place differently on each surface.** Over another app
  the overlay writes through UIA, and being shown the citation first is the only
  way to see it before it lands. In Tracely's own editor the insert goes through
  `execCommand('insertText')` — it appears in the sentence a few pixels away and
  Ctrl+Z (or the card's own Undo, which is that same undo stack) takes it back
  out. It is offered there anyway, because the works-cited entry is the half
  that does *not* appear in the sentence.
- **A running flow pins the editor's popover** (`flowPinnedRef` in
  `AnalyzeView`). The card unmounts the instant the pointer leaves the sentence,
  so the flow state is owned by the view, and the hit-test stops swapping marks
  while one is open — otherwise reaching across another underline on the way to
  "Insert citation" takes the card with it.
- **"Find the cited work" is the action on every card about a citation already
  in the sentence** (citation-defect with a lookable shape, fabricated-citation,
  cited-unverified, unsupported-by-evidence on a cited sentence). Owner,
  2026-10-06, on "(Genghis Khan and the, 2022)": the card flagged it *"but it
  doesnt find citation for me"*. `services/search/citedWorkFinder.ts` runs the
  server's `compareSource` algorithm in main (Crossref `query.bibliographic` +
  Open Library, years stripped from scoring, floor 0.5), free and only on the
  button; the decidable half is the leaf `shared/citedWork.ts`. Every field on
  a candidate is the record's; the critique's `citationFix` is only ever an
  extra query string; an empty list is NOT_INDEXED_NOTE, never "fake". The
  editor's Replace writes the record's marker over the citation and swaps the
  Works Cited line (one undo step each); the overlay cannot replace text, so it
  offers Copy citation / Copy entry. Two citations in one sentence: refused,
  never guessed (`citationTarget`).
- **Both surfaces route a card's primary button by its ACTION** —
  `popoverRoute` in `shared/citationAction.ts`. A card about the sentence's own
  citation never appends a second one (`aboutTheCitation`): the editor's
  topical search Replaces, the overlay's offers Copy. The overlay offered Insert
  under "Compare sources", "Review the sources" and "Cite it yourself" until
  this rule existed.
- **The editor's marks are driveable from a browser pane that is not
  displayed** — they were not, until `renderer/src/frameScheduler.ts`. They are
  measured inside a frame callback (deliberately: it batches a keystroke and a
  ResizeObserver callback that both force layout), and Chromium freezes rAF
  entirely on a page that is not compositing, so `marks` stayed empty and the
  popover was unreachable in `npm run preview:ui`. `scheduleFrame` arms a rAF
  and a 50ms timer and takes whichever fires first: the frame always wins when
  there is one, so the batching is unchanged in the shipped app, and the timer
  is the only thing that ever fires in a hidden window. Measured in the
  harness: 0 marks before, 4 after, with the hover popover opening on them.

## UI decisions (ratified 2026-09-22)

Decided from an audit of main at 67120d1. **The extension's colours are
done** (#267, extension 2.21.2: `MARK_COLORS`, the dot CSS and the verdict
washes), and so is its "never colour alone" cue (extension 2.21.4,
`MARK_PATTERN` in `extension/content.js`: red solid, orange dashed, amber
double, with one legend under the panel's cards; grey dotted stays "still
checking"). The desktop half — colours and cue — ships with a normal
desktop release, and should reuse those three lines. Add no new mark or grade UI that contradicts these
in the meantime.

- **One colour vocabulary, the desktop's.** The meanings are `PROBLEM_COLOR`
  in `src/renderer/src/components/problemCopy.ts`, mirrored by `COLORS` and
  the kinds table in `server/shared/marks.js` (every kind but the desktop-only
  `off-topic`): red `#d93636` = wrong or
  invented (contradicted fact, fabricated source); orange `#ff5900` = thin
  evidence or an unverified figure; amber `#ffb800` = add or fix the
  attribution (`PROBLEM_COLOR` also draws `overstated-claim` and `off-topic`
  amber today); blue `#2563eb` = grammar only (`PROSE_ERROR`,
  `DocumentMarkLayer.tsx`); grey dotted `#9a9ba1` = still checking. The
  extension maps onto it — false and incoherent → red, questionable → orange,
  needs_citation → amber (done in #267; it used amber, violet and blue for
  the last three).
- **Colour only ever means a finding.** Colour that encodes anything else
  becomes neutral with a text label: the overlay's claim-type dots
  (`BUCKET_COLOR`, `OverlayApp.tsx`), the orange "Searching for a source" dot,
  the extension's violet flow bracket and its red "any issues" pill.
- **Never colour alone** (accessibility). Every finding also gets a
  non-colour cue and there is one legend; amber `#ffb800` is 1.73:1 on white,
  below WCAG's 3:1 for graphics, and red vs orange is close under
  tritanopia. Style suggestions (`PROSE_STYLE` `#9aa1ad`, grey dotted) must
  stop looking like "checking" once reduced motion stops the pulse.
- **One grader: the server's `/api/grade`** (`src/main/services/ai/gradeDraft.ts`,
  rubric prompt `server/lib/prompts/grade.js`), which the editor's AI Insights
  already uses. Screen Watch's local keyword scorer
  (`screenWatch/watchOutline.ts` → `structure/analyzeStructure.ts` /
  `scoreDraft.ts`) must not show a number or a letter; it may list structure
  findings, with a user-triggered "Grade this draft" that calls `/api/grade`.
