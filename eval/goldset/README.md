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

### The verifier alone, before and after parts (2026-10-13)

`run-verify-prod.mjs` sends every judged source of both runs (310) to
production `/api/verify-sources`, the same `lib/sourceVerify.js` the
extension's search runs. The inputs are fixed, so no search drift. Before:
`6974306`, one verdict per source (`runs/2026-10-10-verify-prod-on-*`).
After: `9c70612`, which carries #327: the claim is split into parts, a
source `supports` only when every part has a quote, and `refutes` when any
part is ruled out (`runs/2026-10-13-verify-prod-on-*`). About 10¢.

| Both sets, 310 sources | Before (one verdict) | After (parts) |
|---|---|---|
| Verifier says backs | 48 | **13** |
| …the judges' majority agrees | 34 (71%; 95% CI 57–82%) | 9 (69%; 42–87%) |
| The judges' 84 "backs" it accepts | 34 | **9** (37 topic, 30 unread, 8 contradicts) |
| Verifier says contradicts | 14 | **26** |
| …the judges agree | 5 | **3** (8 back, 8 topic, 6 off-topic, 1 split) |
| Claims with a backing source the judges agree with | 14 of 36 | **4 of 36** |
| Unread (the fetch, not the judge) | 141 | 147 |

What it says:

- **Parts made the verifier worse, not more honest.** Wrong "backs" fell
  from 14 to 4, but right ones fell from 34 to 9, so precision held at about
  70% while three quarters of the good sources were lost. On these inputs, a
  backing source the judges agree with is left for 4 claims in 36 (14 before).
- **The fixes #327 expected did not happen.** The Ctrip abstract that
  states the 13% (`ex-02-c1-2`) and the NLM Frankenstein exhibit
  (`ex-06-c1-1`) are both still `topic`. Every judge calls them "backs".
- **"Contradicts" nearly doubled, and 23 of the 26 are wrong.** The rule is
  lopsided: support needs a quote for every part, but refuting needs only
  one part ruled out. The failures:
  - the writer's own hedge treated as a claim (Dittmar's printing cities ×3,
    "though disentangling that from…", which #327's prompt says to leave out);
  - a different measure read as a contradiction (hospital infections down
    27% against "30% of prescriptions unnecessary"; "1 in 4 got 8 hours"
    against "70% get less than seven"; 100–365 W panels against "tens of
    watts");
  - a hypothetical in an AP English page (a council "is voting") ×4;
  - a word choice: Shelley's 1831 "Introduction" against "preface" ×2.
- On the extension, `refutes` is offered only for a sentence flagged false,
  so there the cost is mostly lost good sources. The desktop lists
  `contradicts` in its own group with a quote, so there it reaches the writer
  once #310 ships.

### The figure rule, on recorded runs (2026-10-13, free)

`figures.mjs` applies `server/lib/claimFigures.js` `figuresShown` to every
recorded "backs" and its quote: when the sentence states a figure, the quote
must show it. No model, no network.

| Run | Backs | Judges agree | Rule drops (wrong / good) | After |
|---|---|---|---|---|
| Live verifier, 310 sources (`2026-10-10-verify-prod-on-*`) | 48 | 34 (71%) | 2 (2 / 0) | 34 of 46 (74%) |
| Production search, shown as backing (`2026-10-09-extension-prod`) | 22 | 12 (55%) | 5 (4 / 1) | 11 of 17 (65%) |

- **Dropped:**
  - the sleep academy's "8 to 10 hours" for "roughly 70 percent get less
    than seven";
  - "Around 1450, Gutenberg introduced…" for "more than two hundred cities";
  - two "nearly flat" pages for "roughly half lacks access", one of which the
    judges say contradicts the sentence.
- **The one good source lost:** Ctrip's "attrition was half…", offered for
  "roughly 13 percent more productive…". Its receipt does not show the 13%.
- **What it cannot catch:** the other 12 wrong offers in the live run are
  wrong on a part with no figure ("the main reason…", "an ordinary feature of
  bacterial life"). It does not touch "contradicts": "half lacks power" and
  "51% have it" share a number and disagree.

## Files

- `claims.mjs` — the 36 claims with their paragraphs; `--claims` filtering.
- `run-extension.mjs` — Run 1. `run-desktop.mjs` + `desktop-entry.ts` — Run 2.
- `run-extension-prod.mjs` — Run 1 against production, through the beta pool.
- `runs/` — results, committed: the 10-07 baseline, the 10-09 after-receipts
  run, and `*-verify-prod-on-*`: the verifier alone on both judged runs
  (`run-verify-prod.mjs`; 10-10 one verdict, 10-13 parts).
- `judged/` — the three judges' verdicts on each run, with the majority.
- `figures.mjs` — the figure rule (`server/lib/claimFigures.js`) on the recorded runs; free.
