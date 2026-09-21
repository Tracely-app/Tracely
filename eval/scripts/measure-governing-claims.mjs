/**
 * Does `statesClaim` change the governing-claims score, and in which direction?
 *
 * Written because the change that introduced the field rested on ONE essay.
 * The Hepburn draft had both its body paragraphs labelled `evidence` and scored
 * 0/20 on a component asking whether its body had a point — a real failure, but
 * one essay is not evidence that a rubric change is right for everyone, and
 * shipping it means every user gets that call.
 *
 * Scores the SAME classifier response twice — once by the old rule
 * (`role === 'claim'`) and once by the new one (`statesClaim` on an eligible
 * role) — so the two numbers cannot differ because the model answered
 * differently on two runs. Sampling noise is removed by construction rather
 * than averaged away.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 * It calls the Tracely server's /api/structure — the relay's classifier, which
 * moved there with the rest of the relay's reasoning. The server needs no
 * account: signed out, a call is metered as a free install. An access token
 * (TRACELY_ACCESS_TOKEN, optional) makes it run at your plan's model instead:
 *
 *   node eval/scripts/measure-governing-claims.mjs
 *   TRACELY_API_URL=http://localhost:4477 node eval/scripts/measure-governing-claims.mjs   # a local server
 *
 * It used to POST to the relay's /api/classify-structure with a shared token,
 * and needed a signed-in session token copied out of DevTools.
 *
 * Cost: 15 calls on the cheap model, against the $5-capped staging key.
 * Well under a cent, and the classifier caches by prompt on the client side
 * only — this script deliberately does not, so a rerun really re-measures.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=')
        return [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')]
      })
  )
}

// Staging, never production. The eval refuses to run against production for
// the same reason everywhere else in this repo: its numbers are only
// comparable across runs if the backend behind them does not move.
const env = loadEnvFile(join(ROOT, '.env.staging'))
const accessToken = process.env.TRACELY_ACCESS_TOKEN ?? ''
const API_URL = (process.env.TRACELY_API_URL || env.TRACELY_API_URL || 'https://api.jointracely.com').replace(/\/+$/, '')

const { splitParagraphs } = await import(pathToFileURL(join(ROOT, 'src/shared/paragraphSplit.ts')))
const { buildStructurePrompt, reconcileRoles } = await import(
  pathToFileURL(join(ROOT, 'src/main/services/ai/structureRoles.ts'))
)

// Mirrors costGuard.ts. Not imported, because that module is not a leaf and
// this script runs under Node's type stripping.
const LIMITS = { maxParagraphs: 24, maxParagraphChars: 420, maxInputChars: 8000 }

// Mirrors GOVERNING_ELIGIBLE_ROLES in structure/scoreDraft.ts.
const ELIGIBLE = new Set(['claim', 'evidence', 'reasoning'])

function governingClaims(roles, statesClaim, mode) {
  const thesisAt = roles.indexOf('thesis')
  const from = thesisAt === -1 ? 1 : thesisAt + 1
  const bodyRoles = roles.slice(from, -1)
  const bodyStates = statesClaim.slice(from, -1)
  if (bodyRoles.length === 0) return 0
  const counted = bodyRoles.filter((role, i) =>
    mode === 'old' ? role === 'claim' : bodyStates[i] && ELIGIBLE.has(role)
  ).length
  const expected = Math.max(1, Math.ceil(bodyRoles.length * 0.5))
  return Math.round(20 * Math.min(1, counted / expected))
}

const files = readdirSync(join(ROOT, 'eval/essays')).filter((f) => f.endsWith('.txt'))
let raised = 0
let lowered = 0
let unchanged = 0
let failed = 0

for (const file of files) {
  const paragraphs = splitParagraphs(readFileSync(join(ROOT, 'eval/essays', file), 'utf8')).map(
    (p) => p.text
  )
  const prompt = buildStructurePrompt(paragraphs, LIMITS)

  const response = await fetch(`${API_URL}/api/structure`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tracely-Install': 'eval-measure-governing-claims',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({ text: prompt })
  })

  if (!response.ok) {
    failed++
    console.log(`${file.padEnd(28)} HTTP ${response.status} ${(await response.text()).slice(0, 100)}`)
    continue
  }

  const { roles, statesClaim } = reconcileRoles(await response.json(), paragraphs.length)
  const before = governingClaims(roles, statesClaim, 'old')
  const after = governingClaims(roles, statesClaim, 'new')
  if (after > before) raised++
  else if (after < before) lowered++
  else unchanged++

  const thesisAt = roles.indexOf('thesis')
  const from = thesisAt === -1 ? 1 : thesisAt + 1
  // A trailing * marks statesClaim, so a disagreement between the two axes is
  // readable rather than inferred from the numbers.
  const body = roles
    .slice(from, -1)
    .map((role, i) => `${role}${statesClaim[from + i] ? '*' : ''}`)
    .join(' ')

  console.log(
    `${file.padEnd(28)} ${String(before).padStart(2)} -> ${String(after).padStart(2)}  ${body}`
  )
}

console.log(
  `\n${raised} raised · ${lowered} lowered · ${unchanged} unchanged` +
    (failed > 0 ? ` · ${failed} failed` : '') +
    `\nA "lowered" is the one to look at: it means the labeller thinks a` +
    `\nparagraph the old rule called a claim does not actually govern one.`
)
