import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import { REFERENCE_LEVEL, isGradeLevel } from '@shared/gradeLevel'
import { MODEL_TIERS, isModelTier, normalizeModelTier } from '@shared/plan'
import type { SettingsScanInstalledAppsResponse, SettingsSetResponse } from '@shared/ipc-contract'
import type { AccentColor, AppSettings, CitationStyle, Density, FontSize, Theme } from '@shared/types'
import { scanInstalledApps } from '../services/appScan'
import { registerGlobalHotkey, registerScreenWatchHotkey } from '../hotkey'
import { getAllSettingsRaw, setSetting } from '../services/storage/settingsRepo'
import { applyMainWindowFontSize } from '../windows/mainWindow'

const setSchema = z.object({
  defaultCitationStyle: z.enum(['APA', 'MLA', 'Chicago']).optional(),
  hotkeyAccelerator: z.string().optional(),
  enableStrengthSummaries: z.boolean().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accentColor: z.enum(['orange', 'blue', 'green', 'purple']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  fontSize: z.enum(['small', 'medium', 'large']).optional(),
  claimSensitivity: z.number().min(0).max(1).optional(),
  screenWatchHotkeyAccelerator: z.string().optional(),
  screenWatchAllowedApps: z.string().optional(),
  suppressSaveConfirm: z.boolean().optional(),
  gradingLevel: z.number().int().min(3).max(12).optional(),
  autoCritiqueCited: z.boolean().optional(),
  modelTier: z.enum(MODEL_TIERS).optional()
})

function buildSettings(): AppSettings {
  const raw = getAllSettingsRaw()
  return {
    defaultCitationStyle: raw.defaultCitationStyle as CitationStyle,
    hotkeyAccelerator: raw.hotkeyAccelerator,
    enableStrengthSummaries: raw.enableStrengthSummaries === 'true',
    theme: raw.theme as Theme,
    accentColor: raw.accentColor as AccentColor,
    density: raw.density as Density,
    fontSize: raw.fontSize as FontSize,
    claimSensitivity: Number(raw.claimSensitivity),
    screenWatchHotkeyAccelerator: raw.screenWatchHotkeyAccelerator,
    screenWatchAllowedApps: raw.screenWatchAllowedApps,
    suppressSaveConfirm: raw.suppressSaveConfirm === 'true',
    // Number(), then the shared guard on the way out: a row written by a hand
    // edit or a future build must not reach the bands as NaN.
    gradingLevel: isGradeLevel(Number(raw.gradingLevel)) ? Number(raw.gradingLevel) : REFERENCE_LEVEL,
    autoCritiqueCited: raw.autoCritiqueCited === 'true',
    // The stored REQUEST, not the tier a call ends up running at — that is
    // resolved against the plan in services/ai/modelTier.ts. Guarded on the way
    // out the same way gradingLevel is, so a row from a future build cannot
    // reach the renderer as a tier it has no label for. A row an earlier build
    // wrote as 'balanced' (the retired middle tier) reads as 'fast', the tier
    // it now means — not as the 'thorough' default.
    modelTier: storedModelTier(raw.modelTier)
  }
}

function storedModelTier(raw: unknown): AppSettings['modelTier'] {
  const tier = normalizeModelTier(raw)
  return isModelTier(tier) ? tier : 'thorough'
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): AppSettings => buildSettings())

  ipcMain.handle(IPC.SETTINGS_SET, (_event, raw): SettingsSetResponse => {
    const patch = setSchema.parse(raw)

    if (patch.defaultCitationStyle !== undefined) setSetting('defaultCitationStyle', patch.defaultCitationStyle)
    if (patch.enableStrengthSummaries !== undefined) {
      setSetting('enableStrengthSummaries', String(patch.enableStrengthSummaries))
    }
    if (patch.theme !== undefined) setSetting('theme', patch.theme)
    if (patch.accentColor !== undefined) setSetting('accentColor', patch.accentColor)
    if (patch.density !== undefined) setSetting('density', patch.density)
    if (patch.fontSize !== undefined) {
      setSetting('fontSize', patch.fontSize)
      // The renderer applies this as CSS `zoom`, so the window has to grow or
      // shrink with it — otherwise `large` renders 12% past the window edge and
      // is clipped, and `small` leaves a transparent strip.
      applyMainWindowFontSize(patch.fontSize)
    }
    if (patch.claimSensitivity !== undefined) setSetting('claimSensitivity', String(patch.claimSensitivity))
    if (patch.suppressSaveConfirm !== undefined) {
      setSetting('suppressSaveConfirm', String(patch.suppressSaveConfirm))
    }
    if (patch.gradingLevel !== undefined) setSetting('gradingLevel', String(patch.gradingLevel))
    if (patch.autoCritiqueCited !== undefined)
      setSetting('autoCritiqueCited', String(patch.autoCritiqueCited))
    // Stored as asked for, even when the current plan cannot reach it: a Pro
    // subscriber who lets it lapse and renews should find their choice intact,
    // and the clamp that makes that safe runs on every call rather than here.
    if (patch.modelTier !== undefined) setSetting('modelTier', patch.modelTier)
    // Persist only if the OS actually gave us the shortcut. globalShortcut
    // .register returns false when the accelerator is malformed or already
    // claimed by another app — and the return value was previously ignored, so
    // a taken combination was saved, silently never fired, and looked like the
    // hotkey feature was broken. Rejecting it leaves the old accelerator in
    // place, and the renderer sees its requested value missing from the
    // response and can say so.
    if (patch.hotkeyAccelerator !== undefined) {
      if (registerGlobalHotkey(patch.hotkeyAccelerator)) {
        setSetting('hotkeyAccelerator', patch.hotkeyAccelerator)
      } else {
        // Put the working one back — register() unregistered it first.
        registerGlobalHotkey(getAllSettingsRaw().hotkeyAccelerator)
      }
    }
    if (patch.screenWatchHotkeyAccelerator !== undefined) {
      if (registerScreenWatchHotkey(patch.screenWatchHotkeyAccelerator)) {
        setSetting('screenWatchHotkeyAccelerator', patch.screenWatchHotkeyAccelerator)
      } else {
        registerScreenWatchHotkey(getAllSettingsRaw().screenWatchHotkeyAccelerator)
      }
    }
    if (patch.screenWatchAllowedApps !== undefined) {
      setSetting('screenWatchAllowedApps', patch.screenWatchAllowedApps)
    }

    return buildSettings()
  })

  ipcMain.handle(IPC.SETTINGS_SCAN_INSTALLED_APPS, async (): Promise<SettingsScanInstalledAppsResponse> => {
    const found = await scanInstalledApps()
    return { found }
  })
}
