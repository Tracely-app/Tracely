import { describe, it } from 'node:test'
import { deepStrictEqual, strictEqual, ok, notStrictEqual } from 'node:assert/strict'
import {
  MAX_VERIFY_SOURCES,
  RECEIPTS_EMPTY_TTL_MS,
  RECEIPTS_FAILURE_TTL_MS,
  RECEIPTS_FULL_TTL_MS,
  RECEIPTS_PARTIAL_TTL_MS,
  RECEIPTS_VERIFIER_VERSION,
  abstractToSend,
  answerFromCache,
  receiptsInOrder,
  settleReceipts,
  firstInsertable,
  groupByReceipt,
  mayInsert,
  parseReceipts,
  receiptsById,
  receiptsCacheKeyMaterial,
  receiptsTtlMs,
  verifyRequestBody,
  type ReceiptsState,
  type SourceReceipt,
  type VerifySourceInput
} from './sourceReceipts.ts'

/**
 * The rule under test, on both surfaces: no source is presented as backing a
 * sentence unless Tracely read it and can show the words from it that back
 * the sentence. Measured 2026-10-07: 15 of the 145 sources the desktop showed
 * (10%) backed their sentence.
 */

const src = (id: string, extra: Partial<VerifySourceInput> = {}): VerifySourceInput => ({
  id,
  title: `Title ${id}`,
  url: `https://example.org/${id}`,
  doi: null,
  abstract: null,
  venue: null,
  year: null,
  provider: 'openalex',
  ...extra
})

const receipt = (id: string, verdict: SourceReceipt['verdict'], extra: Partial<SourceReceipt> = {}): SourceReceipt => ({
  id,
  verdict,
  quote: verdict === 'backs' || verdict === 'contradicts' ? `words from ${id}` : null,
  readFrom: verdict === 'unread' ? null : 'abstract',
  retracted: false,
  ...extra
})

describe('what is sent', () => {
  it("sends a scholarly index's abstract — never the web search model's summary, never a page's own text", () => {
    for (const p of ['openalex', 'crossref', 'semanticscholar', 'pubmed']) {
      strictEqual(abstractToSend(p, '  The work’s own   abstract. '), 'The work’s own abstract.', p)
    }
    // webSources.ts stores the MODEL's "supports" line in `abstract`. A quote
    // lifted from that would be a receipt for words the source never wrote.
    strictEqual(abstractToSend('web', 'The page states that X rose 40%.'), null)
    // Their text is the page's: the server reads the page and says so.
    strictEqual(abstractToSend('wikipedia', 'Lead section.'), null)
    strictEqual(abstractToSend('worldbank', 'Indicator definition.'), null)
    strictEqual(abstractToSend('manual', 'Typed by the writer.'), null)
    strictEqual(abstractToSend('openalex', '   '), null)
  })

  it('at most 8 sources, unique ids, clamped fields, no draft context', () => {
    const many = Array.from({ length: 12 }, (_, i) => src(`s${i}`))
    const body = verifyRequestBody('  Anxiety rose\n40%.  ', [src('dup'), src('dup'), ...many])
    strictEqual(body.claim, 'Anxiety rose 40%.')
    strictEqual(body.sources.length, MAX_VERIFY_SOURCES)
    deepStrictEqual(body.sources.slice(0, 2).map((s) => s.id), ['dup', 's0'])
    strictEqual('context' in body, false, 'the judge reads the claim alone; the draft stays here')
    const [one] = verifyRequestBody('c', [
      src('x', { title: 't'.repeat(900), abstract: 'a'.repeat(9000), doi: '10.1234/abc', venue: 'Nature', year: 2021, url: 'javascript:alert(1)' })
    ]).sources
    deepStrictEqual(
      [one.title.length, one.abstract?.length, one.doi, one.venue, one.year, one.url],
      [400, 4000, '10.1234/abc', 'Nature', 2021, undefined]
    )
  })
})

describe('what is trusted back', () => {
  it('one receipt per id SENT, in order; an unanswered id is unread; an unsent one is ignored', () => {
    const got = parseReceipts(
      { receipts: [{ id: 'b', verdict: 'topic', readFrom: 'page' }, { id: 'zzz', verdict: 'backs', quote: 'q' }, { id: 'a', verdict: 'backs', quote: ' It fell by 73%. ', readFrom: 'abstract' }] },
      ['a', 'b', 'c']
    )
    deepStrictEqual(got, [
      { id: 'a', verdict: 'backs', quote: 'It fell by 73%.', readFrom: 'abstract', retracted: false },
      { id: 'b', verdict: 'topic', quote: null, readFrom: 'page', retracted: false },
      { id: 'c', verdict: 'unread', quote: null, readFrom: null, retracted: false }
    ])
  })

  it('backs or contradicts with no words to show is topic — no receipt, no backing', () => {
    const got = parseReceipts(
      { receipts: [{ id: 'a', verdict: 'backs' }, { id: 'b', verdict: 'contradicts', quote: '   ' }, { id: 'c', verdict: 'nonsense', quote: 'q' }] },
      ['a', 'b', 'c']
    )
    deepStrictEqual(got?.map((r) => [r.verdict, r.quote]), [['topic', null], ['topic', null], ['unread', null]])
  })

  it('a retracted work is flagged and never backing', () => {
    const [r] = parseReceipts({ receipts: [{ id: 'w', verdict: 'backs', quote: 'q', retracted: true }] }, ['w']) ?? []
    deepStrictEqual([r.verdict, r.retracted, r.quote], ['unread', true, null])
  })

  it('a body that is not an answer is null, so the caller falls back', () => {
    strictEqual(parseReceipts(null, ['a']), null)
    strictEqual(parseReceipts({ error: { kind: 'not_found' } }, ['a']), null)
    strictEqual(parseReceipts({ receipts: 'no' }, ['a']), null)
  })
})

describe('the cache', () => {
  it('keyed on the verifier version, the claim and the SET of source ids', () => {
    const k = receiptsCacheKeyMaterial('Anxiety  rose 40%.', ['b', 'a', 'a'])
    strictEqual(k, `ai:verify-sources::v${RECEIPTS_VERIFIER_VERSION}::Anxiety rose 40%.::a|b`)
    strictEqual(receiptsCacheKeyMaterial('Anxiety rose 40%.', ['a', 'b']), k, 'the same sources in another order are the same question')
    notStrictEqual(receiptsCacheKeyMaterial('Anxiety rose 41%.', ['a', 'b']), k)
    notStrictEqual(receiptsCacheKeyMaterial('Anxiety rose 40%.', ['a', 'b', 'c']), k)
  })

  it('an answer that read nothing expires in minutes; a partial one in an hour; a full one in a week', () => {
    strictEqual(receiptsTtlMs([receipt('a', 'unread'), receipt('b', 'unread')]), RECEIPTS_EMPTY_TTL_MS)
    strictEqual(receiptsTtlMs([]), RECEIPTS_EMPTY_TTL_MS)
    strictEqual(receiptsTtlMs([receipt('w', 'unread', { retracted: true })]), RECEIPTS_EMPTY_TTL_MS)
    strictEqual(receiptsTtlMs([receipt('a', 'backs'), receipt('b', 'unread')]), RECEIPTS_PARTIAL_TTL_MS)
    strictEqual(receiptsTtlMs([receipt('a', 'topic'), receipt('b', 'contradicts'), receipt('w', 'unread', { retracted: true })]), RECEIPTS_FULL_TTL_MS)
    ok(RECEIPTS_EMPTY_TTL_MS < RECEIPTS_PARTIAL_TTL_MS && RECEIPTS_PARTIAL_TTL_MS < RECEIPTS_FULL_TTL_MS)
  })
})

describe('the fallback', () => {
  // Server unreachable, an older server that 404s the route, a refusal, a
  // judge that failed: the list works as it did before receipts.
  it('a failed call is unavailable — never a list of unread — and is cached for a minute', () => {
    const s = settleReceipts({ ok: false, reason: 'Not found' }, ['a', 'b'])
    deepStrictEqual(s.answer, { status: 'unavailable', reason: 'Not found' })
    deepStrictEqual(s.cache, { status: 'failed', reason: 'Not found' })
    strictEqual(s.ttlMs, RECEIPTS_FAILURE_TTL_MS)
    strictEqual(mayInsert({ status: s.answer.status } as ReceiptsState, 'a'), true, 'Insert stays, as before receipts')
  })

  it('an answer that is not receipts falls back the same way', () => {
    const s = settleReceipts({ ok: true, body: '<html>502 Bad Gateway</html>' }, ['a'])
    strictEqual(s.answer.status, 'unavailable')
    strictEqual(s.ttlMs, RECEIPTS_FAILURE_TTL_MS)
  })

  it('an answer is cached by what it read, and comes back out of the cache as it went in', () => {
    const s = settleReceipts({ ok: true, body: { receipts: [{ id: 'a', verdict: 'backs', quote: 'It fell by 73%.', readFrom: 'page' }] } }, ['a', 'b'])
    strictEqual(s.answer.status, 'checked')
    strictEqual(s.ttlMs, RECEIPTS_PARTIAL_TTL_MS, "b was not answered for, so it is unread, so the list is partial")
    deepStrictEqual(answerFromCache(s.cache), s.answer)
    deepStrictEqual(answerFromCache({ status: 'failed', reason: 'down' }), { status: 'unavailable', reason: 'down' })
  })

  it('every source the surface sent gets a receipt, in its order; one never asked about is unread', () => {
    const got = receiptsInOrder(['c', 'a', 'z'], [receipt('a', 'backs'), receipt('c', 'topic')])
    deepStrictEqual(got.map((r) => [r.id, r.verdict]), [['c', 'topic'], ['a', 'backs'], ['z', 'unread']])
  })
})

describe('grouping and order', () => {
  it('backs, then contradicts, then topic, then unread — each in the caller’s order; retracted dropped', () => {
    const items = ['t1', 'u1', 'b1', 'x', 'c1', 'b2', 'w', 't2']
    const byId = receiptsById([
      receipt('t1', 'topic'),
      receipt('u1', 'unread'),
      receipt('b1', 'backs'),
      receipt('c1', 'contradicts'),
      receipt('b2', 'backs'),
      receipt('w', 'backs', { retracted: true }),
      receipt('t2', 'topic')
    ])
    deepStrictEqual(groupByReceipt(items, (i) => i, byId), {
      backs: ['b1', 'b2'],
      contradicts: ['c1'],
      topic: ['t1', 't2'],
      // `x` was never answered for: not checked is never backing.
      unread: ['u1', 'x']
    })
  })
})

describe('the Insert rule', () => {
  const checked: ReceiptsState = {
    status: 'checked',
    byId: receiptsById([receipt('b', 'backs'), receipt('c', 'contradicts'), receipt('t', 'topic'), receipt('u', 'unread'), receipt('w', 'backs', { retracted: true })])
  }

  it('checked: only a source whose receipt backs the sentence', () => {
    strictEqual(mayInsert(checked, 'b'), true)
    for (const id of ['c', 't', 'u', 'w', 'never-sent']) strictEqual(mayInsert(checked, id), false, id)
  })

  it('while checking: nothing — and with no state or no selection, nothing', () => {
    strictEqual(mayInsert({ status: 'checking' }, 'b'), false)
    strictEqual(mayInsert(null, 'b'), false)
    strictEqual(mayInsert(checked, null), false)
  })

  it('the fallback: the server could not check them, so Insert is allowed as it was before receipts', () => {
    strictEqual(mayInsert({ status: 'unavailable' }, 'anything'), true)
  })

  it('pre-selects the first insertable row, never one the button would refuse', () => {
    strictEqual(firstInsertable(['t', 'c', 'b'], checked), 'b')
    strictEqual(firstInsertable(['t', 'u'], checked), null)
    strictEqual(firstInsertable(['t', 'u'], { status: 'checking' }), null)
    strictEqual(firstInsertable(['t', 'u'], { status: 'unavailable' }), 't')
  })
})
