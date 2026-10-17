import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type {
  DocumentsGetResponse,
  DocumentsLatestResponse,
  DocumentsListResponse,
  DocumentsForgetGradeResponse,
  DocumentsRemoveResponse,
  DocumentsSaveResponse,
  DocumentsSetPrefsResponse
} from '@shared/ipc-contract'
import {
  forgetDocumentGrade,
  getDocument,
  getLatestDocument,
  listDocuments,
  removeDocument,
  saveDocument,
  setDocumentPrefs
} from '../services/storage/documentsRepo'

const idSchema = z.object({ id: z.string().min(1) })

// Bounded so a runaway paste cannot write an unbounded blob into a database
// that is fully re-serialized on every write. Roughly a 100-page document.
const MAX_BODY_CHARS = 400_000
const MAX_TITLE_CHARS = 200

const prefsSchema = z.object({
  id: z.string().min(1),
  citationStyle: z.enum(['APA', 'MLA', 'Chicago']).nullable().optional(),
  neverCheck: z.boolean().optional()
})

const saveSchema = z.object({
  id: z.string().min(1).nullish(),
  title: z.string().max(MAX_TITLE_CHARS),
  bodyHtml: z.string().max(MAX_BODY_CHARS)
})

export function registerDocumentsHandlers(): void {
  ipcMain.handle(IPC.DOCUMENTS_LIST, (): DocumentsListResponse => ({ documents: listDocuments() }))

  ipcMain.handle(IPC.DOCUMENTS_GET, (_event, raw): DocumentsGetResponse => {
    const { id } = idSchema.parse(raw)
    return { document: getDocument(id) }
  })

  ipcMain.handle(IPC.DOCUMENTS_LATEST, (): DocumentsLatestResponse => ({
    document: getLatestDocument()
  }))

  ipcMain.handle(IPC.DOCUMENTS_SAVE, (_event, raw): DocumentsSaveResponse => {
    const input = saveSchema.parse(raw)
    return {
      document: saveDocument({
        id: input.id ?? null,
        // A document with no name is normal — it is named after it exists, not
        // before — so give it one rather than rejecting the save.
        title: input.title.trim() || 'Untitled document',
        bodyHtml: input.bodyHtml
      })
    }
  })

  ipcMain.handle(IPC.DOCUMENTS_REMOVE, (_event, raw): DocumentsRemoveResponse => {
    const { id } = idSchema.parse(raw)
    removeDocument(id)
    return { ok: true }
  })

  // Settings → Documents (2026-10-17): its own citation style and "Never check
  // this document". The editor reads them when it opens the document.
  ipcMain.handle(IPC.DOCUMENTS_SET_PREFS, (_event, raw): DocumentsSetPrefsResponse => {
    const { id, ...patch } = prefsSchema.parse(raw)
    return { document: setDocumentPrefs(id, patch) }
  })

  ipcMain.handle(IPC.DOCUMENTS_FORGET_GRADE, (_event, raw): DocumentsForgetGradeResponse => {
    const { id } = idSchema.parse(raw)
    forgetDocumentGrade(id)
    return { ok: true }
  })
}
