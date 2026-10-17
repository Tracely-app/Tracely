// citationPrefs.ts: Settings → Citations on the desktop (2026-10-16, the
// extension's mirrored).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKING_CITATION_DEFAULTS,
  accessedPhrase,
  checkingCitationsFrom,
  definedCheckingCitations,
  documentCitationStyle,
  isWebPage,
  siteOf,
  sourceAllowed,
  styleForDocument
} from './citationPrefs.ts'

test('stored strings read safely, and every default is the app as it was', () => {
  assert.deepEqual(checkingCitationsFrom({}), CHECKING_CITATION_DEFAULTS)
  const s = checkingCitationsFrom({
    matchDocumentStyle: 'true', worksCitedHeading: 'Bibliography', citationLinks: 'false', citationAccessDates: 'true',
    citableOnlySources: 'true', avoidSourceSites: 'wikipedia.org, ,example.com', checkingStrictness: 'clear'
  })
  assert.equal(s.matchDocumentStyle, true)
  assert.equal(s.worksCitedHeading, 'Bibliography')
  assert.equal(s.citationLinks, false)
  assert.deepEqual(s.avoidSourceSites, ['wikipedia.org', 'example.com'])
  assert.equal(checkingCitationsFrom({ worksCitedHeading: 'Sources I liked' }).worksCitedHeading, '', 'only the three headings')
  assert.deepEqual(definedCheckingCitations({ citationLinks: false }), { citationLinks: false }, 'a patch names only what it changes')
})

test('the document style: its own citations and its list heading, or nothing', () => {
  const apa = 'Sleep falls with screen time (Hale & Guan, 2015). Teens need nine hours (Owens, 2014).\nReferences\nHale, L. (2015). Screen time.'
  assert.equal(documentCitationStyle(apa), 'APA')
  assert.equal(documentCitationStyle('Gatsby reaches for the light (Fitzgerald 21). Nick doubts him (Fitzgerald 98).\nWorks Cited\nFitzgerald, F. Scott. The Great Gatsby.'), 'MLA')
  assert.equal(documentCitationStyle('Trade grew.¹ Cities followed.²\nBibliography\nAllsen, Thomas. Culture and Conquest. 2001.'), 'Chicago')
  assert.equal(documentCitationStyle('An essay with no citations at all.'), null)
  assert.equal(styleForDocument(apa, { matchDocumentStyle: false, defaultCitationStyle: 'MLA' }), 'MLA', 'matching off: the default')
  assert.equal(styleForDocument(apa, { matchDocumentStyle: true, defaultCitationStyle: 'MLA' }), 'APA')
  assert.equal(styleForDocument('No citations.', { matchDocumentStyle: true, defaultCitationStyle: 'Chicago' }), 'Chicago', 'nothing to go on: the default')
})

test('which sources are offered: never a listed site or any part of it; citable only when asked', () => {
  const wiki = { url: 'https://en.wikipedia.org/wiki/Sleep', doi: null }
  const cdc = { url: 'https://www.cdc.gov/sleep', doi: null }
  const off = { citableOnlySources: false, avoidSourceSites: [] as string[] }
  assert.equal(sourceAllowed(wiki, false, off), true, 'nothing left out by default')
  assert.equal(sourceAllowed(wiki, false, { ...off, avoidSourceSites: ['wikipedia.org'] }), false)
  assert.equal(sourceAllowed(cdc, true, { ...off, avoidSourceSites: ['wikipedia.org'] }), true)
  assert.equal(sourceAllowed(wiki, false, { ...off, citableOnlySources: true }), false)
  assert.equal(sourceAllowed(cdc, true, { ...off, citableOnlySources: true }), true)
  assert.equal(siteOf('https://www.Wikipedia.org/wiki/X'), 'wikipedia.org')
  assert.equal(siteOf('not a site'), null)
})

test('an access date is for a web page only, in each style\'s words', () => {
  const day = new Date(2026, 9, 16)
  assert.equal(accessedPhrase('MLA', day), 'Accessed 16 Oct. 2026.')
  assert.equal(accessedPhrase('APA', day), 'Retrieved October 16, 2026, from')
  assert.equal(accessedPhrase('Chicago', day), 'Accessed October 16, 2026.')
  assert.equal(isWebPage({ provider: 'web', doi: null, url: 'https://example.org/a', venueType: 'other' }), true)
  assert.equal(isWebPage({ provider: 'wikipedia', doi: null, url: 'https://en.wikipedia.org/wiki/X', venueType: 'reference' }), true)
  assert.equal(isWebPage({ provider: 'openalex', doi: '10.1/x', url: 'https://doi.org/10.1/x', venueType: 'journal' }), false, 'an article is dated by its year')
  assert.equal(isWebPage({ provider: 'openalex', doi: null, url: null, venueType: 'book' }), false)
})
