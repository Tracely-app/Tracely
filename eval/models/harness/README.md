# The model eval harness

Runs candidate `{model, effort}` configs through THIS checkout's production
code and records every call, so `../FINDINGS.md` can be re-measured after a
provider change or before a tier change. Zero dependencies; Node 22+.

```sh
# the three tiers, both tasks, 2 reps (~$1.50 on 2026-09-21 prices; astra is $1.16 of it)
OPENAI_API_KEY=... node eval/models/harness/run.mjs \
  --configs gpt-5.6-luna@medium,gpt-5.6-terra@low,gpt-6-astra@low --reps 2
# every config FINDINGS.md measured (~$3.25)
OPENAI_API_KEY=... node eval/models/harness/run.mjs --configs all --reps 2
# mechanical scores for whatever is in eval/models/results/
node eval/models/harness/score.mjs [--rep 1] [--detail] [--json out.json]
```

`--dry` lists what would run without calling anything. Other options
(`--tasks`, `--essays`, `--claims`, `--sentences`, `--batch`, `--cap`,
concurrency) are documented at the top of `run.mjs`. Runs are resumable: an
item already recorded `ok` for a rep is skipped. Results and the spend ledger
go to `eval/models/results/`, which is gitignored — they carry raw model
output and are not committed.

## No patched server

The harness imports `server/lib/factcheck.js` and `server/lib/reasoning.js`
from this checkout and calls them exactly as the routes do. Nothing on disk is
patched. (The original run used a private server copy with three patches;
none is needed now: the tier ids and their prices are the server's own, and
the old `supportsEffort` patch changed no behaviour.)

A candidate that is NOT one of the server's tiers (e.g. `gpt-5-nano`,
`gpt-4.1`) would be coerced to the fast tier by `chooseModel`. `run.mjs`
therefore adds each such model to the server's exported `ALLOWED_MODELS` set
in its own process only, and says so on the console. Every record carries the
model and effort each HTTP call actually SENT (`http[].model`,
`http[].effortSent`, `effortMismatch`), so a silent substitution cannot pass
unnoticed.

## How each task maps onto production

**check** calls `runFactCheck({ text, sentences, model, effort })`, exactly
what POST /api/check does, with its validation limits re-applied (text <=
30,000 characters, 1-40 sentences, each <= 2,000). One essay is one call with
all its sentences, keyed by the extension's `hashText()` — the first check of
a freshly opened document. Note the harness calls `runFactCheck` directly, so
the route's per-tier effort pin (`checkEffort`) does not apply:
`gpt-5.6-luna@low` really runs at low.

**critique** calls `critique({ claimText, strengthScore, evidenceSummary,
referenceCheck?, model, effort })`, the desktop branch of POST /api/critique.
The desktop sends no effort, so production runs the server default, `low`.
The request bodies are `../critique-inputs.json`, built once by the desktop's
real pipeline (detection, live OpenAlex / Crossref / PubMed / Wikipedia /
World Bank retrieval, MiniLM ranking, reference checks, the evidence summary)
and frozen, so every config sees identical input. The expected verdicts are
`eval/critique/expected.json`.

## What the numbers are

- **Cost** is computed from each call's raw usage block at `lib/core.mjs`
  `PRICES`, including cache writes
  (`usage.input_tokens_details.cache_write_tokens`, 1.25x input on luna,
  terra and astra). `score.mjs` also reports a "cold" cost that prices all
  input at the cache-write rate (or the input rate for models without one).
  Back-to-back runs share a long system prompt and get cache hits sporadic
  production traffic would not, so read measured and cold as a range.
- **Latency** is from wherever you run it, with calls in flight
  concurrently — not from the production server.
- **Effort fallback.** If a model 400s blaming effort, the server silently
  retries without it and disables it for that model for the process. Every
  record carries `effortSent` / `effortMismatch`; `score.mjs` counts them.
- **Spend cap.** Every call reserves an estimate in the ledger before it
  starts and settles its real cost after; a call is refused once settled +
  open reservations + its own reservation would reach `--cap` (default $12,
  ledger-wide across processes).

## Fidelity caveats

1. The critique inputs were captured with no Semantic Scholar key (that
   provider returned nothing, as in packaged builds), with the paid web
   fallback answered 503, and without the stance model (packaged-build
   behaviour; it only affects `strengthScore` support). Detection missed 2 of
   the 26 claims in 3 draws; for those `claimText` is the whole sentence and
   the search came from detecting on it alone (`detection:
   "fallback-solo-detect"`).
2. The critique set is near ceiling: almost every config misses the two claims
   whose retrieval found no relevant source, leaving about 2 points of
   headroom. Differences show mostly in verdict nuance, cost and latency.
3. gpt-4.1 runs as the server would call it — no reasoning parameter, default
   temperature. The retired relay used temperature 0.
