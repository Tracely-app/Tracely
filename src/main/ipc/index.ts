import { registerAnalyzeHandlers } from './analyzeHandlers'
import { registerAuthHandlers } from './authHandlers'
import { registerCitationHandlers } from './citationHandlers'
import { registerClipboardHandlers } from './clipboardHandlers'
import { registerCritiqueHandlers } from './critiqueHandlers'
import { registerDataHandlers } from './dataHandlers'
import { registerEvidenceHandlers } from './evidenceHandlers'
import { registerSourcesHandlers } from './sourcesHandlers'
import { registerHistoryHandlers } from './historyHandlers'
import { registerDocumentsHandlers } from './documentsHandlers'
import { registerLibraryHandlers } from './libraryHandlers'
import { registerProfileHandlers } from './profileHandlers'
import { registerScreenWatchHandlers } from './screenWatchHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerStructureHandlers } from './structureHandlers'
import { registerTracerHandlers } from './tracerHandlers'
import { registerWindowHandlers } from './windowHandlers'

export function registerIpcHandlers(): void {
  registerAnalyzeHandlers()
  registerClipboardHandlers()
  registerWindowHandlers()
  registerSettingsHandlers()
  registerHistoryHandlers()
  registerEvidenceHandlers()
  registerSourcesHandlers()
  registerCritiqueHandlers()
  registerCitationHandlers()
  registerDocumentsHandlers()
  registerDataHandlers() // Settings → Privacy and data → Export my data
  registerStructureHandlers()
  registerTracerHandlers()
  registerLibraryHandlers()
  registerScreenWatchHandlers()
  registerProfileHandlers()
  registerAuthHandlers()
}
