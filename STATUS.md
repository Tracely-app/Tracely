# STATUS — what is live where

The one file to read before asking "is my change out yet?". Updated by whoever
deploys or ships, in the same PR or right after. Dates are UTC.

| Surface | Live version | Since | How it got there | Who can do it |
|---|---|---|---|---|
| **Server** `api.jointracely.com` | main `0945487` (#338 reverts #327's parts verifier — measured worse in #337; on top of `9c70612`, #334 Try Tracely, which also brought #317 live source search and #318 citations in context) | 2026-10-13 03:52 | `server/DEPLOY.md` runbook incl. the `extension/content.js` copy; backup `app.bak-20261012-205213` (previous: `app.bak-20261012-175105`, env `/srv/tracely/env.bak-20261012-175105`); tag `server/20261013-0945487`; `healthcheck.sh --demo` green | Sam (SSH to the Linode) |
| **Chrome extension** (Web Store, id `dffmoeebkkghhgcklkbmaibfhgiegmdm`) | **2.21.1** published | early October 2026 (store zip of 10-01) | store zip from `server/scripts/pack-extension.sh` | Sam (publisher account) |
| Chrome extension — store draft | 2.21.18 **submitted from the beta zip — cancel it**; `Tracely-2.21.27-store.zip` is built from main `a71e4aa` and waits in Sam's Downloads | 2026-10-09 | Developer Dashboard | Sam |
| Chrome extension — testers | 2.21.18-beta (Merrick's zip); main is 2.21.27 | 2026-10-04 | `pack-extension.sh --beta` + Load unpacked | either (beta token is in the server's `.env`) |
| **Desktop app** stable | v0.3.100 (main `61a1379`) | 2026-10-08 00:25 | `npm run release:win` from Merrick's Windows box with the gh CLI's token (#296 had already bumped to 0.3.100 and nothing was published from it, so `ship` would have bumped again) | Merrick |
| Desktop app preview | `v0.3.100-preview.294` | 2026-10-07 | `preview.yml` on push | CI |
| **Website** `jointracely.com` | main `f0deb13` (#15) | 2026-10-12 04:48 | Vercel — live again (the live files matched main 34 s after the merge; possibly a manual `vercel` deploy — ask Merrick) | Merrick (Vercel) |

## Not yet deployed / pending

- **Try Tracely** is live at `https://api.jointracely.com/try` (demo pool $2/day, 10 checks / 2 source searches / 2 reviews per visitor; settings `TRACELY_DEMO_*` and `TRACELY_PUBLIC_ORIGIN` in the server `.env`). The website's `/try/` page that frames it, plus the hero/nav/download entry points, is Tracely-app/Tracely-Website#16 — waiting on Merrick to merge and deploy. **Every server deploy must copy `extension/content.js`** (runbook) or `/try` stops working.
- Website (Tracely-app/Tracely-Website) waits on the Vercel reconnect above: #8 is the site rebuild with the pricing copy; #9 the `/privacy` and `/terms` pages (supersedes #7, held for legal review); #10 puts Explain in depth back on Pro once extension 2.21.24 is live.
- Repo PR #297 (launch legal documents) — drafts for legal review, do not merge until read by a lawyer.

## How to update this file

- Deployed the server? Replace the server row: commit, time, backup name.
- Shipped an installer? Replace the desktop row.
- Uploaded or published on the Web Store? Replace the extension rows.
- Everything else here is a pointer; the runbooks are `server/DEPLOY.md` and `docs/RELEASING.md`; `server/scripts/healthcheck.sh` checks the server.
