# Tracely ✈️

The Tracely server runs every AI call for the desktop app, the Chrome extension and the web app, over the OpenAI API. It is hosted at `https://api.jointracely.com` (see [DEPLOY.md](DEPLOY.md)); run locally, the only key you need is an OpenAI API key.

## Setup (once)

1. Paste your key into `.env` in this folder:
   ```
   OPENAI_API_KEY=sk-…
   ```
   The running server picks it up automatically — no restart needed.

2. Start the server:
   ```
   node server.js
   ```

3. Open **http://localhost:4477** and start typing.

## The web app

`/` serves the built desktop renderer (`../dist-web`, from `web.vite.config.mts`) when it exists, and otherwise the vanilla app in `public/app/` (Home, Documents, Analyze, Library, Watch, Settings), which `/classic/` always serves. The model is picked in Settings by tier — Standard `gpt-5.6-luna`, Thorough `gpt-6-astra` — and that choice applies only on a local server: the hosted server refuses the web app's browser origin and answers `PUT /api/prefs` with 403.

## Google Docs widget

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
2. Run the Tracely server (`node server.js`) if you want the extension to use it: it prefers `localhost:4477` when that answers and otherwise uses `https://api.jointracely.com`.
3. Open any Google Doc — the orange paper-plane pill appears bottom-right. It checks the doc every 10 seconds and lists findings with copyable fixes and citations.

It reads the doc through your existing Google session (no Google API keys, no OAuth). Out of the box, fixes and citations are one-click **copy**.

### Editing the document

The widget edits Google Docs itself (`extension/docs-hook.js`): **Fix in doc**
and **Cite in doc** need no setup. The Apps Script bridge this section used to
describe is not in the repository (`server/docs-bridge/Code.gs` was a
placeholder) and `GOOGLE_DOCS_BRIDGE_URL` is only an optional, legacy path.

## Accounts and plans (optional)

The server can enforce paid plans — clamping the model a call may use and
metering the free tier (5 source searches and 400 extension checks a day,
150 desktop AI calls a day) — and accept Stripe webhooks
that set a plan on the account. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STUDENT`
and `STRIPE_PRICE_PRO` in `.env`. **Set none of them and nothing changes** —
no clamping, no metering, everything works exactly as described above. See
[BILLING.md](BILLING.md).

## Notes

- Server runs on port `4477` (`PORT=…` to change).
- `TRACELY_MOCK=1 node server.js` runs a no-API mock mode with canned verdicts for demoing the UI.
- Default model is `gpt-5.6-luna`, the fast tier (chosen by `eval/models/FINDINGS.md`); `lib/llm.js` owns the model ids, a plan's ceiling is applied on top of them in `shared/plan.js`, and retired ids old clients still send are translated there (`currentModelId`).
- The server has **zero runtime dependencies** — the OpenAI Responses API is called over plain `fetch`, so `npm install` installs nothing.
