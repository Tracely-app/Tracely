// Record/replay HTTP for the eval harness, plus a meter for what a run spends.
//
// Why this exists: seven eval runs in one morning spent ~910 of OpenAlex's
// 1,000 free daily credits and 21 paid relay detection calls, and none of it
// was visible until a 429 body was read hours later. The harness deliberately
// bypasses the app's evidence cache — a cache in front of the thing being
// measured serves pre-change results and invalidates the comparison — so every
// run re-hit every provider from scratch.
//
// The fix is to cache at the HTTP layer instead of the pipeline layer. Caching
// raw provider responses is not just cheaper, it is a BETTER measurement:
// re-runs exercise all the ranking, scoring, routing and enrichment code
// against byte-identical inputs, so a change in the reported numbers is a
// change in our code rather than in what OpenAlex felt like returning today.
//
// Patches globalThis.fetch before the harness bundle is imported, so nothing
// under src/ has to know this exists.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// Only these hosts are recorded. Everything else — favicons, redirects to
// publisher sites — passes straight through, because a cassette of a binary
// response is a bug waiting to happen and none of it affects the measurement.
const RECORDED_HOSTS = new Map([
  ['api.openalex.org', 'openalex'],
  ['api.crossref.org', 'crossref'],
  ['api.semanticscholar.org', 'semanticscholar'],
  ['eutils.ncbi.nlm.nih.gov', 'pubmed'],
  ['en.wikipedia.org', 'wikipedia']
])

const stats = {
  live: new Map(),
  replayed: new Map(),
  credits: 0,
  creditsSaved: 0,
  serverCalls: 0,
  serverReplayed: 0,
  errors: new Map()
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

// The Tracely server (was the relay) is recorded under its own label because
// it is the one PAID host here — the report counts it separately for that
// reason. Its host comes from the same apiUrl() the build inlines, so the eval
// records exactly the server the harness bundle calls.
function classify(url, serverHost) {
  try {
    const { hostname } = new URL(url)
    if (serverHost && hostname === serverHost) return 'server'
    return RECORDED_HOSTS.get(hostname) ?? null
  } catch {
    return null
  }
}

/**
 * Installs the recorder. Modes:
 *
 *   'cassette' (default) — replay when a recording exists, otherwise fetch and
 *                          record. The first run costs; every re-run is free.
 *   'refresh'           — ignore recordings, fetch live, overwrite them.
 *   'off'               — passthrough. Meters still count.
 */
export function installHttpRecorder({ cassetteDir, mode = 'cassette', apiUrl }) {
  mkdirSync(cassetteDir, { recursive: true })

  let serverHost = null
  try {
    if (apiUrl) serverHost = new URL(apiUrl).hostname
  } catch {
    // A malformed TRACELY_API_URL is the harness's problem to report, not this one's.
  }

  const realFetch = globalThis.fetch

  globalThis.fetch = async function recordingFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    const provider = classify(url, serverHost)

    // Not a provider we record — behave exactly as before.
    if (provider === null) return realFetch(input, init)

    const method = (init.method ?? (typeof input === 'object' ? input?.method : null) ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : ''
    // The access token and the install id are headers, not part of the key,
    // so cassettes stay valid across a session refresh and carry no identity.
    // The model IS part of the key, because it is in the body: a recording
    // made on one plan does not replay for another, which is correct — they
    // are different answers.
    const key = createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex').slice(0, 32)
    const file = join(cassetteDir, `${provider}-${key}.json`)

    if (mode !== 'refresh' && existsSync(file)) {
      const tape = JSON.parse(readFileSync(file, 'utf-8'))
      if (provider === 'server') stats.serverReplayed++
      else bump(stats.replayed, provider)
      stats.creditsSaved += Number(tape.credits ?? 0)
      return new Response(tape.body, {
        status: tape.status,
        statusText: tape.statusText,
        headers: tape.headers
      })
    }

    const res = await realFetch(input, init)
    const text = await res.text()

    const credits = Number(res.headers.get('x-ratelimit-credits-required') ?? 0)
    if (provider === 'server') stats.serverCalls++
    else bump(stats.live, provider)
    // Charged whether or not the request succeeded — a 429 still means the
    // budget was already gone, and that is worth seeing in the summary.
    if (res.ok) stats.credits += credits
    if (!res.ok) bump(stats.errors, `${provider} ${res.status}`)

    // Only successes are recorded. A cassette of a 429 would be replayed
    // forever — so a run made while OpenAlex's daily budget happened to be
    // spent would permanently bake "OpenAlex returns nothing" into every
    // future measurement, and the harness would keep reporting it as a real
    // retrieval result. Errors stay live so they can recover.
    if (mode !== 'off' && res.ok) {
      writeFileSync(
        file,
        JSON.stringify(
          {
            url,
            method,
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers].filter(([name]) => !name.startsWith('set-cookie')),
            credits,
            body: text
          },
          null,
          1
        )
      )
    }

    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  return { stats }
}

/** Warns before a run that is going to cost something, so the price is known
 *  in advance rather than discovered in a rate-limit body hours later. */
export function announce({ cassetteDir, mode, skipCritique }) {
  const recorded = existsSync(cassetteDir)
    ? readdirSync(cassetteDir).filter((f) => f.endsWith('.json')).length
    : 0

  if (mode === 'refresh') {
    console.log(`[spend] REFRESH — ignoring ${recorded} recordings, every request goes live.\n`)
  } else if (recorded === 0) {
    console.log('[spend] No recordings yet — this run goes live and will cost credits and server calls.')
    console.log('[spend] Every later run replays it for free until you pass EVAL_REFRESH=1.\n')
  } else {
    console.log(`[spend] Replaying ${recorded} recorded responses. Only new requests go live.\n`)
  }

  if (!skipCritique) {
    console.log('[spend] Critique is ENABLED — this is the expensive server call. EVAL_SKIP_CRITIQUE=1 turns it off.\n')
  }
}

/** Prints what the run actually spent. */
export function report(stats) {
  const total = (map) => [...map.values()].reduce((a, b) => a + b, 0)
  const liveTotal = total(stats.live)
  const replayTotal = total(stats.replayed)

  console.log('\n' + '='.repeat(58))
  console.log('SPEND')
  console.log('='.repeat(58))

  const providers = [...new Set([...stats.live.keys(), ...stats.replayed.keys()])].sort()
  if (providers.length > 0) {
    console.log('  provider          live   replayed')
    for (const name of providers) {
      console.log(
        `  ${name.padEnd(16)} ${String(stats.live.get(name) ?? 0).padStart(4)}   ${String(stats.replayed.get(name) ?? 0).padStart(8)}`
      )
    }
  }

  console.log(`\n  openalex credits spent:   ${stats.credits}`)
  if (stats.creditsSaved > 0) {
    console.log(`  openalex credits saved:   ${stats.creditsSaved}   (replayed instead of re-fetched)`)
  }
  console.log(`  free daily budget:        1000 without a key, 10000 with one`)

  console.log(`\n  PAID server calls:        ${stats.serverCalls}`)
  if (stats.serverReplayed > 0) {
    console.log(`  server calls avoided:     ${stats.serverReplayed}   (replayed)`)
  }

  if (stats.errors.size > 0) {
    console.log('\n  errors:')
    for (const [what, n] of [...stats.errors].sort()) console.log(`    ${what}  x${n}`)
  }

  if (stats.serverCalls === 0 && liveTotal === 0) {
    console.log('\n  This run cost nothing — every request was replayed.')
  } else if (replayTotal > 0) {
    console.log(`\n  ${replayTotal} of ${replayTotal + liveTotal} provider requests were free replays.`)
  }
  console.log('='.repeat(58) + '\n')
}
