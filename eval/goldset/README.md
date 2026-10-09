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
offered. **The "after"**: once `main` (receipts, #309/#310) is deployed, run
both runners again to new files and judge them the same way.

## Files

- `claims.mjs` — the 36 claims with their paragraphs; `--claims` filtering.
- `run-extension.mjs` — Run 1. `run-desktop.mjs` + `desktop-entry.ts` — Run 2.
- `run-extension-prod.mjs` — Run 1 against production, through the beta pool.
- `runs/` — results, committed: they are the baseline.
- `judged/` — the three judges' verdicts on each run, with the majority.
