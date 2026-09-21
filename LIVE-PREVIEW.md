# Live preview — see the bot's changes the moment they land

When someone asks the Tracely Discord bot to change something, the bot makes the
change on Sam's Mac and pushes it to the **`live-preview`** branch. If you have a
live session running, your app **and** the browser extension refresh on their
own — no pulling, rebuilding, or reloading by hand.

This is a *developer* preview (it runs the app the same way the developers do),
because that is the only way a change can show up instantly — an installed
`.exe` would have to be rebuilt and re-downloaded each time, which is minutes,
not seconds.

## One-time setup (Windows, ~10 min)

1. Install [Node.js 20+](https://nodejs.org) and [Git](https://git-scm.com) if
   you don't have them.
2. Clone the repo and get on the branch:
   ```powershell
   git clone https://github.com/Tracely-app/Tracely.git
   cd Tracely
   git checkout live-preview
   npm install
   ```
3. Create a `.env` file in the `Tracely` folder with the Supabase values.
   **Ask Sam for these** — they're the same values the shipped app already uses:
   ```
   SUPABASE_URL=...
   SUPABASE_ANON_KEY=...
   ```
   The app's AI calls go to `https://api.jointracely.com` unless the file also
   sets `TRACELY_API_URL`.
4. Load the extension in Chrome **once**:
   - run `npm run live` (next section) so `extension-dev/` gets generated,
   - go to `chrome://extensions`, turn on **Developer mode** (top right),
   - click **Load unpacked**, and pick the **`extension-dev`** folder inside
     `Tracely` (not `extension` — the `-dev` copy is the one that hot-reloads).

## Every time you want to watch

From the `Tracely` folder:

```powershell
npm run live
```

That starts the app and begins watching the branch. Leave it running. From then
on:

- **The app** hot-reloads whenever the bot changes it — usually the window
  updates in place; bigger changes relaunch it automatically.
- **The extension** reloads itself, and the tab you're looking at refreshes so
  the new version is active.

You'll see a line in the terminal each time it pulls a change
(`[live] new changes … applying`), and the bot's Discord reply ends with
`🔄 pushed to live-preview — your live preview is updating`.

Stop it with `Ctrl+C`.

## Good to know

- **This checkout is a viewer of `live-preview`.** Each update does a
  `git reset --hard`, so don't make edits here you want to keep — they'll be
  discarded. Edit somewhere else.
- **The production extension is untouched.** `extension-dev/` is a generated,
  git-ignored copy with a dev-only hot-reloader and a `tabs` permission; the
  real `extension/` that goes to the Chrome Web Store never has either.
- **If the app won't start**, it's almost always a missing or wrong `.env` —
  the terminal says so. Ask Sam for the values.
- **Latency** is a few seconds (it checks the branch every 4s). Tune it with
  `LIVE_POLL_MS` if you want, e.g. `set LIVE_POLL_MS=2000 && npm run live`.
