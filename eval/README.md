# eval/ — what is live and what is a record

Two kinds of thing live here. Mixing them up costs money or sends an agent
chasing a number nobody is measuring any more.

## Live (run these; each spends real API money — say what a run costs first)

| Path | What | Run |
|---|---|---|
| `models/harness/` | The model eval behind every tier, effort and prompt decision. Sets: `checkset.json`, `checkset-hard.json`, `checkset-long.json`, `checkset-narrative.json`. Results are gitignored; conclusions go in `models/FINDINGS.md`. | `models/harness/README.md` |
| `models/FINDINGS.md` | The dated log of what was measured and decided. Append a dated section; never rewrite an old one. | — |
| `revision/` | Fix-in-doc revision checks. | its README |
| `annotations/` + `scripts/validate-annotations.mjs` | Hand labels for the desktop retrieval eval and their validator. | `npm run eval:validate` |
| `RUBRIC.md` | The grading rubric the server's `/api/grade` prompt is built from (`server/shared/rubric.js`; `server/test/rubric.test.js` pins the port). | — |

The `eval:*` scripts in the root `package.json` drive the **desktop** retrieval,
citation and critique evals against `eval/reports/`; they are paid runs. Ask Sam
before running one.

## Records (frozen, August 2026 — read, do not update)

- `baseline.md` — the labelled retrieval baseline (30/102 precision) that the
  desktop's scoring in `src/main/services/search/` was fitted against. Source
  comments cite it by this path; leave it here.
- `rerun-2026-08-09.md`, `label-review-01.md` — the rerun and label audit.
- `retrieval/`, `critique/`, `fabrication/`, `citations/`, `bibliography/` —
  each folder's `FINDINGS.md` is the record of one August measurement, with the
  scripts that produced it. `critique/expected.json` was written before the run
  it grades, on purpose.

`preview.html` and the `*-cache.json` files are build output and HTTP caches;
they are ignored and rebuilt by the scripts.
