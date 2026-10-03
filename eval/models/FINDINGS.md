# Which model serves each tier: measured

2026-09-21. Tracely main @2f2ca33, run through the production code paths
`runFactCheck` (POST /api/check, the extension's check) and `critique()` (the
desktop's POST /api/critique). Only the model and the reasoning effort were
changed. 13 configs x 2 reps of both tasks (806 calls), three blind judging
passes, and a 36-call production-shaped supplement. Total spend, validation
runs included: $3.42.

This file is the condensed write-up. The set it ran on is here
(`checkset.json`, `critique-inputs.json`), and so is the harness that runs it
(`harness/`, see its README).

## The decision

| tier (plan ceiling) | model | extension check | desktop critique and every other call |
|---|---|---|---|
| **fast** (Free; the default slider stop on every plan) | `gpt-5.6-luna` | effort **medium** | effort **low** (the server default) |
| **balanced** (Student) | `gpt-5.6-terra` (was `gpt-5.4`) | low | low |
| **thorough** (Pro) | `gpt-6-astra` (unchanged) | **low** (the old slider sent medium, never measured) | low |

Why:

1. **The old fast tier was bad at the check.** `gpt-5-nano@low` scored 74%. It
   never asked for a citation on any of the 12 true-but-uncited statistics
   (0/24 judgements) and called 5 of 24 false-claim judgements "accurate". On a
   production-shaped 40-sentence first check it fell to 60% with 15 harmful
   verdicts. The judges ranked it 11th of 13.
2. **`gpt-5.6-luna@medium` was the best check measured, at any price**: 110/110,
   the same verdict in both reps on all 55 sentences, 0 harmful errors, 119/120
   on the 40-sentence batch, 2nd of 13 with the judges (tied with astra). A
   typing-pause check costs 0.039-0.068 cents (nano: 0.031-0.033) and is about
   2x faster on 1-3 sentences (2.8-4.3 s vs 5.1-8.6 s).
3. **For the desktop critique, `gpt-5.6-luna@low` beat the retired relay's
   `gpt-4.1`**: 48/52 vs 43/52 (right on 5 claim-reps where gpt-4.1 was wrong,
   never the reverse), judge 7.13 vs 5.75, at 6.6-11x less per essay pass.
   Medium effort did not help the critique (48/52 either way, judge 6.58).
   Hence effort differs by task, not the model: the server default stays
   `low`, and `/api/check` alone raises the fast tier to `medium`.
4. **The paid tiers buy explanation polish and consistency, not accuracy.**
   `gpt-5.4@low` (the old balanced) was dominated on both tasks — worse than
   luna and pricier; it called "sunlight takes about eight seconds to reach
   Earth" accurate in both reps. `gpt-5.6-terra@low` beats it on every axis at
   ~15% less, but is **not more accurate than fast** (96% vs 100% on the
   check, p = 0.13; judge 6.42 vs 7.13 on the critique). It is balanced only
   because each tier needs its own id. `gpt-6-astra@low` has the top judge
   score on both tasks and never changed a verdict between reps, but its
   intervals overlap luna's and a check costs ~30x luna@medium.

Shipped with the remap: the options page no longer claims Balanced is better
on subtle claims; retired ids from old builds are translated to their tier
(`shared/plan.js` `currentModelId`); cache writes are priced
(`usage.input_tokens_details.cache_write_tokens`, 1.25x input on all three
models); the free check cap stays 400.

## 2026-10-02: what a source search costs, and why

The production ledger (`entitlement_usage`, micro-cents) said a source search
cost real users **5.8-6.0 cents** on 10-01 — against the 1.15-1.25 cents the
09-21 smoke test measured and the "~16x a check" the allowances were sized on.
A check costs 0.09 cents. The difference is the web_search tool, billed per
`web_search_call` item: a probe of twelve calls on 10-02 found the model
making 1-3 **searches** and then **opening pages** (3 opens across 3 claims)
to fill the thirteen citation fields the prompt asks for, and every opened
page also pulls ~8k "search content" tokens into the input.

Levers tried (gpt-5.6-luna, effort low, 3 claims each):

| variant | billed calls | ms | input tok | all-billed ¢ | years / authors of 4 |
|---|---|---|---|---|---|
| current prompt | 2.7 (5 search + 3 open) | 16,181 | 22,890 | 3.14 | 3.3 / 4.0 |
| `max_tool_calls: 2` | 2.0 | 14,295 | 19,368 | 2.40 | 4.3 / 4.3 |
| `search_context_size: low` | 2.7 | 31,604 | 24,138 | 3.37 | 2.0 / 2.7 (one answer ran to the output cap, no sources) |
| no page opens + one search | **1.7 (5 search, 0 open)** | **11,247** | **13,415** | **1.97** | 3.3 / 4.3 |

`max_tool_calls` did not bind (a run under `max_tool_calls: 1` still made two
searches), and `search_context_size` is not honoured by this model — both are
rejected. OpenAI's guide attaches the per-call fee to the `search` action
only, so `open_page` may never have been billed; the ledger counts every
`web_search_call` item on purpose (a cap that under-counts is worse than one
that over-counts), which is the likely reason the 10-01 bottom-up tally ran
~15¢ above the dashboard. Under search-only billing the old search was ~2.1¢
and the new one is 1.28¢ (−39%); under all-items billing, −53%. With no page
opens left, the two readings now agree. The prompt is the lever: it now says one search, a second only when
the first found nothing citable, and never open a page; the SERVER completes
the fields instead — Crossref for any DOI (0.5 s, the registrar's authors,
issue date, journal and publisher), the page's own metadata for a source still
without a year, both under one 2.5 s deadline, and a link that answers 404 is
dropped (`lib/sourceEnrich.js`, `factcheck.js completeSources`). Page reading
alone was measured first and found weak — 2 of 8 real pages yielded a year;
NYT, Pew and Nature answer a plain fetch with a bot wall — which is why DOIs
come first.

Old `findSources` (origin/main) against new, eight claims (a poll figure, two
research findings, a quotation, a national statistic, a federal figure, a
reef statistic, a theatre date), same model and effort:

| | billed calls | ms | input tok | all-billed ¢ | sources | with year | with author |
|---|---|---|---|---|---|---|---|
| old | 2.25 | 12,943 | 21,554 | **2.70** | 4.3 | 2.6 | 4.3 |
| new | **1.00** (every claim) | **9,565** | 13,667 | **1.28** | 4.5 | 2.6 | 3.5 |

Cost −53%, latency −26%, the same number of dated sources; authors slipped
where the model picked PubMed and AAP pages it no longer opens (it used to
read the byline there). The output cap went 6,000 → 3,000 tokens: an answer
is 700-1,000 tokens plus 200-600 of reasoning, and the one runaway cost 0.7
cents of output for no sources.

What this does to the allowances: at 1.28 cents Pro's 250 searches a month
are $3.20 of its $9.99 (they were $6.50 at 2.6 and $15 at 6), Student's 100
are $1.28 of $4.99, Free's 40 are 51 cents. A search is ~14 checks.

Live on production after the deploy (10-03 02:30 UTC): a research-finding
claim answered in 8.2 s for 1.25 cents, four PubMed/PMC sources, every one
with full author names, year and DOI from the completion path.

A design panel (three plans, two judges, 2026-10-02) ranked the shipped
change first and agreed on what comes next, in order: (1) count the
`search` actions beside the count-everything ledger figure, so the two can be
reconciled against OpenAI's dashboard — now on the `/api/sources` log line
as `actions=search=1,open_page=0`; (2) read the page for a source that has a
year but no author (the 4.3 → 3.5 authors regression was PubMed and AAP pages
the model no longer opens; PubMed now goes through NCBI) — done; (3) send
the search the claim's own paragraph rather than the document's first 3,000
characters, which for a claim in paragraph four was the introduction —
`claimWindow`, done; (4) before building a cross-user cache, measure its hit
rate without keeping a record: an in-memory SHA-256 of the normalised claim,
fourteen days, never on disk — `wouldHit=1|0` on the same log line. The
panel's own estimates of the hit rate ranged from 12% to 30% with no data,
which is the point of measuring. Rejected by both judges: `max_tool_calls`
as a saving (did not bind), `search_context_size: low` (measured worse),
flex or fast service tiers (tokens are a quarter of the cost; the tool fee
is undiscounted), and prefetching free retrieval at flag time (sends
sentences to third parties for searches nobody asked for). The check-side
levers (a byte-stable 2,000-char head, an explicit cache breakpoint, shard
stagger) are each worth 0.01-0.03 cents on a 0.09-cent check and wait.

## 2026-10-01: what a citation flag is for

A tester's history essay came back with every sentence underlined for a
citation ("literally every sentence is underlined"), and the check's rule
said why: "a dated event, a specific non-common-knowledge fact" counted as
citation-worthy, so every date, rank and posting of a general's life was
flagged. A new set, `checkset-narrative.json`, is that case: thirteen
uncited, correct sentences about MacArthur — ten encyclopedic, one bare
quotation, two opinions. Any flag on an encyclopedic sentence is a false
alarm (score.mjs's FA).

The rule now names four kinds of statement a reader expects a source for —
a QUANTITY (any number, percentage, count, amount, rate or price, even about
the essay's own subject), a DIRECT QUOTATION, a research finding, and a
genuinely contested claim — and says outright that the dates, names, places
and sequence of events of a narrative are "accurate" when right, cited or
not. A first draft without the quantity clause let seven of 24 uncited
statistics through; this is the second.

`gpt-5.6-luna@medium`, the old rule in a pinned worktree against the new one:

| set | rule | strict | critical | false alarms | NC miss |
|---|---|---|---|---|---|
| checkset-narrative (13 × 3 reps) | before | 21% | 1 | **29/36** | 2/3 |
| | after | **100%** | 0 | **0/36** | 0/3 |
| checkset (55 × 2) | before | 97% | 2 | 0/52 | 0/24 |
| | after | 98% | 0 | 1/52 | 1/24 |
| checkset-hard (70 × 2) | before | 86% | 5 | 6/58 | 3/22 |
| | after | 96% | 2 | **0/58** | 6/22 |

What is left on the hard set: two sentences the model holds false that are
true (1,274 measles cases in 2019; a 500-copy first edition — knowledge
errors, present before), and two it calls accurate where the label wants a
citation ("only four European teams", the HTC Dream's release month) — a
count and a date, exactly the judgement the new rule asks the model to make
toward leniency. Those two are the price of the first row.

Also measured today: the source search (`/api/sources`) at the vendor's
default effort against `low`, five claims through `findSources` —
p50 24.4 s → 12.0 s, sources 4.4 → 4.2, years filled 12/22 → 12/21, authors
17/22 → 20/21, web searches per call 3.6 → 2.4, output tokens −43%. It runs
at `low` now; the card says "Usually 10–15 seconds" instead of 3–5.

## 2026-09-23: the objective, sharded check

Re-measured after three changes to `runFactCheck`, all on `gpt-5.6-luna@medium`
(3 reps unless noted; the baseline is the same code path the day before, run
in a pinned worktree). Results dirs are gitignored; the sets are committed
(`checkset.json`, `checkset-hard.json`, `checkset-long.json`).

1. **The prompt judges only facts.** The verdict definitions no longer ask
   for "misleading" or "seriously disputed" — judgement calls about the
   author — and say outright that a true claim is never "questionable" for
   being unpopular or uncomfortable, and that a forceful opinion is
   `no_claim`, not `false`.
2. **Evidence by shape.** The model answers two finding shapes: a clean
   sentence is `{id, verdict}` and nothing else; a flagged one must carry
   `basis` — the correct fact for `false`, what cannot be verified for
   `questionable`, the kind of source for `needs_citation`. The route demotes
   a `false` with no basis to `questionable`. Clean sentences are most of a
   draft, so this also cuts output tokens, which on a reasoning model is
   where the time goes.
3. **Shards.** A list longer than 8 sentences runs as concurrent calls of
   ≤ 8, each admitted against the spend hold; an id the model leaves out is
   asked again once.

| set | pipeline | strict | critical | false alarms | p50 | p90 | ¢/call |
|---|---|---|---|---|---|---|---|
| checkset (5 × 11 sentences) | before | 95% | 4 | 4/78 | 12.2 s | 17.4 s | 0.128 |
| | **after** | 96% | 2 | **0/78** | 10.9 s | 12.9 s | 0.169 |
| | after, effort `low` | 92% | 3 | 1/78 | 5.8 s | 6.7 s | 0.127 |
| checkset-hard (6 essays, 70 sentences: 24 subtle-false, 12 opinions incl. loaded ones, 6 traps, 11 cited; every label source-verified by an adversarial pass) — 2 reps | before | 94% | 4 | 6/58 | 17.4 s | 21.2 s | 0.178 |
| | **after** | 94% | 3 | 4/58 | 15.7 s | 19.7 s | 0.215 |
| checkset-long (one 40-sentence essay: the extension's `MAX_SENTENCES_PER_CHECK`, i.e. the first check of an opened document) | before | 99% | 0 | 0/51 | **35.7 s** | 39.2 s | 0.41 |
| | **after** | 98% | 2 | 1/51 | **6.3 s** | 10.4 s | 0.60 |

What it means:

- **The first pass over a document is ~5.7x faster** (35.7 s → 6.3 s at p50).
  That is the case a person feels; a typing-pause check (1-8 sentences) is
  one shard, so it is unchanged in shape and cost.
- **False alarms — a flag on a cited, common-knowledge or opinion sentence
  — fell on every set** (4→0, 6→4, 0→1 of 187 judgements). That is what
  "objective" buys. The hard set's subtle-false and trap classes held.
- **Cost per multi-shard check rises 30-45%** (each shard repeats the
  instructions, which the provider caches, and the short document context,
  and the model's reasoning has a floor per call). At luna's prices that is
  +0.2¢ on a 40-sentence first check; the typing-pause checks that make up
  the volume do not shard. The spend cap holds one extra worst case per shard
  in flight (server.js `admitExtraCalls`).
- **Effort `low` is 2x faster again but loses accuracy** (92%, 8/36 uncited
  statistics passed as accurate), so the check stays at `medium`. It is the
  obvious lever if a cheaper tier is ever wanted.
- Two of 120 judgements on the 40-sentence run were critical (vs 0 before);
  with 3 reps that is within noise, and it is the number to watch on the
  next re-measure.

## Method

**Check.** `checkset.json`: 55 labelled sentences in 5 student-style essays
(history, science, health, economics, literature), 11 each: 12 false (8
subtle), 12 true-but-uncited statistics, 10 cited, 8 common knowledge, 8
opinion, 5 traps (surprising but true, or dated but right for their date). Each
essay is one `/api/check` call, built exactly as the extension builds it (its
`segmentText`/`hashText`, verified 0 mismatches). A verdict scores 1 if in the
label's `acceptable` set, 0.5 if `partial`; `critical` verdicts — endorsing a
falsehood, calling a truth false, asking a cited sentence for a citation — are
counted as **harmful**. A pre-run audit of all 55 labels changed 2 scoring sets
(recorded in the file's `audit` field). See `checkset.README.md`.

**Critique.** 26 claims across 7 essays from `eval/critique/expected.json`.
The request bodies in `critique-inputs.json` were built by the desktop's own
pipeline, run once live on 2026-09-21 (detection, OpenAlex / Crossref / PubMed
/ Wikipedia / World Bank retrieval, MiniLM ranking, reference checks, the
evidence summary), then frozen so every config saw identical input.

**Configs.** gpt-5-nano (low, medium), gpt-5.4-nano, gpt-5.6-luna (low,
medium), gpt-5-mini, gpt-5.4-mini (low, medium), gpt-5.6-terra, gpt-5.4,
gpt-6-astra (all low unless named), gpt-4.1 and gpt-4.1-mini (no reasoning
parameter, default temperature — as the server would call them). 2 reps each.

**Judging.** Three blind passes, one per lens — factual correctness and
calibration, usefulness to a student writer, reasoning rigor — scored every
response 0-10. Packets carried no model names; responses were shuffled and
lettered per item with a fixed seed, and the key was kept apart. The check
packet held 20 items (all 12 false sentences, all 5 traps, the 3 hardest
needs-citation sentences); the critique packet claims C01-C08. Rep 1 only.
The lenses agreed: Kendall's W = 0.96 (check) and 0.92 (critique), and judge
scores tracked the mechanical scores (Spearman 0.93 check, 0.82 critique).

**Supplement.** A 5,445-character document (just under `runFactCheck`'s
6,000-character trim), checked 3 times at 1, 3 and 40 sentences on nano@low,
luna@low, luna@medium and terra@low; reps 2-3 cache-warm as a re-sent document
would be. "Cold" prices every input token at the cache-write rate.

## Results

### Check (110 judgements per config)

| config | accuracy (r1 / r2) | harmful | needs-citation missed | same verdict both reps | judge | ¢ per 11-sentence call, cold | p50 / p90 |
|---|---|---|---|---|---|---|---|
| gpt-5-nano@low (old fast) | 74% (73 / 75) | 5 | 24/24 | 53/55 | 5.62 | 0.063 | 9.5 / 11.3 s |
| gpt-5-nano@medium | 76% (78 / 75) | 4 | 22/24 | 46/55 | 6.60 | 0.203 | 41.5 / 62.4 s |
| gpt-5.4-nano@low | 74% (69 / 78) | 19 | 4/24 | 39/55 | 4.97 | 0.135 | 7.5 / 8.8 s |
| gpt-5.6-luna@low | 90% (93 / 87) | 5 | 5/24 | 42/55 | 8.05 | 0.109 | 6.1 / 7.8 s |
| **gpt-5.6-luna@medium (fast)** | **100% (100 / 100)** | **0** | **0/24** | **55/55** | 8.47 | 0.144 | 7.8 / 12.2 s |
| gpt-5-mini@low | 83% (84 / 82) | 0 | 21/24 | 54/55 | 7.40 | 0.265 | 13.1 / 15.3 s |
| gpt-5.4-mini@low | 85% (85 / 85) | 8 | 8/24 | 36/55 | 6.28 | 0.401 | 5.1 / 6.5 s |
| gpt-5.4-mini@medium | 94% (91 / 96) | 5 | 1/24 | 49/55 | 7.53 | 0.777 | 10.1 / 17.8 s |
| **gpt-5.6-terra@low (balanced)** | 96% (93 / 100) | 0 | 1/24 | 51/55 | 8.05 | 1.077 | 8.7 / 11.9 s |
| gpt-5.4@low (old balanced) | 95% (95 / 95) | 5 | 0/24 | 53/55 | 7.55 | 1.274 | 7.1 / 8.4 s |
| **gpt-6-astra@low (thorough)** | 98% (98 / 98) | 2 | 0/24 | 55/55 | **8.73** | 4.291 | 9.6 / 13.3 s |
| gpt-4.1 | 89% (89 / 89) | 5 | 7/24 | 52/55 | 7.48 | 0.615 | 4.8 / 12.3 s |
| gpt-4.1-mini | 77% (76 / 78) | 13 | 10/24 | 52/55 | 5.37 | 0.112 | 3.2 / 7.3 s |

On accuracy the non-dominated set is nano@low → luna@low → luna@medium; on
judge score astra joins it. luna@medium was right where nano@low was wrong on
29 sentence-reps, and never the other way (exact McNemar p ≈ 4e-9). Against
terra 4/0 (p = 0.13), gpt-5.4 6/0 (p = 0.03), astra 2/0 (p = 0.5). astra's 2
harmful verdicts were both a pedantic "false" on "burning fossil fuels
releases CO2 locked underground".

### Critique (52 judgements per config; judge on C01-C08)

| config | acceptable | fabricated caught | judge | ¢ per 6-critique pass (measured-cold) | p50 |
|---|---|---|---|---|---|
| gpt-5-nano@low | 44/52 | 14/14 | 4.71 | 0.19-0.27 | 5.9 s |
| **gpt-5.6-luna@low (fast)** | **48/52** | 14/14 | 7.13 | **0.29-0.76** | 3.2 s |
| gpt-5.6-luna@medium | 48/52 | 14/14 | 6.58 | 0.41-0.87 | 4.3 s |
| gpt-5.6-terra@low | 47/52 | 14/14 | 6.42 | 2.5-7.1 | 4.1 s |
| gpt-5.4@low | 46/52 | 14/14 | 6.21 | 4.7-8.3 | 4.0 s |
| gpt-6-astra@low | 48/52 | 14/14 | **7.79** | 9.4-32.5 | 5.8 s |
| gpt-5.4-mini@low / @medium | 44/52 / 38/52 | 10/14 / 5/14 | 5.92 / 5.79 | 1.4-2.6 / 2.9-4.1 | 3.1 / 6.8 s |
| gpt-4.1 (the relay's model) | 43/52 | 14/14 | 5.75 | 3.3-5.0 | 2.6 s |
| gpt-4.1-mini | 28/52 | 0/14 | 4.00 | 0.8-1.0 | 1.7 s |

No config called a real citation fabricated (0/36 each). gpt-4.1 is also
operationally unsafe: the organisation's 30,000 tokens-per-minute limit gave 47
HTTP 429s across 29 calls at 2 in flight — about 8 critiques a minute for all
users combined.

### Effort: low vs medium on luna

| | check | 40-sentence batch | critique | same verdict both reps (check) |
|---|---|---|---|---|
| low | 90%, 5 harmful | 93% | 48/52, judge 7.13 | 42/55 |
| medium | 100%, 0 harmful (11 / 0, p = 0.001) | 99% | 48/52, judge 6.58 | 55/55 |

Medium costs +32% cold on an 11-sentence call but only +13-22% on a
typing-pause check, and leaves 1-3-sentence latency unchanged.

### Production-shaped cost (per check call; measured to cold)

| | nano@low (old) | luna@low | **luna@medium** | terra@low |
|---|---|---|---|---|
| 1 sentence (typing pause) | 0.031-0.033¢ | 0.038-0.067¢ | **0.039-0.068¢** | 0.338-0.630¢ |
| 3 sentences | 0.041-0.050¢ | 0.054-0.085¢ | **0.074-0.104¢** | 0.423-0.729¢ |
| 40 sentences (first check / paste) | 0.105-0.117¢ | 0.232-0.279¢ | **0.341-0.388¢** | 2.73-3.21¢ |
| median latency, 1 / 3 / 40 sentences | 5.1 / 8.6 / 16.1 s | 2.8 / 4.2 / 11.8 s | **2.8 / 4.3 / 18.1 s** | 3.5 / 3.4 / 25.3 s |
| accuracy on the 40-sentence batch (120) | 60%, 15 harmful | 93%, 3 harmful | **99%, 1 harmful** | 97%, 4 harmful |

What that means per user, on luna@medium: 2.8-4.3 cents to write a 50-sentence
essay checking each sentence once; 0.43-0.49 cents to paste and check a
finished one; **$0.23-0.35 a day for a free user at the 400-check cap** (1
first check + 399 typing-pause checks) — the same ~34 cents
`FREE_DAILY_CHECKS = 400` was sized against on nano, so it stays. The $10/day
extension pool covers **29-44 capped users** (60-69 on nano).

An astra typing-pause check is ~1.5-3.0 cents (estimated from token counts,
not measured in the supplement), so a Pro user at 400 checks would spend $6-12
a day of the shared pool. Keep the per-keystroke default on fast for every
plan.

## Caveats

1. **Small samples.** 55 check sentences, only 12 false; one sentence moves
   accuracy 1.8 points. luna@medium's 110/110 has a lower 95% bound of about
   95%. Differences among luna@medium, astra, terra and gpt-5.4 are 2-6
   judgements and mostly not significant; the McNemar tests treat the 2 reps
   as independent, so their p-values are optimistic. The nano-vs-luna gap is
   robust and was reproduced on the 40-sentence batch (which reuses sentences,
   so it confirms rather than independently replicates).
2. **The critique set is near its ceiling.** Almost every config misses the two
   claims where retrieval found nothing. Only 8 claims were judged (intervals
   about ±1-1.4). luna@low over gpt-4.1 is 5-0, p = 0.06.
3. **Latency on big batches.** A 40-sentence luna@medium check takes 16-19 s,
   and the 11-sentence p90 is 12.2 s — both above the extension's 10 s check
   spacing. Latency was measured from a Mac with up to 13 requests in flight,
   not from the Linode.
4. **Variance.** luna@low changed its verdict between reps on 13 of 55
   sentences; medium removed that. A single post-remap smoke rerun of one essay
   (below) gave luna@medium 10/11, one needs-citation missed, where both
   original reps scored 11/11 — medium is steadier, not deterministic.
5. **Bare ids drift.** luna, terra and astra echo bare ids with no dated
   snapshot, so their behaviour can change silently. Re-run this eval after any
   provider-side change.
6. **What the fast tier covers that was not measured**: detect, grade,
   structure, Tracer, correction, flow, and the source search. The source
   search sends no effort on the store build (the vendor's default).
   astra@medium, luna@high and every `minimal`/`high` config were not
   measured.

## Checked after the remap (2026-09-21)

- **The cache-write field** is `usage.input_tokens_details.cache_write_tokens`,
  a subset of `input_tokens` and disjoint from `cached_tokens`: a first-seen
  ~5k-token prefix came back as `cache_write_tokens: 4976, cached_tokens: 0`,
  and the identical call a moment later as `0 / 4976`, on all three models.
  `lib/providers/openai.js` reads it; `costMicroCents` prices it at
  `shared/prices.js` `cacheWrite`.
- **Source search on luna** (one claim, `findSources`, one call each): no
  effort 5.2 s, 4 sources, 1.25 cents; effort medium 4.8 s, 4 sources, 1.15
  cents (the $0.01 web_search fee is most of it). A smoke test, not an eval.
- **The harness runs from this repo unpatched** (1 essay + 1 critique on
  luna@medium and gpt-5-nano@low, $0.004).

## Re-running it

See `harness/README.md`. In short:

```sh
OPENAI_API_KEY=... node eval/models/harness/run.mjs --configs gpt-5.6-luna@medium,gpt-5.6-terra@low,gpt-6-astra@low --reps 2
node eval/models/harness/score.mjs            # mechanical scores; results/ is gitignored
```

A full 13-config, 2-rep run cost about $3.25 (astra $1.16 of it). These are not in the repo; how
to rebuild them if needed:

- **The blind judge packets and their analysis** (bootstrap intervals,
  agreement statistics, McNemar tests). Build packets from rep-1 results with
  model ids stripped, responses shuffled per item with a fixed seed and the
  key held apart; score each response 0-10 under each of the three lenses
  above; de-anonymise only after scoring.
- **The production-shaped supplement.** Concatenate the check essays into one
  ~5,400-character document and send 1, 3 and 40 of its sentences per call,
  3 reps, sequentially, so reps 2-3 are cache-warm.
- **The checkset builder and label-audit scripts.** `checkset.json` is the
  audited artifact; edit it directly and keep `checkset.README.md`'s rules
  (no internal `.` `!` `?` in a sentence, so the extension's segmenter keeps
  it whole).
- **Recapturing `critique-inputs.json`** needs the desktop's retrieval
  pipeline run live, and will not be byte-identical — retrieval changes daily.
