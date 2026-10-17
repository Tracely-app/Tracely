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

Since 2.21.41 every source row says how citable it is, beside its publisher:
Peer-reviewed, Official, Reference work, News of record, Encyclopedia, or
Check this one, with the reason on hover. The text is the meta's own grey,
because colour means a finding. `backingSources` offers the most citable
first, a stable sort, so within a tier the server's order stands.
`credibilityOf` (the "source credibility" block in the shared helpers) is a
copy of the desktop's `src/shared/sourceCredibility.ts`, decided from the
publisher and never by the model. Tests:
`server/test/ext-source-credibility.test.js`, including a check that the
two copies agree.

**Remove a detail.** Owner, 2026-10-13: only a small part or detail, never
the claim. When nothing backs a sentence but the server found a source that
backs all of it except one small detail (a source with `partial: { quote,
missing, trimmed }`, `server/lib/claimTrim.js` decides what counts),
`backingSources` returns it as `partial`, never in the backing list. Both
panels and the Docs hover card then show `TRIM_COPY`: the source, what it
says, the detail it doesn't mention, the sentence with that detail struck
through, and three buttons:
- **Remove the detail** goes through `docFix` with the trimmed sentence
  (`trimPlan`, key `trim:<hash>`), or `fixInField` in a field. The click
  handlers call `docFix` themselves, because edits only start from a click
  (`ext-docs-edit.test.js`).
- **Copy it without the detail** replaces Remove when Docs cannot be edited.
- **Keep as is** drops the card, and "nothing backs it" is back.

Once the detail is removed, the new sentence's sources are that source,
backing, with its receipt (`trimmedSourceEntry`): no second search. A
partial result is saved with the doc like a source list. Tests:
`server/test/ext-trim-detail.test.js`.

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

Since 2.21.54 (owner, 2026-10-14: "remake this extension widget overlay but
more clean. Right now too cluttered, confusing, not well structured, wordy
… include the tracely logo somewhere but make it a solid color") the panel
follows the Figma frame **Overlay Mockup - Widget (Clean)** (Real Tracely
UI, node `627:165`; its components are on the board beside it, `626:147`).
From top to bottom:
- **The header:** the Tracely mark in solid brand orange
  (`MARK_SOLID_SVG`, traced from the store icon and inlined, so no page
  policy can refuse it), the name, and the kind-of-writing chip. What that
  kind means for citations is the chip's hover (`genreNote`). Then Turn off
  (a power icon; in a field it is "Turn off on this site"), Settings and
  Close.
- **One row of tabs** is the count, the filter and the legend at once
  (`panelHeadHtml`): All, then Errors, Evidence and Citations. Each has
  its kind's icon in its line's colour (`kindIcoHtml`, `.k-*` from
  `MARK_COLORS`) and its count, and the long words ("4 factual errors") are
  its title. A tab leaves only its kind's cards (`panelFilter`, in
  `foldCards`), with its first card open. All, or the same tab again,
  shows every kind. There is no legend row and no "Claims (N)" heading: the
  groups are named for screen readers only.
- **The list:** the open card shows its kind, the sentence (two lines),
  why, the suggested fix, then Apply fix · Find a source · a copy icon (Copy
  fix where Docs can't be edited). "Or paste a URL" appears only once a
  search has run for that sentence. Folded cards are one row each: a
  tinted icon tile, the title, one line of the sentence and a chevron.
  `decorateCard`'s buttons go before the copy icon. The "Reading this as …"
  line stays only for a kind Tracely is quiet on, where it explains the
  empty panel.
- **The footer** is drawn only when it offers something: "N fixes to
  review" · Review all (`walkOfferHtml`, the old "Let Tracely fix these"
  strip), or a site's "Turn on for this site".

Buttons are 8px rounded rectangles and the panel is 440px wide.

## A named source is a citation issue; an unnamed one needs evidence

Owner, 2026-10-14, on the flawed AI paper: "According to a 2023 study
conducted by Harvard University, approximately 87% …" should be a citation
issue, not "Needs evidence". "A survey of 25 students at a California high
school found …" should be "Needs evidence", not a citation issue, "as the
survey hasnt been verified, so you cant classify the claim as correct but
improperly cited".

`citationHygieneTips` gives each source it doesn't cite one of two kinds:
- **`uncited`, "Source not cited" (amber, a citation issue).** The sentence
  names who did the work (`sourceNamedIn`): the study's own "by" or "from"
  ("study conducted by Harvard University", "research from Stanford"),
  "according to the National Education Association", or a name in the study
  itself ("a 2024 Pew survey"). It never counts a place ("at a California
  high school") or a kind of body ("leading universities"). Its fix is
  Find a source, then cite.
- **`vague`, "Needs evidence" (blue).** Nobody is named. It is counted with
  "need evidence" (`EVIDENCE_TIP_KINDS`), drawn blue (`markKind`
  questionable) and listed under "Unnamed sources".

The note decides the sentence's kind (`attributionBySentence` →
`sourceAttr`, passed to `flagShown`). For a named source, the model's
"needs evidence" and "missing citation" verdicts give way. For an unnamed
one, only "missing citation" does: the model's own "Needs evidence" card
stays (with its explanation and its search first) and carries the note
(`withoutCarriedNotes`, one card, not two). A false or incoherent verdict
never gives way.

Across the 124 argument-genre documents in the repo, 82 unnamed-source
notes turn from amber to blue. Only the paper's Harvard and Pew sentences
are named and uncited. Tests: `server/test/ext-source-attribution.test.js`.

## A reference list made as a list

Owner, 2026-10-14: Tracely flagged the National Education Association
entry as "Not cited in your text" though the paper cites "(NEA, 2024)", and
also underlined the paper's title. The plain text of that paper was already
right, so the difference was in the document. With the References as a
list, each entry arrives with its marker ("* …", "1. …"), which the page
does not show:
- **The entry no longer matched its citation.** `worksCitedBlock` now takes
  the marker off every entry (`LIST_MARK`: bullets, dashes, "1." "1)" "(1)").
  A list numbered for layout, under a paper that cites (Author, year), is
  checked like any other. A list cited by number, (1) or [1], is not traced
  by name. "[1]" and MLA's "---." are kept as they are. A page break or a
  no-break space beside the heading no longer hides the list.
- **The underline fell on the title.** The quote, with its marker, was not
  on the page. `svgLocate` then matched line by line, and the title's first
  line sits inside the entry's own title. A line wholly inside a quote now
  counts only beside the rest of it, on the line above or below.

Which glyph Google Docs' text export uses for a bullet was not checked
against a real export, so every common one is taken off. Across 240
documents in the repo (16 with a reference list), no flags changed. Tests:
`server/test/ext-reference-list-markers.test.js`.

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
factual errors (red), need evidence (blue), citation issues (amber), and
writing notes when they are on (they are off: see below) — as tabs that
filter the list since 2.21.54 (above, "The panel"); "All
clear" only when nothing is open and the check is done. There is no "next
check in" countdown. The panel drags by its header, stays on screen, is
remembered per site (`tracely.widget.panelPos`), and a double-click puts it
back. Tests: `server/test/ext-panel-layout.test.js`.

Beside the name, a neutral chip says what Tracely reads the writing as
(owner, 2026-10-13). Since 2.21.57 it names one of 56 kinds, and only when
Tracely is sure (`readKind` → `docShown`, `kindTitle`; "56 kinds, named only
when sure", below). An essay's own kind needs 40 words. It is display only:
what is checked follows the kind's genre. Tests:
`server/test/ext-writing-kind.test.js`.

## No overreach: one sentence at a time, no writing tips

Owner, 2026-10-13: "make tracely extension and app both not overpower stuff.
Like for example right now it shouldnt replace more than one sentence at once
which it currently does. It shouldnt help with general writing tips either, so
please remove writing tips in general. That said, from now on needs evidence
should be blue instead of orange."

- **A fix is one sentence for one sentence.** `usableRevision` drops a
  revision of more than one sentence (`oneSentenceFix`, counted with
  `splitLineSentences`), for a card's fix and the "Explain in depth" fix
  alike. A fix saved by an earlier build is held to the same rule when the
  verdict caches load.
- **"Let Tracely fix these" has no Accept all.** Each change is accepted on
  its own; Reject all stays. This replaces the 2026-10-09 Accept all
  cursor tour.
- **No writing tips:** `FEATURES.essayFeedback`, `resumeTips` and `offTopic`
  are false. No `/api/review` call is made, and no essay notes, resume tips,
  off-topic lines or leftover-correction notes are shown. `detectGenre` still
  runs on every read, since the kind of writing decides what is checked.
  There is no "Writing note" in the legend.
- **"Needs evidence" is blue** (`#2563eb`): its underline, icon, dot and card
  wash. The launcher's count badge keeps the brand orange; it counts
  findings and is none of them.

Tests: `server/test/ext-no-overreach.test.js`, `ext-fix-all.test.js`.

## "Needs evidence" is searched first

Owner, 2026-10-13: "instead of having it say six to double check, please
search for it first and say like look for evidence to back it up". A
`questionable` sentence (the card and legend say "Needs evidence", the chip
"N need evidence") is searched automatically. `EVIDENCE_FIRST` sets the
limits: up to 3 of a check's new, shown flags, one at a time, and never the
writer's last 2 searches of the day. The limit uses the `limits.sources` and
`usage.sources` from the entitlement answer (`noteSearchUsage`), less the
automatic searches started since that answer. When nothing backs the
sentence, the card says so and adds "Look for evidence to back it up, or
narrow the claim." (`EVIDENCE_COPY`). In Docs, the first card says what the
search found and opens it with "See the sources", never with a second
search. When it found nothing, "Find a source" searches again (below). A
failed automatic search stops the rest and is not reported. Every
other flag's automatic search is still behind the opt-in Auto-src switch
(`FEATURES.autoSources`, off). Tests: `server/test/ext-evidence-first.test.js`.

## A study Tracely can't find

Owner, 2026-10-15, on "A study involving 12 college students found that 10
participants reported positive experiences using AI": "something like this
should be flagged as should be deleted, as tracely cant find anything like
this. Furthermore, make it where pro and student plans has tracely find
evidence on the web to replace this with, that fits the text".

- **Which sentences.** A sentence that reports what an unnamed study found
  (`STUDY_REPORTS`, with no one named by `sourceNamedIn` and no citation in
  it), once its search has come back with nothing that backs it
  (`unfoundStudy`). "Nothing" means no source, no detail to trim, and no
  source it couldn't open: an unread page might be that study, so it never
  says "can't find" over one. A named source stays a citation issue.
- **What it says.** The card (both panels, the Docs hover card's problem
  card and its sources step) reads "Tracely couldn't find this study" with
  **Delete the sentence**. That is the note's one-replace delete
  (`docDeleteSentence`, through the preview, with Undo). The card's own fix
  row goes, so it has one set of buttons. A field can't delete a sentence,
  so there it says to.
- **Student and Pro: Replace with evidence.** The owner chose this over a
  reworded sentence: no model writes it, so every word is the source's or
  names it.
  - Tracely searches the point the study is said to have found, without the
    study: no counts, no figures, and "participants" become who it was of
    (`studyFinding`: "College students reported positive experiences using
    AI.").
  - It takes the first source that backs that point and has a one-sentence
    receipt of at most 45 words, and offers its words quoted, with who said
    them, in the doc's style (`evidenceReplacement`): "According to Lee and
    Park (2023), “…”". In MLA, a body that published its own work is cited
    by title, and the body is still named in the sentence.
  - **Replace in doc** puts the sentence and its reference entry in as one
    group with one Undo (`citePlan` with `swapped`). In a field it is
    Replace in field, or Copy.
  - It spends one of the plan's source searches. On Free the card has one
    line on what Student and Pro add, and See plans (`canRecommend`).

Not seen in a browser: the mock server's search always returns a source it
couldn't open, so it never comes back empty. Tests:
`server/test/ext-unfound-study.test.js`.

## "Find a source" always does something

Owner, 2026-10-13: "find a source action button doesnt work properly".
Three things made it look dead, and each is fixed:

- **A press never waits.** `sourcesInflight` counts only the writer's own
  searches. An automatic one (`EVIDENCE_FIRST`) waits for the writer's,
  never the other way round. Before, a press during the automatic "Needs
  evidence" search found the one slot taken, and the card flipped back
  without a word. Two presses on two sentences both run; the server allows
  a caller 4 a minute.
- **A failed search says why, in the card that asked** (`sourceFailures`,
  `searchFailureNote`). The server's limit messages are shown as they are.
  `no_key`, `server` and 5xx answers read "Tracely's source search isn't
  working on our side right now". Offline reads "Couldn't reach Tracely".
  An automatic search's failure shows only in its own hover card, when the
  writer opens it.
- **A "Needs evidence" card whose own search found nothing searches again**
  on Find a source. It used to reopen the same empty answer.

Field mode also no longer re-searches a sentence that already has sources.
Tests: `server/test/ext-find-source.test.js`.

## What each plan gets

Owner, 2026-10-13: "it should not say explain in depth for pro, the only
things that pro users should need is extra evidence recommendations, so
extra evidence that tracely thinks will make their essay or writing BETTER.
Normal tracely only helps with their mistakes and bad parts, pro and
student plans allow for tracely to give recommendations."

- **Free (Starter)** gets the flags, their one-sentence fixes and their
  sources, "Needs evidence" searched first included.
- **Student and Pro** also get **evidence recommendations**
  (`evidenceCandidates`, `RECOMMEND_COPY`). These are up to three accurate
  sentences that make a causal or arguing point and carry no source. They
  sit folded at the foot of the panel, under "Evidence recommendations".
  Nothing is searched until Find evidence, which spends one of the plan's
  source searches. The gate is `canRecommend` / `RECOMMEND_PLANS`
  (content.js) and `RECOMMEND_PLANS` (options.js); `mirror-contracts`
  keeps both equal to the paid plans. Like `canDeep`, it is cosmetic.
- **On Free**, the section is one line saying what Student and Pro add,
  with See plans (`openOrderPage`). It has no card, quote or search.
- **"Explain in depth" is off** (`FEATURES.deepDive` false). The hover card
  draws nothing, and the panel's row is hidden by its CSS. The server's
  `deep: true` path stays for installed builds.

Settings shows an Evidence recommendations tile or the locked line. The
Thorough meter is gone from the extension's Settings, because Thorough now
only serves desktop critiques. Tests: `server/test/ext-evidence.test.js`,
`ext-2-20.test.js`, `ext-settings-page.test.js`, `extension-beta.test.js`.

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
scrolls and zooms with the text) and in the panel's header tabs, which are
its legend since 2.21.54. Colour only ever means a finding. Tests: `server/test/ext-mark-patterns.test.js`.

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
left the view. Its button rows wrap rather than clip (`dmActions`).

Since 2.21.35 the hover is Grammarly's (owner, 2026-10-09: "the cursor
detection hover system is bad. make it as snappy and just like grammarly …
when I stop hovering over underline, sometimes it stays"). 2.21.34 held the
card while the pointer got closer to it and needed the pointer to stop on
another underline; a decision only ran on a mouse move, so a pointer that
stopped while held left the card up for good (reproduced on the stand-in:
still open 5 s later). Now every state but "on the card or its own
underline" ends in a timer (`hoverIntent`; a timer whose decision no longer
holds decides again, move or no move): it opens in ~0.1 s
(`HOVER_OPEN_MS` 70), another underline takes over in `HOVER_SWAP_MS` (90),
empty page closes it in `HOVER_HIDE_MS` (140), and only inside the safe
triangle does it wait for the pointer to rest (`HOVER_REST_MS` 220). The card
hangs from the POINTER's spot on the line (`popAnchorDx`, `POP_CARET`), not
the line's middle, so straight down is the card. Leaving the window, typing
in the doc (`typingClosesCard`, not into the card) and Esc close it; the
panel and the suggestions cover the underlines beneath them
(`overTracelyUi`). Tests: `server/test/ext-hover-card.test.js`,
`server/test/ext-hover-intent.test.js`.

Since 2.21.36 (owner, 2026-10-09: "how come hovering off it doesnt make the
overlay go away? … the sweet spot where when I go off of it it goes away but
not so fast that I cant go back if I suddenly change my mind. Also add
animations for the overlay popups"): on the stand-in the card stayed only
while the pointer was on it or on its own underline — and since it hangs
under the pointer, moving DOWN off a line lands on it. Off both, it now waits
`HOVER_HIDE_MS` (350; 2.21.35 closed in 140, before a change of mind could
reach it), fading toward 35% and drifting 4px while it waits (`popLeaving`:
opacity and `translate` only); the pointer back brings it straight back,
else it leaves from where the fade got to. The moves are heard in the
CAPTURE phase, mouse and pointer both, so a page that stops them on their
way up (Docs may, over its own chrome — not checked in real Docs) cannot
leave a card waiting; leaving the card feeds the hover itself
(`pointerleave`), and a throw in the hover can never leave a card up
(`hoverDecide` in a try). Motion: the card pops out of its underline with a
little give (`POP_SPRING`, 260ms), its rows step in (`stepIn`, again when its
step changes — never on a repaint of the same), the suggestions in the
margin slide in once each (`fixCardsShown`), and the notes above the launcher
rise in once (`.ready-ping.enter`). Reduced motion: no movement, only the
dimming that says it is leaving.

Since 2.21.37 (owner, 2026-10-09: "overlay when hovering over underlines
still keep jumping around"): measured on the stand-in with motion off, a card
held its place on its underline — what moved was around it. It opened
wherever the pointer entered its line (main: x=354, 494 or 641 for one line),
a pass across a paragraph opened a card (70 ms), another underline took over
in 110 ms, and 2.21.36's spring, slide, scale and drift moved every one. Now
the card hangs from the START of its line (`POP_LINE_IN`: the same place
every time — 368 for all three), opens after `HOVER_OPEN_MS` 160 (a pass
opens nothing), switches after `HOVER_SWAP_MS` 220, ignores a 1px change in
its line's box, and opens, switches and leaves with fades (a 4px rise on
open; nothing scales or bounces).

"Let Tracely fix these" ("go do all of them and then disappear and just leave
the accept reject"): the press closes the panel; as each change is ready the
cursor goes to its underline (only when on screen — never a scroll) and leaves
a suggestion in the page's right margin, Docs-suggestion style (`fixCardEl`,
`placeFixCards`: before → after, the source, ✓ Accept / ✕ Reject, stacked and
following the scroll). The cursor leaves with the last one; a note above the
launcher has Accept all / Reject all (`fixPingHtml`). The notes above the
launcher are wired with the chrome, not the panel — they only show while it is
closed. Tests: `server/test/ext-fix-all.test.js`.

Since 2.21.37 (owner, 2026-10-09: "when you click accept all there is no
cursor but I want tracely cursor to go around and change each one and leave
the accept or reject choice next to each change that it makes") each change
is made IN ITS PLACE: the cursor goes to it, strikes the words it takes out
on their exact runs (`fixInlineGeo` → `svgRangeRects`, the Type preview's own
locating) and types the new words into a chip right under the change with
✓ Accept and ✕ Reject (`fixMarkMake`, `fixMarkReveal`, `fillFixChip`,
`placeFixMarks`: chips keep clear of each other and of struck words).
Nothing reaches the Doc until Accept; Accept all sends the cursor
round again to click each ✓ (`fixClickAccept`). A change the page can't show
in place — the Works Cited list, a sentence Docs isn't drawing whole — keeps
its card in the margin. A test page opts in with `harness.canEdit` (its edits
go nowhere: "Docs' editor isn't ready").

## While the page scrolls

Since 2.21.55 (owner, 2026-10-15: "when you scroll up and down when tracely
is typing suggestions, it is really laggy and the cursor and stuff clips out
of frame"). The struck words, the chips, the margin cards, the Type preview
and the cursor are all overlays over the text, and each of them used to
follow it every frame. Each frame they read the page's geometry, then wrote
their own, then read again, so Chrome laid the document out several times a
frame while Docs was scrolling it. Their layers also covered the whole
window, so a half-scrolled strike or chip painted over Docs' toolbar. Now
(the "while the page scrolls" block in content.js):

- **While the page moves, they step aside.** A scroll (`noteDocScroll`, heard
  in the capture phase) fades every layer out in 90 ms and makes it inert.
  Nothing is measured until `SCROLL_SETTLE_MS` (140 ms) after the last
  scroll; then `docSettle` places each once, where its words now are, and
  fades it back. Grammarly's cards do the same.
- **Every layer is the document's box.** `clipLayer` / `docClip` give the
  editor's scroll area with `overflow: hidden`. Inside it a position is the
  client's less the box's corner, so nothing of Tracely's paints outside the
  document. The Type preview's card is its own fixed box: in the text it is
  clamped inside the document's box, and off screen it sits beside the
  panel's card. Once the cursor is in the text, it is hidden while its words
  are outside the box (`tcPin` / `tcFollow`).
- **No frame loop once the animation is over.** Placing reads every rect and
  every chip's size first, then writes only what changed (`setStyle`). The
  chips and cards are placed when something changes (`scheduleFixPlace`)
  and whenever the underlines are re-located (`followDocLayout`, from
  `requestDocsMarks`). The Type preview runs a frame at a time only while it
  glides, strikes and types; after that it runs every `FIX_PLACE_TICK_MS`.
  Its canvas is redrawn only when its words moved or one more letter went
  in. The tour's glide re-reads its target every frame (`fixGlide`), so a
  scroll mid-glide lands on the words, not where they were.

Measured on a Docs stand-in (an SVG annotation layer like Docs', a scrolling
editor box under a toolbar, 12,000 laid-out nodes). Each of 150 scroll steps
was timed, with that step's frame callbacks and the layout it left behind:
- **Review all, three chips on the page:** 23.8 / 31.7 / 45.8 ms (p50 /
  p95 / max) before, 4.4 / 6.2 / 10.6 ms after. Rect reads per step went
  from 32.6 to 0.
- **A Type preview open:** 12.5 / 19 / 29.4 ms before, 5.0 / 5.9 / 7.6 ms
  after. Rect reads went from 33 to 0.
- **The toolbar:** with a struck line half under it, a strike painted over
  it before and nothing does after.

Not measured in real Docs. Tests: `server/test/ext-fix-all.test.js`,
`server/test/ext-type-preview.test.js`.

## Review all: never cut, easy to stop

Owner, 2026-10-16: "it clips randomly, please make it easier to stop the
auto run and for the accept vs reject tabs next to the fixes, they clip
randomly and off of the response … make it overall better and more
managable and less confusing". What was found, on a Docs stand-in with a
side panel open:
- **Margin cards were cut in two.** A card was kept on screen against the
  window's edge, while its layer clips to the document's box, which a side
  panel (comments, Gemini) narrows. The card for "Add the list" ran 103px
  past the box, and its ✕ Reject with it. Cards now stay inside the box
  (`placeFixCards`), short of the editor's own scrollbar (`docClip` uses
  `clientWidth`). Narrow margins put a card over the page's right edge
  instead.
- **Nothing is shown half.** A chip goes under its change; where that runs
  out of the box, over it; where neither fits, it waits out of view
  (`placeFixMarks`). A card that can't fit whole waits too. Both are
  counted, and the bar says "N out of view".
- **A run Docs reuses never places a mark.** Docs reuses its text runs when
  it redraws a line, so a run that was still there could be showing other
  words. Each strike's run now remembers its words (`raw`, `fixGeoStale`):
  a changed run means the change is found again, and its strikes re-fit
  when the line re-wraps (`fitStrikes`). If it can't be found, nothing of
  it is drawn.
- **The bar above the launcher is the run's one control** (`fixPingHtml`).
  While preparing, it reads "Preparing fixes · 2 of 7 ready" with Stop;
  Esc stops it too (`fixStopKey`). After, it reads "N fixes to review in
  your doc", plus "· N out of view", with See all (the panel's list, where
  every fix has Accept and Skip) and Reject all.
- **Stop stops the cursor at once** (`fixTour.instant`). Nothing more is
  prepared, and what is ready appears in its place without the glide and
  the typing.

Tests: `server/test/ext-fix-all.test.js`.

## A wrong source, and a named source not cited

Owner, 2026-10-15, with an answer key for a twenty-sentence test sheet
(`server/test/fixtures/citation-key.js`). Tracely got 11 of the 20 right:
every false sentence and three of the four overstated ones, and none of
the eight citation problems. The owner chose:
- **"Correct fact, wrong citation" is an amber "Wrong source cited" card.**
  Examples: Venus cited to the OECD, PISA cited to NASA. The fact check
  judges only the claim, and any citation counts as one. So the server
  asks a separate question after it: could the cited source be where this
  claim comes from? (`server/lib/citeFit.js`, its own pinned prompt.) It
  answers `wrong_source` only to a build that sends `citeFit: true`.
  - **Behind `FEATURES.citeFit`, which is off** until `eval/citefit/run.mjs`
    has measured it against production.
  - **The card:** amber, under Citations, with Find a source. A source cited
    from it replaces the wrong citation (`replacedCitationOf`), and "Find the
    cited work" is not offered, because it is the wrong work.
- **"Correct fact, missing citation": named sources only.** A sentence that
  credits a named organisation with a finding, a recommendation or a
  publication, with no citation, gets "Source not cited". Examples: "The
  Centers for Disease Control and Prevention recommends …", "In 2023,
  UNESCO published …" (`orgCredited`).
  - An organisation is an acronym or a name with a body's word in it, never
    a person.
  - It applies only in writing that cites its sources, and not when the
    reference list names the body: that is MLA's signal phrase.
  - Across the 387 essays and papers in the test corpora it adds two notes,
    both right.
  - Basic facts and general claims (the key's 5 and 11) are still not asked
    for a source. That is the owner's choice, against underlining every
    sentence.
- **An acronym is a name.** UNESCO, NASA or COVID in a sentence means it is
  not a general statement, whose "Needs evidence" `flagShown` hides. "AI"
  and "US" are still words.

Tests: `server/test/ext-wrong-source.test.js`, `server/test/cite-fit.test.js`.

## When Docs is slow to select

Owner, 2026-10-15: "Couldn't apply (Tracely couldn't select that sentence
safely, so nothing was changed)", "says this sometimes". It was not
reproduced in real Docs, so the three likely causes were fixed in
docs-hook.js and content.js:
- **Docs settles a selection late.** Selecting a sentence Docs hasn't laid
  out yet (far off screen, from the panel), or copying it, can lag. A
  refusal now runs the read → select → check block again every 25 ms, for
  up to 600 ms (`settled`, `SELECT_SETTLE_MS`). Each block is still
  synchronous, and only one whose checks all pass pastes. Text that changed
  in the meantime is read again.
- **Without the text API, a click lands a character off.** The clicks come
  from the underline's measured edges, and the full stop at the end is
  about 2px wide. Docs' copy of the selection now guides the keys: the
  start moves with the caret, the end with Shift+Arrow, up to 6 characters
  (`mendSelection`). The selection must be the sentence with no space at
  either end, so a paste no longer swallows the space beside it.
- **The hint was measured before the Type preview.** The preview waits for
  Accept, and the page can scroll in the meantime. A step's `freshHint`
  measures the underline again when the step is sent.

A refusal names the check that failed (`check`: selection, text, copy or
plan) in the console line `[tracely] edit …`. Tests:
`server/test/ext-docs-edit.test.js`.

## Kinds of writing, and how each is cited

Since 2.21.35 (owner, 2026-10-09: "make it extremely good at type of
literature detection … if it is world history DBQ, no need for citations and
worked cited. If it is a poem, cite this way. If it is a research paper, cite
that way … resumes or emails") `detectGenre` tells 18 kinds apart from the
text alone (free, no model): dbq, research, lab, literary, poem, story,
script, speech, news, personal, email, coverletter, letter, resume, notes,
annotated, homework, prose. The most distinctive shapes are looked for first
(a salutation and a sign-off, numbered tasks, a script's speakers, a
resume's headings, a DBQ's document numbers …). What each kind means:
`GENRE_QUIET` (homework, poem, story, script) sends nothing to be checked;
`GENRE_OWN` (resume, letters, email, personal essay, notes, annotated
bibliography) shows a wrong public fact but never asks for a source; a DBQ
cites its documents, needs no source for outside evidence and has no Works
Cited (no page / "names no work" / unnamed-source notes either); a speech or
a news story names its source in the sentence ("According to … in 2021, …",
`attributeAloud`) and has no list; `genreWantsList` (prose, research,
literary, lab) keeps a Works Cited. A literary essay quotes a poem by line,
a play by act.scene.line, a novel by page (`literaryForm`). Tracely cites in
the style the doc already uses (`docCitationStyle`) unless the writer picked
one (`settings.styleChosen`); MLA when it says nothing. The panel says what it
is reading and what that means (`genreLineHtml`). Measured on invented
documents (`server/test/fixtures/`): the 67 it was tuned on, all right (main:
20); 50 written blind by another author, 40 right before any tuning (main:
11), 49 after general fixes; and 40 more written blind after those, scored
once and left untuned: 38 right (main: 8) — keep that set untuned, it is the
honest number. Both blind sets must stay at 90% or better. Tests:
`server/test/ext-writing-types.test.js`. Since 2.21.57 these 18 are the
genres under 56 kinds (below).

## 56 kinds, named only when sure

Since 2.21.57 (owner, 2026-10-15: "Fix it for a plethora of writing, so it
is very unlikely that tracely will detect something wrong. Before
incorporating, list all things that could be labeled."). The owner approved
56 kinds in five groups by what they change. `WRITING_KINDS` (content.js)
holds each kind's header title, its genre (which decides the checks, so a
new kind is checked like its group's old kind), its "Reading this as …"
label, and the broader kind a near miss falls back to.
- **Checked, with a Works Cited:** argumentative, informative, compare and
  contrast, cause and effect, problem and solution, rhetorical analysis,
  summary or response, literary analysis, book report, research paper,
  literature review, proposal, lab report, case study, and "Essay" when it
  is none of them.
- **Checked, sources named in the sentence:** speech, debate case,
  presentation script, news article, op-ed or editorial, feature or
  interview, press release, blog post, discussion post.
- **Cites its own documents:** DBQ, synthesis essay ("(Source A)").
- **The writer's own account:** personal essay, college or scholarship
  essay, reflection, journal entry, review, bio, social media post, email,
  letter, cover letter, recommendation letter, memo, resume, notes, outline,
  study guide, meeting notes, peer review, instructions or recipe, lesson
  plan, annotated bibliography, and a reference list on its own.
- **Quiet:** homework, math work, survey, code, poem, song lyrics, story,
  script.

Three kinds moved group on the owner's yes. A blog post and an op-ed (a
letter to the editor included) name their sources in the sentence, with no
Works Cited. A reference list on its own (`workscited`, genre `annotated`)
is never asked where each entry is cited.

**How it decides** (`readKind` → `kindScores`). Every kind is scored and
the highest wins, so one stray cue no longer decides. Before, a "Source B"
made an AP Lang synthesis essay a DBQ.
- **9.5 and up:** a shape that is nothing else (code, "[Chorus]", "FOR
  IMMEDIATE RELEASE", "Resolved:"), or the document naming itself in its
  title block ("Rhetorical Analysis", "Peer Review for Kenji's Essay"). A
  title naming a kind of document (outline, peer review, reflection,
  proposal, study guide, lesson plan, summary) outranks one naming an essay
  kind, so "Argument essay outline" is an outline.
- **8 to 9:** strong forms: a letter's two ends or its signature block, a
  memo's head, minutes, a lesson plan, slide cues, a survey's choices, a
  reference list, an interview's questions.
- **6 to 8:** the old order's shapes as strengths, earlier ones stronger
  (homework, script, resume, DBQ, annotated bibliography, speech, lab, poem,
  notes).
- **4 to 6:** the essays' and the voices' cues (research, literary,
  rhetorical, summary, news, feature, story, personal, college essay,
  reflection).
- **1:** only an essay's own words (`essayKindOf`). A sub-kind is named only
  when its words clearly lead; two close together, or none leading, is
  "essay".

In a field the site counts too (`placeKind`). A mail client's box is an
email (a cover letter or a reference sent by mail stays one), a class
discussion board a discussion post, a social site a post, a review site a
review, an opinion page an op-ed, LinkedIn's About a bio. Docs passes no
place.

**The header names a kind only when very sure** (`KIND_SURE`, a score of 7
or more; `docShown`). The checks follow the kind's genre either way
(`docKind`), and a quiet kind still says why it is quiet. Owner, 2026-10-15,
chose this over a chip on every document. Measured on the first 625
documents, before the fresh set was written: from 7 up a kind was wrong 2%
of the time, from 4 to 7 one time in six, and read off an essay's words
alone (score 1) 43% of the time, often not an essay at all. So a plain
essay usually shows no chip.

**Measured** on invented documents, five or more of every kind in each set,
by 24 writers who never saw the detector (`server/test/fixtures/`):
- **Tuned on (313):** 86.9% the exact kind, 3.2% in a group that changes
  the checks; the header names 63% and is wrong on 0.3%.
- **Scored blind once, then learned from (312):** 75.0% exact and 13.1% in
  the wrong group blind (main: 37.2%); 80.1% and 8.7% after; the header
  names 63% and is wrong on 1.6%.
- **Fresh, scored once and untuned (312), the honest number:** 72.1% exact,
  13.5% in the wrong group (5 checked documents read as quiet). The header
  was wrong on 13.8% naming every document; naming only what it is sure of,
  it names 57% and is wrong on 3.2%. Main on the same: 37.5% in the wrong
  group, 12 read as quiet. Keep it untuned.
- **The 157 older documents:** as main, but for the moves above, and two of
  main's misses now right.
- **Cost:** about 1 ms a read, 18 ms for 8,500 words; an unchanged text is
  not read again (`kindRead`).

What it still misses on new writing is a long tail: a first-person story
read as a personal essay, an op-ed with no byline or masthead read as an
argument, a prose poem, a document in a shape no rule knows yet (a recall
notice, an R script with long comments).

**The model's kind** (owner, 2026-10-15: "model next"; `askKind`,
`kindWithModel`, server `/api/kind`). It is behind `FEATURES.modelKind`,
which is off until the model is measured on the same corpora
(`eval/kinds/run.mjs` against production, then `eval/kinds/score.mjs`). When
on:
- **When it asks:** once per document, and again only when the opening or
  the size changes a lot (`kindPrint`), at most every 30 s. Never for under
  40 words, and never where the site already says (`placeKind`).
- **What it sends:** the first 3,600 and last 400 characters.
- **What it uses:** a kind the model names decides the checks and the
  header. "Unsure", a failure, a limit or an older server (404, never asked
  again) leaves the rules' answer.
- **Before turning it on:** add the 4,000 characters to PRIVACY.md's
  "Checking" paragraph and the reads to its usage-count row.

Not checked in a browser: the harness page stands down while the browser
pane is hidden. Tests: `server/test/ext-writing-kinds.test.js`,
`server/test/ext-writing-kind.test.js`.

## Works Cited when the writing needs one

Since 2.21.35 (owner, 2026-10-09: "when it needs to its still not
automatically inserting works cited"): an essay or paper that cites works and
has no list gets a "No Works Cited" note (`noListTip`) with **Add Works
Cited** (`docAddWorksCited`): every cited work is looked up
(`lookupCitedWork`, `/api/compare-source`, no model, 10 a minute) and listed
only when a record is plainly that work (`citedMatchFor`: the cited author
and year, or most of a cited title; an author-only citation only when exactly
one of their works is about the claim); the heading and the entries go in at
the end as one group with one Undo, and the rest are named for their own
cards. It is one of "Let Tracely fix these" suggestions (act `list`, its card
at the foot of the margin). Replace citation now starts the list too where
the kind of writing keeps one. Tests: `server/test/ext-docs-edit.test.js`,
`server/test/ext-fix-all.test.js`, `server/test/ext-writing-types.test.js`.

## Settings (options.html)

Since 2.21.38 (owner, 2026-10-11: "fix this page on the extension to look
more like the rest of the app in terms of UI and UX, and also make this easy
to navigate to from the overlay widget extension") the options page is laid
out like the desktop's Settings, from the desktop's own rules (`.settings-*`,
`.btn*`; its tokens, light and dark): a sidebar of sections — Account,
Checking, Google Docs, Sites, Privacy — one panel at a time, the section in
the address (`#sites`, so a reload or bookmark comes back to it). Account is
a "Signed in as …" row (Sign in with Google / Sign out) and a plan card: the
plan's name in every state (`acctPlan`; a tester signed out reads Pro with a
Beta badge, `acctBeta`), what the plan includes from the SERVER's own limits
(`renderIncludes` — never a copy of the price page; nothing for a server that
meters nothing), the usage lines, and one link (See plans signed out, else the
account's own: Upgrade or the subscription). Google Docs is the desktop's
switch row; deleting the account is a danger row under Privacy, signed in
only. The sidebar's brand is the Tracely mark (`icons/mark.png`: the
desktop's `figma-logo.png` cut to 96px, the logo the launcher draws), not
the paper plane (owner, 2026-10-13). So are the toolbar icons
(`icon16/48/128.png`, owner, 2026-10-14): orange on transparent, 128 with
Chrome's 16px of padding (`server/test/ext-icons.test.js` reads their
pixels). The widget's header has a gear (`panelSettings` → `openSettings` →
background.js `tracely-openSettings`): the worker opens Settings with
`openOptionsPage`, which brings an open Settings tab forward, and a section,
when one is named, travels through storage (`settingsOpenAt`, honoured for a
minute, taken once). `SECTIONS` (options.js) and `SETTINGS_SECTIONS`
(background.js) must name the same sections as the page. The widget's own
switches (citation suggestions, auto-sources) are kept per site in the page's
localStorage, so the page cannot show them. Since 2.21.39 (owner, the same
day: "it looks like a big card and a lot of empty space, fix this to
actually fit in the entire frame") it fills the tab: no card, the sidebar
the window's height and sticky, the section a centred 680px column. Tests:
`server/test/ext-settings-page.test.js`.

## Measuring

Prompt and model changes go through `eval/models/harness` and get a dated
section in `eval/models/FINDINGS.md`; the extension's own live proofs are in
`dev/fix-in-doc/` (Playwright; the public test Doc belongs to a student —
never let an edit reach it).
