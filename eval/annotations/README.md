# Hand annotations

One JSON file per essay in `eval/essays/`, named after it. These are the ground
truth every measurement in `eval/scripts/` is computed against.

```bash
npm run eval:import-baseline   # bootstrap from eval/baseline.md (once)
npm run eval:validate          # after every edit
npm run eval:fit               # fit scoring weights against the labels
```

## Why not just keep extending `eval/baseline.md`

Two reasons, both recorded as failures rather than preferences.

**It joins to a report by position.** `eval/scripts/paths.mjs` documents the
cost: one extra detected claim shifts every subsequent label onto the wrong
sources, and the measurement still prints a confident percentage. Annotations
here join by **verbatim claim text**, and `eval:validate` refuses to run if a
sentence isn't in the essay it claims to be in.

**Its labels are prose.** `MMWR School Start Times US 2011–12` is a human
shorthand for a paper actually titled *School Start Times for Middle School and
High School Students — United States, 2011–12 School Year*. That reads well and
cannot be joined to anything mechanically.

`baseline.md` stays as the written record of the 2026-08-08 run. These files are
what scripts read.

## Shape

```json
{
  "essay": "01-school-start-times.txt",
  "labelledBy": "merrick",
  "report": "report-2026-08-08T02-37-26-088Z.json",

  "draft": {
    "grade": 74,
    "roles": ["thesis", "claim", "evidence", "counterargument", "conclusion"]
  },

  "claims": [
    {
      "text": "the sentence, copied verbatim from the essay",
      "paragraph": 2,
      "verdict": "miscited",
      "citationWorthy": "yes",

      "citedSource": {
        "doi": "10.1234/example",
        "says": "what the source actually claims, in your words"
      },

      "support": { "rel": 1, "total": 8 },
      "sources": [
        { "doi": "10.15585/mmwr.mm6430a1", "title": "…", "label": "rel" }
      ],

      "note": "free text, ignored by every script"
    }
  ]
}
```

Everything except `essay`, `claims` and each claim's `text` is optional. `null`
means *not judged yet* and is valid — that's what the importer writes rather
than guessing.

### `verdict` — about the claim

| | |
|---|---|
| `supported` | the literature backs this as written |
| `unsupported` | nothing found either way; may still be true |
| `contradicted` | the literature argues against it |
| `miscited` | a real source is cited, and it does not say this |
| `unverifiable` | no source could settle it — a prediction, a value judgement |

`miscited` **requires `citedSource.says`**, and validation enforces it. The
entire signal is the gap between what the sentence asserts and what the source
actually claims; half that pair is not a label, it's an opinion.

### `label` — about one retrieved source

Same three verdicts `baseline.md` uses, kept identical so numbers stay
comparable across the format change.

| | |
|---|---|
| `rel` | actually evidence for this specific claim |
| `marg` | right topic, doesn't evidence the claim as phrased |
| `irr` | not about this claim at all |

**Read [`../RUBRIC.md`](../RUBRIC.md) before applying these.** The rel/marg
boundary is where labelling drifts between sessions — it moved the reported
precision 7 points between 2026-08-08 and 2026-08-09 with no code change in
between. The rubric is the decision procedure that stops that.

### `draft.roles`

One role per paragraph, in order, from the same set as `ParagraphRole` in
`src/shared/types.ts`. Must have exactly as many entries as the essay has
paragraphs — where a paragraph is **any newline run**, matching
`splitParagraphs`. Use `"unknown"` when you genuinely can't tell; that's a real
answer here for the same reason it is in the app.

## What to collect, if you're deciding where to spend annotation time

Ranked by what it unblocks:

1. **`sources[].label`** — the relevance floor and the scoring weights are
   fitted against these. ~200 labelled sources before the floor stops moving
   with individual judgements. **Read "Item 1's headline number" below before
   spending a day here: 288 such judgements already exist in
   `eval/retrieval/labels`, in a store `eval:fit` does not read.**
2. **`draft.roles`** — trains a paragraph-role classifier as a linear probe on
   the MiniLM embeddings already shipping. ~300–500 paragraphs. This is the one
   that *removes* an API call rather than holding cost flat: it replaces the
   structure classifier (the server's `/api/structure`, formerly the relay's
   `classify-structure`).
3. **`verdict` + `citedSource.says`** — miscitation detection. Hardest, most
   valuable, needs the most examples, and needs source text rather than just a
   DOI.

Two things worth knowing before you start:

- **Flawed essays carry more signal than clean ones.** A perfect essay
  contributes almost no negatives. Aim for roughly 3:1 flawed to clean.
- **One annotator means one idiolect.** A model fitted only to your judgements
  learns *you*. That's fine for a tool you're building for yourself, and worth
  knowing before calling it general.

### Item 1's headline number counts one of two stores — measured 2026-08-21

**`sources[].label` is 0 here, and the repo holds 288 per-source verdicts.**
Both are true. `eval/retrieval/labels/*.json` is a second label store, on the
same `rel`/`marg`/`irr` scale, joined to its report by claim-text prefix rather
than by DOI: 36 claims across essays 01–09, 288 source verdicts, 51 of them
`rel`. That is already past the ~200 this file calls the floor.

`npm run eval:validate` printed only the first number, and that line is what
the BUGS row and every run reading it quoted. So "per-source labels are still
0" was read as *nobody has labelled anything* when it meant *the fitter's store
is empty*. `eval/scripts/fit-weights.mjs` reads these annotations;
`eval/retrieval/rank.mjs` and `floor.mjs` read the other directory. Neither
knows about the other.

**So the next move on item 1 is reconciling the two stores, not labelling ~200
sources again.** That is a real piece of work — the two join to different
reports by different keys, and merging them wrong would silently mislabel, the
exact failure `paths.mjs` documents — but it is much cheaper than re-labelling,
and it is what stands between 288 existing judgements and `eval:fit`.

Do not fold the two counts into one total. The fitter would look fed while
still seeing nothing, which is the same class of error as the one above.

### And none of it runs from a cloud run — measured 2026-08-17, still true

Labelling a source means having a candidate list, which means running
retrieval, and the scheduled cloud runs that do most of the writing here
**cannot reach any of the four providers**. Their egress proxy answers `403` to the CONNECT for
`api.openalex.org`, `api.crossref.org`, `api.semanticscholar.org` and
`eutils.ncbi.nlm.nih.gov` — a policy denial, not a transient failure and not
something a retry or a different client fixes.

Two consequences worth writing down rather than rediscovering:

- **A cloud run can only add essays, roles, verdicts and rubric.** That is real
  work — it is what everything from `04-energy-access` onward is — but it moves
  items 2 and 3, never item 1. An overnight run reporting progress on the
  retrieval blocker is reporting progress on the half of it that was never the
  blocker.
- **The 102 prose labels in `eval/baseline.md` need no provider access — but
  they do need the report, and `eval/reports/` is gitignored.** So a cloud run
  that clones the repo cannot do them either: `eval/.gitignore` keeps reports
  out, and `import-baseline.mjs` reads
  `report-2026-08-08T02-37-26-088Z.json` on its first line. "No network"
  was read as "anywhere"; it means "anywhere the report is", which today is
  Merrick's PC only. Re-labelling them is also *not* mechanical — the importer
  says so in its own header, because the prose names sources by shorthand
  title.

Everything else in item 1 has to happen where the network does: a local run on
Merrick's PC, where `npm run evaluate` can retrieve (`EVAL_SKIP_CRITIQUE=1`
keeps the paid detection call in and the paid critique call out — read that
script's header before assuming any of it is free). What comes back can then be
labelled anywhere, since the report is what labelling reads. Note that the
recorded provider responses are not the thing to carry across: `paths.mjs`
keeps the abstract cache out of the repo deliberately, on the grounds that it
is other people's text rather than source, and the same applies to cassettes.
