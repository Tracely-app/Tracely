# STATUS — what is live where

The one file to read before asking "is my change out yet?". Updated by whoever
deploys or ships, in the same PR or right after. Dates are UTC.

| Surface | Live version | Since | How it got there | Who can do it |
|---|---|---|---|---|
| **Server** `api.jointracely.com` | main `618188c` (#292) | 2026-10-06 06:09 | `server/DEPLOY.md` runbook, backup `app.bak-20261006-060946` | Sam (SSH to the Linode) |
| **Chrome extension** (Web Store, id `dffmoeebkkghhgcklkbmaibfhgiegmdm`) | **2.21.1** published | early October 2026 (store zip of 10-01) | store zip from `server/scripts/pack-extension.sh` | Sam (publisher account) |
| Chrome extension — store draft | 2.21.18 **submitted from the beta zip — cancel it**; upload 2.21.24's store zip (`pack-extension.sh` from main) **after the server deploy below**, then tag `ext/v2.21.24` | 2026-10-05 | Developer Dashboard | Sam |
| Chrome extension — testers | 2.21.18-beta (Merrick's zip) | 2026-10-04 | `pack-extension.sh --beta` + Load unpacked | either (beta token is in the server's `.env`) |
| **Desktop app** stable | v0.3.100 (main `61a1379`) | 2026-10-08 00:25 | `npm run release:win` from Merrick's Windows box with the gh CLI's token (#296 had already bumped to 0.3.100 and nothing was published from it, so `ship` would have bumped again) | Merrick |
| Desktop app preview | `v0.3.100-preview.294` | 2026-10-07 | `preview.yml` on push | CI |
| **Website** `jointracely.com` | frozen at `bd1cb84` (2026-09-19) | — | Vercel, **not deploying** since the org transfer (Vercel GitHub App not installed on Tracely-app) | Merrick (Vercel), Sam (installs the app on the org) |

## Not yet deployed / pending

- **Server:** main has #293, #275 and #300 since the live `618188c`. #300 adds `/api/compare-source` to `EXTENSION_API`, which extension 2.21.24's "Find the cited work" calls — deploy before uploading that zip (on the current server the button falls back to Find a source).
- Website (Tracely-app/Tracely-Website) waits on the Vercel reconnect above: #8 is the site rebuild with the pricing copy; #9 the `/privacy` and `/terms` pages (supersedes #7, held for legal review); #10 puts Explain in depth back on Pro once extension 2.21.24 is live.
- Repo PR #297 (launch legal documents) — drafts for legal review, do not merge until read by a lawyer.

## How to update this file

- Deployed the server? Replace the server row: commit, time, backup name.
- Shipped an installer? Replace the desktop row.
- Uploaded or published on the Web Store? Replace the extension rows.
- Everything else here is a pointer; the runbooks are `server/DEPLOY.md` and `docs/RELEASING.md`; `server/scripts/healthcheck.sh` checks the server.
