# Tracely ✈️

Live fact-checking as you write. Every 10 seconds, Tracely checks the facts you've typed with the OpenAI API — false claims, shaky claims, and sentences that don't make sense get wavy underlines, suggested fixes, and web sources you can cite. The only key you need is an OpenAI API key.

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

## The editor

- **Wavy underlines** while you type: red = false, amber = questionable, purple = doesn't make sense, thin green = verified.
- Hover an underline for the explanation; click it to jump to its finding card.
- **Apply fix** rewrites the sentence with the model's correction; **Fix all** applies every suggestion at once.
- **Find sources** pulls up 3–5 real sources for a claim (via OpenAI's built-in web search — no extra API key). Pick one and Tracely inserts a `[n]` citation after the sentence and maintains a `Sources:` list at the end of the document. Verified claims can be cited too, via the *cite* button.
- Model (Fast / Balanced / Thorough — `gpt-5-nano`, `gpt-5.4`, `gpt-6-astra`) and depth (Fast / Balanced / Thorough reasoning effort) are switchable in the header.

## Google Docs widget

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
2. Keep the Tracely server running (`node server.js`).
3. Open any Google Doc — the orange paper-plane pill appears bottom-right. It checks the doc every 10 seconds and lists findings with copyable fixes and citations.

It reads the doc through your existing Google session (no Google API keys, no OAuth). Out of the box, fixes and citations are one-click **copy**.

### Edit docs directly (optional, ~3 minutes)

With the bridge set up, the widget gains **Fix in doc**, **Cite in doc**, **Highlight issues in doc** (red / amber / orange tints per finding), and **Clear highlights** — real edits applied straight into the doc. Google requires an authorization step for anything that modifies your documents; this is the lightest one that exists (no Google Cloud project, no OAuth client):

1. Open **script.google.com** → **New project**.
2. Replace the default `Code.gs` with the contents of `~/tracely/docs-bridge/Code.gs` (`open -e ~/tracely/docs-bridge/Code.gs`). The secret token inside already matches your `.env`.
3. **Deploy → New deployment → Web app** — *Execute as:* **Me**, *Who has access:* **Anyone** — then **Deploy** and approve the authorization prompt (it's your own script touching your own Docs).
4. Copy the Web app URL (ends in `/exec`) and paste it into `~/tracely/.env`:
   ```
   GOOGLE_DOCS_BRIDGE_URL=https://script.google.com/macros/s/…/exec
   ```
   No restart needed; the widget buttons appear within ~30 seconds.

*Why "Anyone"?* The local server calls the URL without a Google login; the random URL plus the secret token are the lock. Anyone who has both could edit your docs, so treat `.env` as private (it's already gitignored).

## Accounts and plans (optional)

The server can enforce paid plans — clamping the model a call may use and
metering the free tier's 5 daily source searches — and accept Stripe webhooks
that set a plan on the account. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STUDENT`
and `STRIPE_PRICE_PRO` in `.env`. **Set none of them and nothing changes** —
no clamping, no metering, everything works exactly as described above. See
[BILLING.md](BILLING.md).

## Notes

- Server runs on port `4477` (`PORT=…` to change).
- `TRACELY_MOCK=1 node server.js` runs a no-API mock mode with canned verdicts for demoing the UI.
- Default model is `gpt-5-nano`, the cheapest tier; `lib/llm.js` is the only file that names a model id, and a plan's ceiling is applied on top of it in `shared/plan.js`.
- The server has **zero runtime dependencies** — the OpenAI Responses API is called over plain `fetch`, so `npm install` installs nothing.
