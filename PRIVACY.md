# Tracely Privacy Policy

*Effective: 24 September 2026. Replaces the August 2026 policy, which
described an earlier version of the extension that ran on your own API key
with no server and no accounts. That is not how Tracely works now, so this
policy starts from what the current version actually does.*

This policy covers the **Tracely Chrome extension** and the **Tracely
service** it talks to (`api.jointracely.com`), both operated by Tracely
("we"). It is written from the code: each statement below names the part of
the product it describes.

## The short version

- The text you are checking is sent to our server and on to OpenAI to be
  judged. **We do not store your text.** It is processed and discarded.
- Google Docs is checked only after you turn Tracely on for Docs, once. Other
  sites are checked only after you turn Tracely on for that site. Until then
  nothing is read from the page.
- No account is needed. If you sign in with Google, we keep your email
  address and account id and the plan attached to them.
- We keep usage counts against your account (or an anonymous install id) for
  13 months, and payment records (which plan, when) for as long as you have
  an account.
- You can delete your account and everything we keep with it from the
  extension's options page, at any time.
- We do not sell data, show ads, or use your text for anything but checking
  it.

## What is sent, and when

**Checking.** While Tracely is on for the page you are writing in, the
extension sends the text of the document or text box (up to 30,000
characters) and the sentences to check to `api.jointracely.com`, every ten
seconds while the text changes. For "Explain in depth", one sentence and the
document context. For the flow check, the first 12,000 characters. Our server
forwards this to **OpenAI** (the model that does the judging) and returns the
verdicts. Neither we nor, per OpenAI's API terms, OpenAI keep the text for
training; our server holds it only for the seconds the check takes.

**Finding sources.** When you ask for sources (or turn on automatic sources in
the widget), the flagged sentence, its suggested correction and up to 6,000
characters of surrounding text are sent to our server and to OpenAI, whose
web-search tool may run searches derived from that sentence.

**Citing a pasted URL.** A URL you paste into the widget is fetched by **our
server** (not your browser) to read its title, author and date. The site you
pasted sees our server's address, not yours. Private and local addresses are
refused.

**Google Docs.** The first Google Doc you open with Tracely installed asks
whether to turn Tracely on for Docs. If you say yes, Tracely reads the
document's text through your own Google session (the same way Docs itself
exports a document) and checks it as above, in every Doc you open, until you
turn it off on the options page. If you say no, nothing is read. "Fix in doc"
and "Cite in doc" edit the document through the editor's own paste path — no
Google API, no extra permission — and the edit is read back before it is
reported as done. Google may record, in its own diagnostics, that a
third-party annotation extension is present.

**Other sites.** The widget can appear on any page with a large text field,
but it reads nothing and sends nothing until you switch on "Auto-check on this
site" for that site. Password fields and fields that look like sign-in forms
are never read. Turning a site off clears what Tracely cached on that page.

**Signing in.** "Sign in" opens Google's sign-in through **Supabase**, our
account provider. We receive your email address and an account id; we do not
receive your Google password. A session token is kept in the extension's
storage on your device until you sign out.

**Paying.** Plans are bought on **Stripe**'s hosted checkout at
jointracely.com. Your card details go to Stripe and never to us. Stripe tells
our server which plan was bought, the Stripe customer id and the email used to
pay, so the plan can be attached to your account. If you buy before signing
in, the purchase waits until an account with that email signs in.

**Every request** to our server carries a random install id, generated once
per browser profile, so plan limits and fair-use caps can be applied without
an account. It identifies a browser, not a person, and is stored hashed. When
you are signed in, requests also carry your session token. The extension
checks whether our server is reachable about once a minute while your browser
is open; that request carries no content.

## What we keep, and for how long

On our server:

| what | keyed by | kept |
|---|---|---|
| Usage counts (checks, source searches, flow checks per day and month; spend against your plan's allowance) | account id, or the hashed install id | 13 months, then deleted automatically |
| Account link: Stripe customer id, plan, the email used to pay | account id | while the account exists |
| Payment events from Stripe: event id, type, plan, outcome | account id | while the account exists; the payer's name, address and phone are removed before the event is stored |
| An unclaimed purchase (plan and payer email) awaiting its account | payer email | until claimed, or until the subscription ends |
| Standard web-server access logs (IP address, time, path) | — | rotated by the web server on its normal schedule (see below) |

Our application logs record which route was called and whether it succeeded —
never your text, email, tokens or IP address.

We keep **no copy of the text you check, no documents, and no record of which
pages or documents you use Tracely on.** Our server never receives a page's
URL, only the text.

On your device, in the extension's storage: your settings, the sites you have
switched on, whether Docs is on, the install id, your session token and plan
details. Chrome removes all of it when you uninstall. Tracely also caches
verdicts and source lists for each page it has checked in that page's own
browser storage, so reopening the page does not re-check unchanged text;
turning a site off clears its cache, and clearing the site's data in Chrome
removes the rest.

## Who else processes your data

- **OpenAI** (api.openai.com) — judges the text and runs source searches, on
  our API key, under OpenAI's API data-usage terms.
- **Supabase** — sign-in and account records (email, account id, plan).
- **Stripe** — payments; we receive plan, customer id and payer email, never
  card details.
- **Google** — Google Docs is read through your own session; Google sign-in
  through Supabase; Google's own diagnostics may note the extension's presence.
- **Linode** — hosts our server.

None of them receives more than the feature needs, and none is permitted to
use it for anything else.

## Your controls

- **Turn it off:** per site in the widget, for Google Docs on the options
  page. Off means nothing is read.
- **Sign out:** options page. The session token is deleted from your device.
- **Delete your account and data:** options page → "Delete my account and
  data". This removes your usage counts, account links and unclaimed
  purchases, strips the payer details from your payment record, and deletes
  the sign-in account. Cancel a paid plan first (Manage subscription), so the
  card is not charged for an account that no longer exists.
- **Uninstall:** Chrome removes the extension's storage. Anything cached in a
  page's own storage is cleared with that site's data.

## Limited Use

Tracely's use of information received from Google APIs, and of any user data
it handles, adheres to the Chrome Web Store User Data Policy, including the
Limited Use requirements. Data is used only to provide and improve the
extension's fact-checking, sourcing and account features that you see; it is
not sold, not used for advertising, and not transferred except to the
processors above for those features, or as required by law.

## Children

Tracely is for writers of school age and older, but the paid plans require a
parent or guardian to pay if you are under 18. We do not knowingly collect
data from children under 13.

## Changes and contact

Changes to this policy are published here, with the effective date at the
top. Questions and requests: open an issue at
https://github.com/Tracely-app/Tracely/issues, or email the address on
jointracely.com.
