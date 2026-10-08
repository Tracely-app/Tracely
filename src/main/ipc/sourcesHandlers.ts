import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type { SourcesFaviconsResponse, SourcesVerifyResponse } from '@shared/ipc-contract'
import { getFaviconDataUrl } from '../services/search/favicon'
import { verifySourceList } from '../services/ai/verifySources'

/**
 * Real site icons for the main window's source rows.
 *
 * The overlay has shown these since favicon.ts was written; the editor never
 * could, because nothing on the persisted `Source` carries an icon and the
 * comment on `sourceInitials` correctly refused to add a fetch to the renderer
 * — index.html's CSP is `img-src 'self' data: file:`, and a renderer-side
 * lookup would have meant loosening it to allow a third-party image host. So
 * every citation row in the app's own window drew the two-letter monogram
 * fallback while the same source in the overlay drew its publisher's mark.
 *
 * Fetching in main keeps that CSP exactly as it is: what crosses the bridge is
 * a `data:` URI, which `img-src ... data:` already permits. It also reuses the
 * one hostname-keyed cache, so a row in the report and the same publisher in
 * the citation picker cost one request between them for the whole session.
 *
 * This does not widen the app's network surface — the same service, for the
 * same reason, already opted into for the overlay (see the header of
 * favicon.ts). It widens which WINDOW benefits from a request that was already
 * being made.
 */

/**
 * How many URLs one call may ask about.
 *
 * A results list is six to eight sources and the report's evidence list is
 * capped well under this, so 40 is generous for every real caller — it is a
 * bound on an unprivileged renderer, not a product limit. Extra URLs are
 * dropped rather than rejected: a partial answer renders monograms for the
 * remainder, which is the same thing a failed lookup does, while a thrown
 * error would take out a list that is otherwise perfectly displayable.
 */
export const MAX_FAVICON_URLS = 40

const schema = z.object({
  // Not `.url()`. These come straight off stored sources, where a malformed or
  // empty URL is ordinary, and rejecting the batch because one row of eight has
  // a bad link would cost the other seven their icons. getFaviconDataUrl
  // already answers null for anything it cannot parse.
  urls: z.array(z.string()).max(500)
})

/**
 * The list a surface is showing, to be checked for receipts. Bounds on an
 * unprivileged renderer, not product limits: a list is five rows, the server
 * checks eight, and every field is clamped again in shared/sourceReceipts.ts
 * before it leaves the machine. Lengths are generous because an abstract is
 * long and a row with a long one must not cost the list its check.
 */
const verifySchema = z.object({
  claimText: z.string().max(20_000),
  sources: z
    .array(
      z.object({
        id: z.string().min(1).max(2_000),
        title: z.string().max(20_000),
        url: z.string().max(20_000).nullable(),
        doi: z.string().max(2_000).nullable(),
        abstract: z.string().max(100_000).nullable(),
        venue: z.string().max(20_000).nullable(),
        year: z.number().int().nullable(),
        provider: z.string().max(100)
      })
    )
    .max(40)
})

export function registerSourcesHandlers(): void {
  /**
   * Receipts for the list being shown — a paid server call, made only because
   * the writer opened that list. The renderer calls this from the citation
   * flow it just opened and from nowhere else; see services/ai/verifySources.ts.
   */
  ipcMain.handle(IPC.SOURCES_VERIFY, async (_event, raw): Promise<SourcesVerifyResponse> => {
    const { claimText, sources } = verifySchema.parse(raw)
    return await verifySourceList(claimText, sources)
  })

  ipcMain.handle(IPC.SOURCES_FAVICONS, async (_event, raw): Promise<SourcesFaviconsResponse> => {
    const { urls } = schema.parse(raw)

    // Deduped before the cap, so a list of eight rows sharing one publisher
    // spends one of the 40 slots rather than eight.
    const unique = [...new Set(urls.filter((url) => url.length > 0))].slice(0, MAX_FAVICON_URLS)

    // In parallel: these are independent network calls behind a 3s timeout, and
    // serialising 40 of them would make a results list take two minutes to
    // finish decorating. getFaviconDataUrl dedupes in-flight requests by
    // hostname itself, so this cannot fan out past the number of distinct
    // domains however the list is shaped.
    const entries = await Promise.all(
      unique.map(async (url) => [url, await getFaviconDataUrl(url)] as const)
    )

    return { icons: Object.fromEntries(entries) }
  })
}
