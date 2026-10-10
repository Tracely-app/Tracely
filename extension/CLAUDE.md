# extension/ — the Chrome extension (either developer; Sam uploads)

Read the root `CLAUDE.md` first. `README.md` here says what ships.

## The shape of it

- **No build step.** `manifest.json`, `background.js`, `content.js`,
  `docs-hook.js`, `options.*`, `icons/` ship exactly as committed
  (`server/scripts/pack-extension.sh`). `dev/` never ships.
- **`content.js` is one 6,700-line file with a FILE MAP at the top.** Add code
  inside the section it belongs to. The lines marked `TEST ANCHOR`, and every
  marker in `server/test/helpers/anchors.js`, are fixtures that
  `server/test/ext-*.test.js` slice by: never rename or re-indent them
  (`ext-anchors.test.js` fails by name if you do).
- **`FEATURES`** near the top of `content.js` switches whole features off
  without deleting code (flow flags, Explain in depth, the citation toggles are
  off; genre detection, evidence hints, local checks are on). Prefer a switch
  to a deletion.
- **`background.js`** relays every API call; its `API_PATHS` must stay inside
  `EXTENSION_API` in `server/server.js` (`ext-api-paths.test.js`). A new route
  is appended on the server first, deployed, then used by a build.
- **`docs-hook.js`** is the in-page engine for Google Docs (reads, marks,
  Fix in doc, Cite in doc). `ANNOTATION_REQUESTER` is our Web Store id and is
  pinned by the manifest `key`, so every build — unpacked betas included — has
  the same id. Chrome runs one at a time: remove the old entry before loading.

## Tests, version, release

- `cd server && npm test` runs the extension's tests (29 files slice
  `content.js`; the end-of-turn hook runs just these for an extension turn).
- **Bump the version once per PR, in the last commit, with
  `node server/scripts/bump-extension.mjs patch`** (or `minor`). Never in a
  cleanup PR. `ext-docs-edit.test.js` pins the manifest's permissions and
  shape, not the number.
- **Store zip:** `pack-extension.sh` → manifest at the zip root, no
  `beta.json`, no localhost permission; Sam uploads; label the PR
  `needs:sam-store-upload`; the store row in `STATUS.md` moves when he does.
  **Beta zip:** `--beta` carries the Pro-grant token — never to the store.
- The Web Store cannot roll back. The server stays compatible with every
  installed version (`LEGACY_MODEL_TIER`, `EXTENSION_API` append-only).

## Frozen while a build is installed

Routes and their response fields, error `kind`/`message` text, the
401-then-anonymous behaviour, `corsHeaders()`, port 4477, the host, the
Supabase project, the plan names, the Stripe `PORTAL_URL`. Changing any of
them is an extension release coordinated with a deploy, never a server-only
change (`server/CLAUDE.md`, "Two products on one server").

## Sources: only what backs the sentence, with its receipt

`backingSources` (content.js) offers a search result only when it backs the
sentence: `supports`, and `refutes` for a sentence flagged false or
incoherent. Since 2.21.25 it also never offers a source the server could not
read (`verified: false`): those sit under a collapsed "Couldn't read these —
check them yourself" with Open only. A backing source shows its receipt —
"The source says: “…”" and "from the abstract" / "from the page" — in both
panels and the Docs hover card; Cite in doc and Copy cite exist only on the
backing list. A server without receipts (no `verified`) behaves as before.
The server half is `server/lib/sourceVerify.js` (`server/CLAUDE.md`).

## Every card ends in a fix

Owner, 2026-10-08: a card with only Dismiss is a comment, not help. Since
2.21.26 each note offers the edit it asks for, made in the Doc with Undo:
an unnamed source is **named** from a backing source ("Some researchers have
argued" → "Lee (2021) has argued", `nameTheSource`, the style's own marker);
a line that doesn't belong, a correction left in, a reference listed twice or
cited nowhere gets **Delete** (asks once more first; `deleteEditFor` replaces
the passage and a neighbouring sentence with that sentence, because the hook
never deletes outright); a quote without its page gets a **page box**
(`pageEditFor`; the writer types the number, Tracely never supplies it); a
review note with a rewrite gets **Rewrite in doc**. Tests:
`server/test/ext-card-fixes.test.js`.

## The live source search

Since 2.21.29 the Docs search runs through `searchSources` →
`POST /api/sources/stream` (server-sent events, relayed by `background.js`
over a `tracely-stream` port) and the card shows what is happening: the real
sites found, each one's reading, then the same answer `/api/sources` gives.
A server without the route (404, or 403 for an unknown route) is asked the old
way; a search the server took on and lost is never asked again (it would pay
twice). The search starts on the press of "Find a source", "Keep writing"
closes the card without cancelling, and a "Sources ready" note says when it
is done. Nothing in the live view says a source backs anything — that is the
receipts' answer. Tests: `server/test/ext-live-search.test.js`.

## Citations in context

Since 2.21.30: a citation that names only a person ("(Shiraishi)") asks
`/api/compare-source` with `author` + the essay's subject words and shows that
author's works on the subject (`authorWorks`), saying when no title is about
the sentence's claim; an older server answers as before. A sentence excusing a
missing detail ("does not need a publication date because…") is the writer's
note: never a verdict on it, its card offers Delete and Find the cited work,
never a search to cite it. **One underline per span:** a note over the whole
of a flagged sentence rides on that sentence's mark ("Also here" in its card);
one on its citation sits beside it (`tipCoversSentence`, `factSpanOf`). Tests:
`server/test/ext-citation-context.test.js`.

## The panel

Since 2.21.31 (owner, 2026-10-08: "make this more organized polished …
restructure it") the panel is one list, most serious first: **Claims**, then
**Citations** (the citation notes and the reference list's), then **Writing
feedback** (the review's notes and the stray lines), then the folded
evidence. `foldCards` keeps one card open — the underline last clicked or the
card last opened (`focusCard`), else the first, kept open while the writer
works in it — and folds the rest to a title and one line. The header never
says "all clear" over open notes (its counts: below); the launcher counts the
citation notes too. A citation that is only a surname after a reported claim
("(Shiraishi)", no Works Cited entry) is "Citation names no work" and runs the
author lookup, not "Unnamed source". Tests: `server/test/ext-panel-layout.test.js`.

## Let Tracely fix these, and the panel's header

Since 2.21.33 (owner, 2026-10-08: "it waits a while when it clicks find
citations. It also waits after each fix for you to confirm. I want to have it
finish everything and theres like multiple things waiting for you to
choose"): one press prepares every change `walkPlan` can make. The searches
start together (`fetchSources { batch }`, 3 at a time and 3 a minute — the
server allows a caller 4), and each change is planned by its card's own
function (`docFix`, `docCite`, `docDeleteTip`) with `runDocEdit` only
recording it (`editGate.collect`, nothing sent). The panel lists them as
they are ready — before → after, the backing source — with Accept, Skip and
Accept all; an accepted change is planned again against the doc as it is
then and goes in without a second preview (`editGate.approved`), one at a
time, each after a fresh read. The cursor still types a single card's edit;
nothing drives it through the flags any more. Tests:
`server/test/ext-fix-all.test.js`.

The header counts each kind with its own icon in its finding's colour —
factual errors (red), to double-check (orange), citation issues (amber),
writing notes (orange) — and a count opens the first card of its kind; "All
clear" only when nothing is open and the check is done. There is no "next
check in" countdown. The panel drags by its header, stays on screen, is
remembered per site (`tracely.widget.panelPos`), and a double-click puts it
back. Tests: `server/test/ext-panel-layout.test.js`.

## Underlines hold while the text holds

Owner, 2026-10-08: "use tracely at night … wake up and different things are
underlined". Fact verdicts are kept per sentence with the doc (`VCACHE_KEY`)
and never asked again while the sentence stands. Since 2.21.32 the review
(the writing-feedback notes) is kept with the doc too (`RCACHE_KEY`,
`reviewSnapshot` / `restoreReview`): a reload reads back the same notes and
makes no call. After an edit, a note about one sentence stays while its
paragraph is word for word what the last review read (`carryReviewNotes`);
a changed paragraph, and whole-essay or relational notes (thesis, structure,
relevance, contradiction, the DBQ's), get the new review's answer. Fields keep
nothing across loads. Never re-ask the model about text it has already
answered for: a second answer is a different answer. Tests:
`server/test/ext-stable-marks.test.js`.

## Colours and marks

The verdict vocabulary is the desktop's (`docs/design-file.md`, "UI
decisions"): red `#d93636` wrong or incoherent, orange `#ff5900`
questionable, amber `#ffb800` missing citation, a faint grey still checking —
and never colour alone. Since 2.21.34 every line is one solid line (owner,
2026-10-09: "make them all solid and straight line"); the kind is an icon in
the page's left margin beside the line where each mark starts (`MARK_ICON`,
`drawMarginIcons`: one a line, the most serious; drawn in Docs' SVG so it
scrolls and zooms with the text) and in the legend. Colour only ever means a
finding. Tests: `server/test/ext-mark-patterns.test.js`.

## The hover card, and fix-all's suggestions in the doc

Since 2.21.34 (owner, 2026-10-09: the card "compacts when it is under the
screen … jumps around"): the card's FULL height decides where it goes
(`popNaturalHeight` — it used to be measured after its own cap, so near the
bottom it was squeezed and then judged by the squeezed size); below when it
fits, else above when it fits, else the roomier side; it keeps its side while
it fits and always while the pointer is on it (`popHeld`). It moves as ONE
PIECE: side and size are decided when it opens or its content changes
(`popPlanned`, reset by `paintPop`), never by a scroll, which only carries it
with its line — half out of view included; it is lost only once the card has
left the view. Its button rows wrap rather than clip (`dmActions`). On the way
to it ("the overlay happens to be over another underline, the overlay
jumps"), another underline takes over only when the pointer STOPS on it, a
pointer getting closer to the card is on its way there, and near the card
(140px) it closes only on a 900ms stop (`hoverIntent`, `near`,
`approaching`). Tests: `server/test/ext-hover-card.test.js`,
`server/test/ext-hover-intent.test.js`.

"Let Tracely fix these" ("go do all of them and then disappear and just leave
the accept reject"): the press closes the panel; as each change is ready the
cursor goes to its underline (only when on screen — never a scroll) and leaves
a suggestion in the page's right margin, Docs-suggestion style (`fixCardEl`,
`placeFixCards`: before → after, the source, ✓ Accept / ✕ Reject, stacked and
following the scroll). The cursor leaves with the last one; a note above the
launcher has Accept all / Reject all (`fixPingHtml`). The notes above the
launcher are wired with the chrome, not the panel — they only show while it is
closed. Tests: `server/test/ext-fix-all.test.js`.

## Measuring

Prompt and model changes go through `eval/models/harness` and get a dated
section in `eval/models/FINDINGS.md`; the extension's own live proofs are in
`dev/fix-in-doc/` (Playwright; the public test Doc belongs to a student —
never let an edit reach it).
