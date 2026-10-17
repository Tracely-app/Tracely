import type { CitationStyle, Source } from '@shared/types'
import { citationLocator } from '@shared/citationLocator'
import { accessedPhrase, isWebPage } from '@shared/citationPrefs'
import { getSetting } from '../storage/settingsRepo'
import * as apa from './formatters/apa'
import * as chicago from './formatters/chicago'
import * as mla from './formatters/mla'

const FORMATTERS: Record<CitationStyle, (source: Source) => string> = {
  APA: apa.format,
  MLA: mla.format,
  Chicago: chicago.format
}

/**
 * Settings → Citations (2026-10-16, the extension's mirrored), read live:
 * "Links in entries" off writes the entry without its DOI or URL; "Access
 * dates" on adds the day a WEB PAGE was read (isWebPage — never a journal
 * article or a book), where each style puts it: MLA at the end, Chicago
 * before the address, APA as "Retrieved …, from" the address (and only with
 * one). Off and off is the entry exactly as before.
 */
export function formatCitation(source: Source, style: CitationStyle): string {
  const links = getSetting('citationLinks') !== 'false'
  const accessed = getSetting('citationAccessDates') === 'true'
  const locator = citationLocator(source)
  const bare = (): string => FORMATTERS[style]({ ...source, doi: null, url: null })
  if (!accessed || !locator || !isWebPage(source)) return links ? FORMATTERS[style](source) : bare()
  const phrase = accessedPhrase(style, new Date())
  if (style === 'MLA') return `${links ? FORMATTERS.MLA(source) : bare()} ${phrase}`
  if (style === 'APA') return links ? `${bare()} ${phrase} ${locator}` : bare()
  return `${bare()} ${phrase}${links ? ` ${locator}.` : ''}`
}
