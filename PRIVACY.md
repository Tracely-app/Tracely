# Tracely Privacy Policy

*Effective: 7 October 2026. This version covers everything Tracely runs: the
Chrome extension, the Windows app, the website at jointracely.com and the
Tracely service behind them (`api.jointracely.com`). The 3 October 2026
version covered only the extension and the service; its text is kept below
unchanged where it still applies. It added the site icons shown beside
sources, loaded from Google's favicon service, and said when text is sent for
checking: a few seconds after a sentence is written or changed. The 24
September 2026 version replaced the August 2026 policy, which described an
earlier version of the extension that ran on your own API key with no server
and no accounts.*

This policy covers the **Tracely Chrome extension**, the **Tracely Windows
app**, the **website at jointracely.com** and the **Tracely service** they talk
to (`api.jointracely.com`), all operated by Tracely ("we"). It is written from
the code: each statement below names the part of the product it describes.

## The short version

- The text you are checking is sent to our server and on to OpenAI to be
  judged. **We do not store your text.** It is processed and discarded.
- Google Docs is checked only after you turn Tracely on for Docs, once. Other
  sites are checked only after you turn Tracely on for that site. Until then
  nothing is read from the page.
- No account is needed to use the free plan. If you sign in with Google, we
  keep your email address and account id and the plan attached to them.
- The Windows app keeps your documents on your own computer, not on our server.
- We keep usage counts against your account (or an anonymous install id) for
  13 months, and payment records (which plan, when) for as long as you have
  an account.
- You can delete your account and everything we keep with it from the
  extension's options page, at any time, or by emailing hello@jointracely.com.
- We do not sell data, show ads, build advertising profiles, or use your text
  for anything but checking it.
- Tracely is for people aged 13 and over.

## What is sent, and when

**Checking.** While Tracely is on for the page you are writing in, the
extension sends the text of the document or text box (up to 30,000
characters) and the sentences to check to `api.jointracely.com`, a few
seconds after you write or change a sentence. A sentence that has already been
checked is not sent again. For "Explain in depth", one sentence and the
document context. For the flow check, the first 12,000 characters. When
Tracely recognises a resume, its first 12,000 characters, for Resume tips. Our server
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

## The Windows app

**Your documents stay on your computer.** Documents, checks, grades, the
sources you save and your Tracer conversations are stored in a database on
your own computer (`%APPDATA%\Tracely`). Our server does not keep a copy.
Settings › Privacy clears your history, or your history and library.

**Checking, grading and Tracer.** To find claims, critique them, grade a draft
or answer a Tracer question, the app sends the relevant text to our server,
which forwards it to OpenAI, exactly as for the extension above. Tracer sends
the conversation so far (its last 12 turns) and the draft you are working on.

**Finding sources.** To find evidence for a claim, the app sends search terms
taken from that claim **directly from your computer** to scholarly indexes:
OpenAlex, Crossref and Semantic Scholar always; PubMed for medical claims;
Wikipedia for general facts; the World Bank's data for statistical claims;
and Unpaywall to find a free copy of a paper you can open. These services
receive the search terms, or a paper's DOI — never your document or your
account details. Unpaywall also receives a contact address for Tracely (or one
you set in Settings), as it asks every caller to. When none of these return a
source you could cite, the app may ask our server to run a web search through
OpenAI.

**Screen Watch** is off until you turn it on. While it is on, it reads the text
of the field you are typing in, in other Windows apps, through Windows'
accessibility interface, and sends it to our server to find claims as above.
Nothing it reads is saved — not on your computer and not on our server.
If you also turn on website icons, the app loads each source's small site icon
from Google's public favicon service, which receives that source's domain name.

**Your account.** The first time it runs, the app creates an anonymous account
for itself with Supabase — no email, no name — so its daily allowance can be
counted. It also stores a random install id on your computer for the same
reason.

**Other connections.** The app checks GitHub for updates, and downloads
spelling dictionaries for the spell checker built into its editor.

## This website

**The waitlist** uses Google sign-in to confirm your email address. We receive
your Google account's email address and name and keep them in a list we use
only to tell you about Tracely's launch and updates. Ask us at
hello@jointracely.com to be removed, and every email we send has a way to
unsubscribe. Your browser remembers that you joined, so the page can say so.

**Other requests.** The site loads its fonts from Google Fonts, so your browser
contacts Google to download them. The site sets no advertising or analytics
cookies of its own. Google's sign-in window may use Google's own cookies.

**The order page** passes your Tracely account id to Stripe when you upgrade
from inside Tracely, so the plan reaches the right account even if someone else
pays.

## What we keep, and for how long

On our server:

| what | keyed by | kept |
|---|---|---|
| Usage counts (checks, source searches, flow checks and resume reviews per day and month; spend against your plan's allowance) | account id, or the hashed install id | 13 months, then deleted automatically |
| Account link: Stripe customer id, plan, the email used to pay | account id | while the account exists |
| Payment events from Stripe: event id, type, plan, outcome | account id | while the account exists; the payer's name, address and phone are removed before the event is stored |
| An unclaimed purchase (plan and payer email) awaiting its account | payer email | until claimed, or until the subscription ends |
| Standard web-server access logs (IP address, time, path) | — | rotated by the web server on its normal schedule |

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
removes the rest. The Windows app's storage is described above.

The waitlist (email and name) is kept until you ask to be removed or we stop
sending launch updates.

## Who else processes your data

- **OpenAI** (api.openai.com) — judges the text and runs source searches, on
  our API key, under OpenAI's API data-usage terms.
- **Crossref** (api.crossref.org), **OpenAlex** (api.openalex.org) and **the
  publishers of the sources we find** — after a source search, our server
  looks up each source's DOI at Crossref and reads the source's own web page
  to complete its citation (authors, date, journal), and reads a scholarly
  source's abstract from OpenAlex, or the page's text, to check that the
  source really says what the sentence claims before offering it (that check
  is made by OpenAI, above). They receive that source's DOI or address, never
  your text or the sentence being cited.
- **Semantic Scholar, PubMed, Wikipedia, the World Bank and Unpaywall** — the
  Windows app's searches, described above. They receive search terms or a DOI.
- **Supabase** — sign-in and account records (email, account id, plan).
- **Stripe** — payments; we receive plan, customer id and payer email, never
  card details.
- **Google** — Google Docs is read through your own session; Google sign-in
  through Supabase and for the waitlist; Google's own diagnostics may note the
  extension's presence. When sources are shown, your browser loads each
  source's small site icon from Google's public favicon service
  (www.google.com/s2/favicons), which receives that source's domain name —
  never your text or the sentence being cited. The website's fonts come from
  Google Fonts, and the waitlist is kept in Google's services.
- **GitHub** — hosts the Windows app's installers and updates.
- **Linode** — hosts our server. **Vercel** — hosts the website.

None of them receives more than the feature needs, and none is permitted to
use it for anything else.

## Your controls

- **Turn it off:** per site in the widget, for Google Docs on the options
  page. Off means nothing is read. In the Windows app, Screen Watch is off
  until you turn it on.
- **Sign out:** options page. The session token is deleted from your device.
- **Delete your account and data:** options page → "Delete my account and
  data". This removes your usage counts, account links and unclaimed
  purchases, strips the payer details from your payment record, and deletes
  the sign-in account. Cancel a paid plan first (Manage subscription), so the
  card is not charged for an account that no longer exists. You can also ask
  us to do it at hello@jointracely.com.
- **Clear the Windows app:** Settings › Privacy, or uninstall the app and
  delete `%APPDATA%\Tracely`.
- **Uninstall:** Chrome removes the extension's storage. Anything cached in a
  page's own storage is cleared with that site's data.
- **See or correct what we hold:** email hello@jointracely.com. We answer
  within 30 days.

## Limited Use

Tracely's use of information received from Google APIs, and of any user data
it handles, adheres to the Chrome Web Store User Data Policy, including the
Limited Use requirements. Data is used only to provide and improve the
extension's fact-checking, sourcing and account features that you see; it is
not sold, not used for advertising, and not transferred except to the
processors above for those features, or as required by law.

## Students and children

Tracely is for people aged **13 and over**. We do not knowingly collect
personal information from children under 13. If you believe a child under 13
has given us personal information, email hello@jointracely.com and we will
delete it.

If you are under 18, you need a parent or guardian's permission to use
Tracely, and a parent or guardian must buy any paid plan.

Because students use Tracely for schoolwork, we commit to the following for
everyone: we do not show ads, we do not use what students write or do in
Tracely to target ads or build profiles for any purpose other than providing
Tracely, we do not sell student information, we protect it with reasonable
security, and we delete it on request.

## Security

Traffic between Tracely and our server is encrypted (HTTPS). Our server keeps
the minimum listed above, and access to it is restricted to the people who run
Tracely. No system is perfectly secure; if we learn of a breach affecting your
information, we will tell you.

## Changes and contact

Changes to this policy are published here, with the effective date at the
top. If a change affects what we collect or how we use it, we will say so in
the product before it takes effect. Questions and requests:
hello@jointracely.com, or open an issue at
https://github.com/Tracely-app/Tracely/issues.
