import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC } from '@shared/ipc-channels'
import { z } from 'zod'
import type { DataExportResponse, MemoryClearResponse, MemoryInfo } from '@shared/ipc-contract'
import type { AppSettings } from '@shared/types'
import { exportFileName, EXPORT_SETTINGS_LEAVE_OUT } from '@shared/settingsHelp'
import { clearDocumentPrefs, countDocumentPrefs, getDocument, listDocuments } from '../services/storage/documentsRepo'
import { clearSavedChecks, clearTracerChats, memoryCounts } from '../services/storage/db'
import { currentSettings, resetSettingsToDefaults } from './settingsHandlers'
import { listLibrary } from '../services/storage/libraryRepo'
import { listCitationsForSource } from '../services/storage/citationsRepo'
import { getAllSettingsRaw } from '../services/storage/settingsRepo'

/**
 * Settings → Privacy and data → Export my data (2026-10-16, the extension's
 * Settings mirrored). Everything the person wrote or saved on this machine,
 * as one JSON file where they choose: the documents, the library with its
 * citations, and the settings. Not the avatar image, the analysis cache or
 * the session file — those are the app's working files, not theirs to take
 * anywhere. Nothing leaves the machine; the save dialog is the only door.
 */
export function registerDataHandlers(): void {
  ipcMain.handle(IPC.DATA_EXPORT, async (event): Promise<DataExportResponse> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const now = new Date()
    const options = {
      title: 'Export my Tracely data',
      defaultPath: exportFileName(now),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true }
    try {
      const settings: Record<string, string> = getAllSettingsRaw()
      for (const key of EXPORT_SETTINGS_LEAVE_OUT) delete settings[key]
      const data = {
        exportedAt: now.toISOString(),
        app: { name: 'Tracely', version: app.getVersion() },
        documents: listDocuments()
          .map((d) => getDocument(d.id))
          .filter((d) => d !== null),
        library: listLibrary().map((item) => ({ ...item, citations: listCitationsForSource(item.sourceId) })),
        settings
      }
      await writeFile(choice.filePath, JSON.stringify(data, null, 2), 'utf8')
      return { ok: true, path: choice.filePath }
    } catch (err) {
      return { ok: false, canceled: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Settings → Memory (2026-10-17, the extension's mirrored): each part
  // counted, and cleared on its own. Privacy's Clear analysis history and
  // Delete everything stay as the one-press versions.
  ipcMain.handle(IPC.DATA_MEMORY, (): MemoryInfo => memoryInfo())

  ipcMain.handle(IPC.DATA_MEMORY_CLEAR, (_event, raw): MemoryClearResponse => {
    const { part } = memoryClearSchema.parse(raw)
    let settings: AppSettings | null = null
    if (part === 'checks') clearSavedChecks()
    else if (part === 'tracer') clearTracerChats()
    else if (part === 'documentSettings') clearDocumentPrefs()
    else settings = resetSettingsToDefaults()
    return { memory: memoryInfo(), settings: settings ?? currentSettings() }
  })
}

const memoryClearSchema = z.object({ part: z.enum(['checks', 'tracer', 'documentSettings', 'settings']) })

function memoryInfo(): MemoryInfo {
  return { ...memoryCounts(), documentSettings: countDocumentPrefs() }
}
