// Settings → Checking and Citations (2026-10-16, the extension's mirrored on
// the desktop): the defaults, reading them from storage, and the citation
// decisions they drive — which style a document is cited in, which sources
// are offered, and how an access date reads. A leaf, free of imports but
// types, so the test runner can load it and main, the renderer and the
// web bridge can share it.
import type { CheckingCitationSettings, CitationStyle, Source, WorksCitedHeadingChoice } from './types'

/** The app as it was before these settings: all kinds shown, balanced, the default style, the style's heading, links in, no access dates, every source. */
export const CHECKING_CITATION_DEFAULTS: CheckingCitationSettings = {
  showEvidenceKinds: true,
  showCitationKinds: true,
  checkingStrictness: 'balanced',
  matchDocumentStyle: false,
  worksCitedHeading: '',
  citationLinks: true,
  citationAccessDates: false,
  citableOnlySources: false,
  avoidSourceSites: []
}

const HEADINGS: readonly WorksCitedHeadingChoice[] = ['', 'Works Cited', 'References', 'Bibliography']

/** settingsRepo's strings, each read safely: anything unknown is its default. */
export function checkingCitationsFrom(raw: Record<string, string | undefined>): CheckingCitationSettings {
  const strict = raw.checkingStrictness
  const heading = raw.worksCitedHeading as WorksCitedHeadingChoice
  return {
    showEvidenceKinds: raw.showEvidenceKinds !== 'false',
    showCitationKinds: raw.showCitationKinds !== 'false',
    checkingStrictness: strict === 'clear' || strict === 'thorough' ? strict : 'balanced',
    matchDocumentStyle: raw.matchDocumentStyle === 'true',
    worksCitedHeading: HEADINGS.includes(heading) ? heading : '',
    citationLinks: raw.citationLinks !== 'false',
    citationAccessDates: raw.citationAccessDates === 'true',
    citableOnlySources: raw.citableOnlySources === 'true',
    avoidSourceSites: (raw.avoidSourceSites ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
}

/** The group out of a larger object (the web bridge's stored extras). */
export function checkingCitationsOf(o: CheckingCitationSettings): CheckingCitationSettings {
  return {
    showEvidenceKinds: o.showEvidenceKinds,
    showCitationKinds: o.showCitationKinds,
    checkingStrictness: o.checkingStrictness,
    matchDocumentStyle: o.matchDocumentStyle,
    worksCitedHeading: o.worksCitedHeading,
    citationLinks: o.citationLinks,
    citationAccessDates: o.citationAccessDates,
    citableOnlySources: o.citableOnlySources,
    avoidSourceSites: o.avoidSourceSites
  }
}

/** Only the group's fields a settings patch actually names. */
export function definedCheckingCitations(req: Partial<CheckingCitationSettings>): Partial<CheckingCitationSettings> {
  const out: Partial<CheckingCitationSettings> = {}
  for (const [k, v] of Object.entries(checkingCitationsOf({ ...CHECKING_CITATION_DEFAULTS, ...req }))) {
    if ((req as Record<string, unknown>)[k] !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

// ── Citations → which sources are offered ───────────────────────────────

/**
 * A site as it is compared: the host, lower case, without "www." —
 * "https://www.Example.org/page" is example.org. Null when it isn't one.
 * (The extension's options.js siteOf.)
 */
export function siteOf(input: string): string | null {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return null
  let host: string
  try {
    host = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname
  } catch {
    return null
  }
  host = host.replace(/^www\./, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null
}

/**
 * Whether a source may be offered to cite (the extension's sourceAllowed):
 * never one on a site the writer listed, or any part of it; with "Only
 * sources teachers usually accept", only the citable tiers. `citable` is
 * sourceCredibility.credibilityOf's verdict, passed in so this stays a leaf.
 * sourceCredibility.ts ranks and labels the rest and never drops them on its
 * own; leaving them out is the writer's choice here.
 */
export function sourceAllowed(source: Pick<Source, 'url' | 'doi'>, citable: boolean, prefs: Pick<CheckingCitationSettings, 'citableOnlySources' | 'avoidSourceSites'>): boolean {
  const host = source.url ? siteOf(source.url) : null
  if (host && prefs.avoidSourceSites.some((d) => host === d || host.endsWith(`.${d}`))) return false
  return !prefs.citableOnlySources || citable
}

// ── Citations → links and access dates ──────────────────────────────────

/**
 * What an access date is for: a page, which can change after it is read. A
 * web result, a Wikipedia article, or anything with an address and no DOI
 * that is not an article, a book or a chapter. A journal article or a book is
 * dated by its own year, in every style.
 */
export function isWebPage(source: Pick<Source, 'provider' | 'doi' | 'url' | 'venueType'>): boolean {
  if (source.provider === 'web' || source.provider === 'wikipedia') return Boolean(source.url)
  return !source.doi && Boolean(source.url) && (source.venueType === null || source.venueType === 'other' || source.venueType === 'reference')
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']

/**
 * The day a web page was read, in each style's words (the extension's
 * citeEntryEnd): MLA "Accessed 16 Oct. 2026." at the end; APA "Retrieved
 * October 16, 2026, from" before the address (and only with one); Chicago
 * "Accessed October 16, 2026." before the address.
 */
export function accessedPhrase(style: CitationStyle, when: Date): string {
  const d = when.getDate(), m = when.getMonth(), y = when.getFullYear()
  if (style === 'MLA') return `Accessed ${d} ${MLA_MONTHS[m]} ${y}.`
  if (style === 'APA') return `Retrieved ${MONTHS[m]} ${d}, ${y}, from`
  return `Accessed ${MONTHS[m]} ${d}, ${y}.`
}

// ── Citations → match each document's style ─────────────────────────────

const HEADING_LINE = /^\s*(works cited|references|bibliography)\s*:?\s*$/i

/**
 * The style a document already cites in, or null — a port of the
 * extension's docCitationStyle (content.js): its own in-text citations, with
 * (Lee, 2019) APA, (Lee 45) MLA, (Lee 2019, 45) and footnote marks Chicago,
 * and its list's heading worth three. Two or more, and one clear winner, or
 * nothing. Only the body before the list is counted.
 */
export function documentCitationStyle(text: string): CitationStyle | null {
  const t = String(text ?? '')
  const lines = t.split('\n')
  let headAt = -1
  let heading = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(HEADING_LINE)
    if (m) {
      headAt = i
      heading = m[1].toLowerCase()
      break
    }
  }
  const body = headAt >= 0 ? lines.slice(0, headAt).join('\n') : t
  const count = (re: RegExp): number => (body.match(re) ?? []).length
  let apa =
    count(/\([^()\n]*\b[\p{Lu}][\p{L}'’-]+(?: et al\.)?(?: (?:&|and) [\p{Lu}][\p{L}'’-]+)?, (?:1[5-9]|20)\d\d[a-z]?(?:, (?:pp?\.|para\.) ?\d+(?:[-–]\d+)?)?\)/gu) +
    count(/\b[\p{Lu}][\p{L}'’-]+(?: et al\.)? \((?:1[5-9]|20)\d\d[a-z]?\)/gu)
  let mla = count(/\([\p{Lu}][\p{L}'’-]+(?: (?:and|&) [\p{Lu}][\p{L}'’-]+| et al\.)? (?!(?:1[5-9]|20)\d\d\b)\d{1,4}(?:[-–]\d{1,4})?\)/gu)
  let chicago =
    count(/\([\p{Lu}][\p{L}'’-]+(?: et al\.)? (?:1[5-9]|20)\d\d(?:, \d{1,4}(?:[-–]\d+)?)?\)/gu) + count(/[.!?,]["”’]?[¹²³⁴⁵⁶⁷⁸⁹]/g)
  if (heading === 'works cited') mla += 3
  else if (heading === 'references') apa += 3
  else if (heading === 'bibliography') chicago += 3
  const best = Math.max(apa, mla, chicago)
  if (best < 2) return null
  const tops = ([['APA', apa], ['MLA', mla], ['Chicago', chicago]] as const).filter(([, k]) => k === best)
  return tops.length === 1 ? tops[0][0] : null
}

/** The style a citation is written in: the document's own when Settings says to match and it shows one, else the default. */
export function styleForDocument(text: string | null, prefs: { matchDocumentStyle: boolean; defaultCitationStyle: CitationStyle }): CitationStyle {
  if (prefs.matchDocumentStyle && text) return documentCitationStyle(text) ?? prefs.defaultCitationStyle
  return prefs.defaultCitationStyle
}
