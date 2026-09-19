# Tracely Privacy Policy

*Effective: August 2026*

Tracely is a browser extension and local application that checks the factual
credibility of text you write. It is built local-first, and its privacy model
is simple: **we do not collect, store, transmit, sell, or share any of your
data, because we do not operate any servers.**

## What the extension processes

- **The text you are checking.** When you enable Tracely on a site and it
  checks your writing, the relevant text is sent to exactly one of:
  - **OpenAI** (api.openai.com), using **your own API key**, when you
    run the extension standalone. OpenAI's handling of that data is
    governed by their privacy policy (https://openai.com/policies/privacy-policy).
  - **Your own computer** (a local companion app at localhost:4477), if you
    run it. That data never leaves your machine except for the companion
    app's own calls to OpenAI with your key.
- **Source lookups.** Claim text may be sent as search queries to free
  scholarly indexes (OpenAlex, Crossref) to suggest citable sources.

## What is stored, and where

- Your OpenAI API key, model preference, and the list of sites you have
  enabled are stored in Chrome's extension storage **on your device only**.
- Nothing is synced to us. There is no "us" server.

## What we collect

Nothing. No analytics, no telemetry, no accounts, no cookies, no tracking of
any kind. The developers have no ability to see your text, your key, or your
usage.

## Your controls

- Tracely runs on no site until you enable that site with the toolbar button.
- Remove the API key or uninstall the extension at any time; all stored data
  is deleted with it.

## Changes and contact

Changes to this policy will be published at this URL. Questions:
open an issue at https://github.com/Tracely-app/Tracely/issues.
