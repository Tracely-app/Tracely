# eval/goldset/ — what the two source finders return today

A baseline of Tracely's two CURRENT source-finding pipelines on the same 36
claims, so a change to either (first: `server/lib/sourceVerify.js`) can be
measured against what shipped rather than against an impression.

| Run | Pipeline | Cost | File |
|---|---|---|---|
| 1 | The extension's "Find a source" — `POST /api/sources` | paid (~1.4¢ a claim) | `runs/<date>-extension.json` |
| 2 | The desktop's evidence search — `findEvidence` | free | `runs/<date>-desktop.json` |

**The claims** are the 36 hand-labelled retrieval claims in
`eval/retrieval/labels/*.json`, joined to their August reports by
`eval/retrieval/load.mjs` `loadLabelled()` (`claims.mjs`). Each carries the
claim text and search query the desktop's detector produced then, and the
paragraph it sits in from `eval/essays/`. Ids are `<essay>-c<n>` (`01-c1` …
`09-c3`) and are the join key between runs. The August labels judge the August
reports' sources, not these; they are carried (`labelPrefix`) only to join.

## Run 1 — the extension (`run-extension.mjs`)

```sh
node eval/goldset/run-extension.mjs --dry                     # plan + estimate, no network
OPENAI_API_KEY=… node eval/goldset/run-extension.mjs --out eval/goldset/runs/2026-10-07-extension.json
```

Calls `findSources` from `server/lib/factcheck.js` — the function the route
awaits: one web search, `completeSources` (Crossref and page metadata, dead
links dropped), then `verifySources` — at the model and effort
`server/shared/plan.js` `modelForRoute("sources", "free")` gives every hosted
free caller (`gpt-5.6-luna` at `low`). Context is the claim's paragraph;
`findSources` keeps ±1,200 characters of it (`claimWindow`), as it does with
the 6,000 characters the extension sends. No correction (a plain claim).

What it keeps that the route does not:

- **`verified`, per source.** `sourceVerify.js` keeps no per-source flag (the
  route logs and strips only `{checked, changed}`), so a fetch wrapper records
  the verify call and `verified` means *the verifier read this source's own
  text and returned a verdict for it*. `verifierText` is that text,
  `verifyVerdict`/`verifyQuote` the answer, `searchStance`/`searchSnippet` what
  the search model said before. If the library itself sets a boolean
  `verified` on a source (a branch may), that wins (`verifiedFrom: "lib"`).
  The raw verify input and output are kept per claim either way.
- **`shownAsBacking`** — `extension/content.js` `backingSources` for a
  sentence not flagged false: stance `supports` (or none) is offered as
  backing; `refutes` and `context` are not.
- **Cost**, from each response's usage at `server/shared/prices.js`.
  `costUSD` is what the server's ledger records (tokens + $0.01 per
  `web_search_call`, at least one); `costUSDSearchActionsOnly` charges only
  `search` actions. The bill is between the two.

Options: `--claims 01,05-c1`, `--cap USD` (default 3; stops before a claim
whose worst case would pass it), `--concurrency N` (3), `--resume`.

**The key** is read the way the harness and the server read it:
`OPENAI_API_KEY` in the shell, else `server/.env` (the server's own rule). It
refuses to run without one, and never prints it.

**To measure a change to `sourceVerify.js`**, run the same script on that
branch with another `--out` and compare by claim id:

```sh
git checkout <branch>
OPENAI_API_KEY=… node eval/goldset/run-extension.mjs --out eval/goldset/runs/<date>-extension-<branch>.json
```

## Run 2 — the desktop (`run-desktop.mjs`)

```sh
node eval/goldset/run-desktop.mjs --out eval/goldset/runs/2026-10-07-desktop.json
```

Bundles `desktop-entry.ts` with esbuild the way `scripts/evaluate.mjs` bundles
the eval harness (into `out/goldset/`, gitignored) and runs each claim
through `src/main/services/search/aggregator.ts` `findEvidence`: the fan-out,
OpenAlex enrichment, MiniLM relevance, the relevance floor and the cap of five.
`shown` is that list in the order the editor's picker draws it
(`byCredibility`; `aggregatorRank` is the order before), with provider,
abstract, relevance and credibility tier. No detection — the claims are given.

Differences from `npm run evaluate`, all on purpose:

- **No paid call is possible.** The bundle is built with `__API_URL__ = ""`
  (the app's own kill switch) and a fetch guard refuses the Tracely server and
  OpenAI. The web fallback (`/api/find-sources`) therefore never runs;
  `wouldCallWebFallback` records the claims that would have reached it
  (`findEvidence` took a search from `webBudget`, reset per claim).
- **No cassettes** — this measures today's providers, not August's recordings.
- **A packaged build's resources** (`out/goldset/resources`: the bundled MiniLM
  and sql.js's wasm), a fresh data dir per run, no Semantic Scholar or NCBI
  key (Semantic Scholar is not asked without one), stance off (as in every build).
- OpenAlex's keyless budget is $0.10/day, about 100 searches: each claim
  records its OpenAlex search status, and the summary lists any 429.

## Recorded runs

**2026-10-07, desktop** (`a6adc7a`): 36 claims, 145 sources shown (≤5 each),
2 empty (`05-c3`, `05-c4`). By provider: Crossref 77, OpenAlex 59, Wikipedia 5,
PubMed 3, World Bank 1. By tier: scholarly 75, unvetted 64, official 6.
3 claims would have called the paid web fallback (`03-c2`, `03-c5`, `06-c3`).
No OpenAlex 429s; MiniLM up throughout. Cost $0.

**2026-10-07, extension, production** (`run-extension-prod.mjs`): with no
OpenAI key on the laptop, the same 36 claims went to `api.jointracely.com`
`POST /api/sources` (live `618188c`, before receipts) through the beta pool
(`X-Tracely-Beta`, read from the beta zip's `beta.json`, never printed),
paced under the beta pool's 30 searches an hour and resumable. 36/36 answered,
155 sources, 59 shown as backing (stance `supports`). The response strips the
server's `verified`, so this records what the extension is shown.

**2026-10-09, extension, production, after receipts** (live `6974306`, #309):
the same runner and claims. 36/36 answered (one 429, retried), 155 sources,
22 shown as backing (`supports` and not `verified: false`, the extension's
`backingSources` since receipts): 15 quoted from the page, 7 from the abstract.
77 came back unread (`verified: false`, the "check these yourself" list), 50
read and filed `context`, 6 `refutes`. Only 51 of the 155 are URLs the 10-07
run also returned, so part of any change is the search, not the verifier.
Beta pool spend about $0.53.

## Judged: does a source back its sentence? (AI-consensus)

`judged/` holds three blind AI judges' verdicts (Claude Opus, Sonnet, Fable)
on every source of both runs, majority vote, labels backs / topic / offtopic /
contradicts / unsure (`eval/RUBRIC.md`'s ladder; the brief is in each file's
`meta`). No human checked these — call them AI-consensus.

| | Desktop (145 shown) | Extension (59 shown as backing) |
|---|---|---|
| Shown sources that back their sentence | **15 (10%)** | **24 (41%)**; 22 of 30 (73%) where ≥2 judges could read the page |
| Claims with at least one backing source shown | 11 of 36 | 16 of 36 |
| First source shown backs | 7 of 36 | 12 of 25 claims with any shown |
| Judges, backs vs not (Cohen's κ) | 0.52–0.67 (all labels) | 0.43–0.81 |

Read the extension's 41% as a floor: the judges could open about 60% of its
pages (403s, logins, captchas), and a page judged from its title alone is
"backs" only when the title states the claim. The extension also filed 22
sources the judges say back their sentence under `context`, where they are not
offered.

### After receipts (2026-10-09, extension only)

The same three judges and brief on all 155 sources of the 10-09 run
(`judged/2026-10-09-extension-prod.json`). The desktop was not re-run: live
v0.3.100 does not carry its receipts (#310), so it is the same pipeline.

| Extension | Before (618188c) | After receipts (6974306) |
|---|---|---|
| Shown as backing | 59 | 22 |
| …that back their sentence | 24 (41%; 95% CI 29–53%) | **12 (55%; 35–73%)** |
| …where ≥2 judges could read the page | 22 of 30 (73%) | 12 of 18 (67%) |
| Shown but not backing | 35 | **10** |
| Claims with a backing source shown | 16 of 36 | **7 of 36** |
| First source shown backs | 12 of 25 | 6 of 12 |
| Returned and backing, but not offered | 22 | 26 (13 read and filed `context`, 11 unread, 2 `refutes`) |
| Judges, backs vs not (Cohen's κ) | 0.43–0.81 | 0.73–0.87 |

What it says:

- **Wrong offers fell from 35 to 10; right ones halved (24 → 12).** Fewer
  claims get any offer (25 → 12). The precision gain overlaps the noise at
  n=22, and among pages the judges could read it did not rise (73% → 67%):
  most of it is that an offer now needs a page Tracely could read.
- **The 10 wrong offers:** 4 back only the setup half of a two-part sentence
  (AASM's 8–10 hours for "70% sleep under seven"; Gutenberg's 1450 for "presses
  in 200 cities by 1500"; Luther's pamphlets ×2 for "…and witch-hunting
  literature"); 1 gives a different figure (the SDG report's count of people
  without power, not the region's share). 4 are abstracts the judges could not open
  (title-only, so not "backs" by the rule). 1 contradicts (the share of
  sub-Saharan Africa with power doubled; the essay says it barely moved).
- **The verifier refuses good sources it read:** 13 sources Tracely read and
  filed `context` are unanimous "backs" — the three Frankenstein chapter 5
  texts, the Ctrip work-from-home experiment ×2, the 8:30 start-time counts ×2,
  the utilities' 40% cost recovery ×2.
- **Tracely's own fetch fails where a reader gets through:** half the sources
  (77) came back unread; 11 of them all three judges opened and call "backs".
- Of the 51 sources judged in both runs, 41 kept their majority label
  (6 backs → not, 2 not → backs): the judges' own drift, for scale.

## Files

- `claims.mjs` — the 36 claims with their paragraphs; `--claims` filtering.
- `run-extension.mjs` — Run 1. `run-desktop.mjs` + `desktop-entry.ts` — Run 2.
- `run-extension-prod.mjs` — Run 1 against production, through the beta pool.
- `runs/` — results, committed: the 10-07 baseline and the 10-09 after-receipts run.
- `judged/` — the three judges' verdicts on each run, with the majority.
