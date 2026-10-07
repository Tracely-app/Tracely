import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type {
  ScreenWatchCritiqueClaimResponse,
  ScreenWatchFindCitedWorkResponse,
  ScreenWatchFindSourceResponse,
  ScreenWatchGetStatusResponse,
  ScreenWatchInsertCitationResponse,
  ScreenWatchPreviewCitationResponse,
  ScreenWatchRefreshEvidenceResponse,
  ScreenWatchSetActivePopoverRectResponse,
  ScreenWatchSetEnabledResponse,
  ScreenWatchSetWidgetExpandedResponse,
  ScreenWatchSetWidgetViewModeResponse,
  ScreenWatchUndoCitationResponse,
  ScreenWatchWidgetDragEndResponse,
  ScreenWatchWidgetDragStartResponse
} from '@shared/ipc-contract'
import {
  critiqueClaim,
  findCitedWorkForClaim,
  findSourceWithCited,
  getScreenWatchStatus,
  insertCitationForClaim,
  previewCitationForClaim,
  refreshEvidenceForClaim,
  setActivePopoverRect,
  setWidgetDragEnd,
  setWidgetDragStart,
  setWidgetExpanded,
  setWidgetViewMode,
  startScreenWatch,
  stopScreenWatch,
  undoCitationForClaim
} from '../services/screenWatch/screenWatchService'

const setEnabledSchema = z.object({ enabled: z.boolean() })
const setWidgetExpandedSchema = z.object({ expanded: z.boolean() })
const setWidgetViewModeSchema = z.object({ mode: z.enum(['single', 'all', 'structure', 'grade', 'report', 'paragraph']) })
const widgetDragEndSchema = z.object({ x: z.number(), y: z.number() })
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const setActivePopoverRectSchema = z.object({ claimId: z.string().nullable(), rect: rectSchema.nullable() })
const claimIdSchema = z.object({ claimId: z.string() })
const findSourceSchema = z.object({ claimId: z.string(), query: z.string().optional() })
const insertCitationSchema = z.object({
  claimId: z.string(),
  sourceRef: z.string(),
  style: z.enum(['APA', 'MLA', 'Chicago'])
})

export function registerScreenWatchHandlers(): void {
  ipcMain.handle(IPC.SCREENWATCH_SET_ENABLED, (_event, raw): ScreenWatchSetEnabledResponse => {
    const { enabled } = setEnabledSchema.parse(raw)
    if (enabled) startScreenWatch()
    else stopScreenWatch()
    return getScreenWatchStatus()
  })

  ipcMain.handle(IPC.SCREENWATCH_GET_STATUS, (): ScreenWatchGetStatusResponse => {
    return getScreenWatchStatus()
  })

  ipcMain.handle(IPC.SCREENWATCH_SET_WIDGET_EXPANDED, (_event, raw): ScreenWatchSetWidgetExpandedResponse => {
    const { expanded } = setWidgetExpandedSchema.parse(raw)
    setWidgetExpanded(expanded)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCREENWATCH_SET_WIDGET_VIEW_MODE, (_event, raw): ScreenWatchSetWidgetViewModeResponse => {
    const { mode } = setWidgetViewModeSchema.parse(raw)
    setWidgetViewMode(mode)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCREENWATCH_WIDGET_DRAG_START, (): ScreenWatchWidgetDragStartResponse => {
    setWidgetDragStart()
    return { ok: true }
  })

  ipcMain.handle(IPC.SCREENWATCH_WIDGET_DRAG_END, (_event, raw): ScreenWatchWidgetDragEndResponse => {
    const { x, y } = widgetDragEndSchema.parse(raw)
    setWidgetDragEnd({ x, y })
    return { ok: true }
  })

  ipcMain.handle(IPC.SCREENWATCH_SET_ACTIVE_POPOVER_RECT, (_event, raw): ScreenWatchSetActivePopoverRectResponse => {
    const { claimId, rect } = setActivePopoverRectSchema.parse(raw)
    setActivePopoverRect(claimId, rect)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCREENWATCH_REFRESH_EVIDENCE, async (_event, raw): Promise<ScreenWatchRefreshEvidenceResponse> => {
    const { claimId } = claimIdSchema.parse(raw)
    return { evidence: await refreshEvidenceForClaim(claimId) }
  })

  ipcMain.handle(IPC.SCREENWATCH_CRITIQUE_CLAIM, async (_event, raw): Promise<ScreenWatchCritiqueClaimResponse> => {
    const { claimId } = claimIdSchema.parse(raw)
    return await critiqueClaim(claimId)
  })

  ipcMain.handle(IPC.SCREENWATCH_FIND_SOURCE, async (_event, raw): Promise<ScreenWatchFindSourceResponse> => {
    const { claimId, query } = findSourceSchema.parse(raw)
    // Both halves: the sources found, and the source already cited. See
    // ResolvedCitedWork — a card headed "Compare sources" needs two things.
    return await findSourceWithCited(claimId, query)
  })

  // "Find the cited work" from the overlay's card. Free and user-triggered —
  // Crossref and Open Library only, nothing written to the watched app.
  ipcMain.handle(IPC.SCREENWATCH_FIND_CITED_WORK, async (_event, raw): Promise<ScreenWatchFindCitedWorkResponse> => {
    const { claimId } = claimIdSchema.parse(raw)
    return await findCitedWorkForClaim(claimId)
  })

  // Same shape as insert, and the same schema on purpose: previewing what would
  // be written must validate exactly as strictly as writing it.
  ipcMain.handle(IPC.SCREENWATCH_PREVIEW_CITATION, (_event, raw): ScreenWatchPreviewCitationResponse => {
    const { claimId, sourceRef, style } = insertCitationSchema.parse(raw)
    return { citation: previewCitationForClaim(claimId, sourceRef, style) }
  })

  ipcMain.handle(IPC.SCREENWATCH_INSERT_CITATION, async (_event, raw): Promise<ScreenWatchInsertCitationResponse> => {
    const { claimId, sourceRef, style } = insertCitationSchema.parse(raw)
    return { citation: await insertCitationForClaim(claimId, sourceRef, style) }
  })

  ipcMain.handle(IPC.SCREENWATCH_UNDO_CITATION, async (_event, raw): Promise<ScreenWatchUndoCitationResponse> => {
    const { claimId } = claimIdSchema.parse(raw)
    await undoCitationForClaim(claimId)
    return { ok: true }
  })
}
