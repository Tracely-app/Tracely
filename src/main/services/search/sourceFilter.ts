import type { VenueType } from '@shared/types'
import { credibilityOf } from '@shared/sourceCredibility'
import { checkingCitationsFrom, sourceAllowed } from '@shared/citationPrefs'
import { getAllSettingsRaw } from '../storage/settingsRepo'

type Offerable = { url: string | null; doi: string | null; venue: string | null; venueType: VenueType | null }

/**
 * Settings → Citations → Sources Tracely suggests (2026-10-16, the
 * extension's mirrored): which of a search's sources may be OFFERED to cite —
 * never one on a site the writer listed, and with "Only sources teachers
 * usually accept", only the citable tiers. Read live, so a change applies to
 * the next list. Applied where the lists people pick from are served
 * (evidenceHandlers' find, get-for-claim and for-text; Screen Watch's
 * findSourceForClaim), never to what the score or the critique reads: the
 * strength score still counts what the search found.
 */
export function offeredSourceFilter(): (source: Offerable) => boolean {
  const prefs = checkingCitationsFrom(getAllSettingsRaw())
  if (!prefs.citableOnlySources && prefs.avoidSourceSites.length === 0) return () => true
  return (s) =>
    sourceAllowed(s, credibilityOf({ url: s.url, venue: s.venue, venueType: s.venueType, doi: s.doi }).citable, prefs)
}
