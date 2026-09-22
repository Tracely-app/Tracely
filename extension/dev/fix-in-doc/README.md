# Fix in doc — spike and dev harness (never shipped)

Everything under `extension/dev/` is developer tooling. `server/scripts/pack-extension.sh`
excludes it from every zip, and no manifest entry loads it.

- `engine.js` — the prototype in-editor edit engine. The shipped copy lives in
  `extension/docs-hook.js`; this file is kept as the record of what the harness proved.
- `bridge-notes.md` — the spike's wiring plan. As shipped, the protocol adds the
  `source: "tracely"` / `"tracely-hook"` tags and a same-origin check, `probe` became `ping`,
  `undo` takes `undoToken` (one or an array, newest first), and hints travel as `hint: {…}`.
- `unit.mjs` — the planner tests (ported to `server/test/ext-docs-edit.test.js`).
- `hook-trial.mjs` — drives the SHIPPED `extension/docs-hook.js` in a real Doc over content.js's
  exact protocol; always severs the network before anything but a ping (15/15 on 2026-09-21,
  live Doc verified unchanged afterwards).
- `harness.mjs`, `edit-trial.mjs`, `verify.mjs` (+ `lib.js`, `keys.js`, `mouse.js`, `t.js`,
  `trials/`) — the spike's real-browser drivers. Configure with `TRACELY_PLAYWRIGHT` / `TRACELY_CHROME` (see `pw.mjs`).

## The one rule

The default test Doc (`1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo`) is **someone else's public
Doc, editable by anyone**. No edit may ever reach Google:

- A run that edits must first sever the network the way `edit-trial.mjs` / `harness.mjs` do
  (in-script proxy, upstream sockets destroyed, a canary request to Google must fail, zero
  upstream connections open) before the first edit event is dispatched.
- Afterwards, `node verify.mjs` must show the live Doc unchanged (1021 chars, hash 1843506686).
- Read-only loads are fine without severing.
- Set `TRACELY_EDIT_DOC_URL` to a Doc you own to test real, saved edits.
