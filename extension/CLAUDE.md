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

## Colours and marks

The verdict vocabulary is the desktop's (`docs/design-file.md`, "UI
decisions"): red `#d93636` wrong or incoherent, orange `#ff5900`
questionable, amber `#ffb800` missing citation, grey dotted still checking —
and never colour alone (`MARK_PATTERN`: solid / dashed / double, one legend).
Colour only ever means a finding.

## Measuring

Prompt and model changes go through `eval/models/harness` and get a dated
section in `eval/models/FINDINGS.md`; the extension's own live proofs are in
`dev/fix-in-doc/` (Playwright; the public test Doc belongs to a student —
never let an edit reach it).
