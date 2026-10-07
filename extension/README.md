# extension/ — the Chrome extension

What ships is exactly these files: `manifest.json`, `background.js`,
`content.js`, `docs-hook.js`, `options.html`, `options.js`, `icons/`. There is
no build step; `server/scripts/pack-extension.sh` zips them as they are (and
refuses a zip that contains anything else).

- **Store build:** `server/scripts/pack-extension.sh` → manifest at the zip
  root, no `beta.json`, no localhost permission. Sam uploads it.
- **Beta build:** `pack-extension.sh --beta` → a folder to Load unpacked, with
  `beta.json` carrying the token that grants testers Pro. That file must never
  reach the Web Store.
- **Tests** live in `server/test/ext-*.test.js` (`cd server && npm test`): they
  slice `content.js` by comment markers, so those markers are fixtures — never
  rename or re-indent them.
- **`dev/`** never ships. `dev/fix-in-doc/` holds the live-Doc proof scripts
  for Fix in doc (`punct-trial.mjs`, `hook-trial.mjs`, `verify.mjs`); see its
  README. They need Playwright and must never let an edit reach the public test
  Doc, which belongs to a student.
- **Version:** `manifest.json` is bumped once per PR that changes shipped code;
  the Web Store only moves when Sam uploads (`STATUS.md` says which version is
  live).

Everything else an agent needs is in the root `CLAUDE.md`.
