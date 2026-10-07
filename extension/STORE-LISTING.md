# Chrome Web Store: listing and privacy answers

What to paste into the Chrome Web Store Developer Dashboard for the Tracely
extension. Written from the code (`manifest.json`, `background.js`,
`content.js`, `options.js`) and from [PRIVACY.md](../PRIVACY.md); if either
changes, update this file in the same PR.

The store build is made by `server/scripts/pack-extension.sh` (no `--beta`),
which removes the `http://localhost:4477/*` host permission, so the store
listing never has to justify it.

## Store listing

- **Name:** Tracely — live fact-check while you write
- **Category:** Education
- **Language:** English
- **Homepage URL:** https://jointracely.com
- **Support URL / email:** https://jointracely.com · hello@jointracely.com
- **Privacy policy URL:** https://jointracely.com/privacy/
- **Mature content:** No

**Short description (132 characters max):**

> Fact-checks your essay as you write in Google Docs, finds sources that back each claim, and cites them in APA, MLA or Chicago.

**Detailed description:**

> Tracely is a fact-checker and writing coach for students.
>
> As you write in Google Docs, Tracely underlines sentences that need attention:
> • Red, solid — contradicted by the evidence, or doesn't make sense
> • Orange, dashed — worth checking: a figure or claim Tracely couldn't verify
> • Amber, double — a citation is missing or incomplete
>
> Hover an underline to see why. Apply a careful revision that changes only what the check found, find a source that actually backs the sentence — Tracely reads each source before suggesting it — and insert the citation in APA 7, MLA 9 or Chicago 17.
>
> Tracely also reviews essays against a rubric (thesis, evidence, analysis, organization, DBQ document use) and tells you what to change and why. It doesn't write your essay for you.
>
> Works in Google Docs, and in text boxes on other sites once you turn it on for that site. Nothing is read until you turn Tracely on.
>
> Free plan included. Student and Pro plans remove the daily limit and add more source searches.
>
> For ages 13 and up. Privacy policy: https://jointracely.com/privacy/

## Privacy practices tab

### Single purpose

> Tracely checks the facts and citations in what the user is writing — in Google Docs and in text fields the user turns it on for — and helps the user fix them: it flags claims that are wrong, unverified or uncited, finds sources that support them and formats citations.

### Permission justifications

- **storage** — Saves the user's settings, which sites they have turned Tracely on for, whether Google Docs is on, an anonymous install id used for plan limits, the sign-in session, and recent verdicts so unchanged text is not checked twice.
- **identity** — Signs the user in with Google (through our account provider, Supabase) using `chrome.identity.launchWebAuthFlow`, so a paid plan can be attached to their account. Optional; the free plan works without signing in.
- **Host permission `https://api.jointracely.com/*`** — Tracely's own server, which checks the text the user is writing and finds sources. Every check goes here.
- **Host permission `https://sxifbtelrtbsgnnwnmdf.supabase.co/*`** — Our account provider, for sign-in, refreshing the session and signing out.
- **Content script on all URLs (`<all_urls>`)** — Tracely helps with writing wherever the user writes: discussion posts, application forms and other text boxes. On a site other than Google Docs it reads and sends nothing until the user switches on "Auto-check on this site" for that site; password and sign-in fields are never read.
- **Content script on `docs.google.com/document/*` (MAIN world, `docs-hook.js`)** — Google Docs draws text on a canvas, so the extension needs this hook to find where each sentence is on the page and underline it. It reads the document only after the user turns Tracely on for Docs.
- **Remote code** — No. All code ships in the package; the server returns data (verdicts and sources), never code.

### Data usage — what Tracely collects

Tick these:

- **Personally identifiable information** — the email address of users who sign in (through Google, via Supabase).
- **Authentication information** — the sign-in session token, kept on the device.
- **Website content** — the text of the document or text box the user has turned Tracely on for, sent to our server to be checked. It is not stored.

Leave these unticked: health, financial and payment information (Stripe handles payment on jointracely.com; the extension never sees card details), personal communications, location, web history (the server never receives a page's URL), user activity (no clicks, keystrokes or mouse movement are recorded or sent).

### Certifications

Tick all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The approved use cases cover our processors (OpenAI, Supabase, Stripe, Linode, the scholarly indexes), each named in PRIVACY.md under "Who else processes your data".

## Before each submission

- The package is the **store** zip (`pack-extension.sh` without `--beta`) and contains no `beta.json`.
- The server is deployed with every server change the zip depends on (CLAUDE.md, "deploy the server before any zip").
- The extension's routes are frozen until the review finishes (CLAUDE.md, "Two products on one server").
- Screenshots (1280×800) match what this version draws.
