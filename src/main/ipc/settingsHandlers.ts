import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import { GRADE_LEVELS, MIN_GRADE_LEVEL, storedGradeLevel } from '@shared/gradeLevel'
import { MODEL_TIERS, isModelTier, normalizeModelTier } from '@shared/plan'
import type { SettingsScanInstalledAppsResponse, SettingsSetResponse } from '@shared/ipc-contract'
import type { AccentColor, AppSettings, CitationStyle, Density, FontSize, Theme } from '@shared/types'
import { scanInstalledApps } from '../services/appScan'
import { registerGlobalHotkey, registerScreenWatchHotkey } from '../hotkey'
import { getAllSettingsRaw, setSetting, settingDefaults } from '../services/storage/settingsRepo'
import { applyMainWindowFontSize } from '../windows/mainWindow'
import { checkingCitationsFrom, siteOf } from '@shared/citationPrefs'
import { NEVER_FLAG_MAX, neverFlagList, withNeverFlag } from '@shared/neverFlag'

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
  gradingLevel: z.number().int().min(MIN_GRADE_LEVEL).max(GRADE_LEVELS[GRADE_LEVELS.length - 1]).optional(),
  autoCritiqueCited: z.boolean().optional(),
  modelTier: z.enum(MODEL_TIERS).optional(),
  showEvidenceKinds: z.boolean().optional(),
  showCitationKinds: z.boolean().optional(),
  checkingStrictness: z.enum(['clear', 'balanced', 'thorough']).optional(),
  matchDocumentStyle: z.boolean().optional(),
  worksCitedHeading: z.enum(['', 'Works Cited', 'References', 'Bibliography']).optional(),
  citationLinks: z.boolean().optional(),
  citationAccessDates: z.boolean().optional(),
  citableOnlySources: z.boolean().optional(),
  avoidSourceSites: z.array(z.string().max(253)).max(200).optional(),
  neverFlagSentences: z.array(z.string().max(2000)).max(NEVER_FLAG_MAX).optional(),
  neverFlagAdd: z.string().max(2000).optional()
})

function buildSettings(raw: Record<string, string> = getAllSettingsRaw()): AppSettings {
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
    // edit or a future build must not reach the bands as NaN, and a grade 3-6
    // row from before the floor moved reads as grade 7 (storedGradeLevel).
    gradingLevel: storedGradeLevel(Number(raw.gradingLevel)),
    autoCritiqueCited: raw.autoCritiqueCited === 'true',
    // The stored REQUEST, not the tier a call ends up running at — that is
    // resolved against the plan in services/ai/modelTier.ts. Guarded on the way
    // out the same way gradingLevel is, so a row from a future build cannot
    // reach the renderer as a tier it has no label for. A row an earlier build
    // wrote as 'balanced' (the retired middle tier) reads as 'fast', the tier
    // it now means — not as the 'thorough' default.
    modelTier: storedModelTier(raw.modelTier),
    ...checkingCitationsFrom(raw),
    neverFlagSentences: neverFlagList(raw.neverFlagSentences)
  }
}

function storedModelTier(raw: unknown): AppSettings['modelTier'] {
  const tier = normalizeModelTier(raw)
  return isModelTier(tier) ? tier : 'thorough'
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS_GET, (): AppSettings => buildSettings())

  ipcMain.handle(IPC.SETTINGS_SET, (_event, raw): SettingsSetResponse => applySettingsPatch(setSchema.parse(raw)))

  ipcMain.handle(IPC.SETTINGS_SCAN_INSTALLED_APPS, async (): Promise<SettingsScanInstalledAppsResponse> => {
    const found = await scanInstalledApps()
    return { found }
  })
}

/**
 * Settings → Memory → Settings: Reset. Every preference on the Settings page
 * back to its default, through the same path a change takes (so the hotkeys
 * are registered again and the window takes its font size). What stays:
 * Screen Watch's apps and whether it is on, the never-flag list (Memory's
 * own part), the profile, and the app's bookkeeping. The extension's Reset
 * keeps the sign-in and the sites the same way.
 */
/** Settings as the renderer reads them (Memory's answer carries them). */
export function currentSettings(): AppSettings {
  return buildSettings()
}

export function resetSettingsToDefaults(): AppSettings {
  const d = buildSettings(settingDefaults())
  const { screenWatchAllowedApps: _apps, neverFlagSentences: _never, ...preferences } = d
  return applySettingsPatch(setSchema.parse(preferences))
}

function applySettingsPatch(patch: z.infer<typeof setSchema>): AppSettings {
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
  // Settings → Checking and Citations: stored as strings, read back by checkingCitationsFrom.
  for (const key of ['showEvidenceKinds', 'showCitationKinds', 'matchDocumentStyle', 'citationLinks', 'citationAccessDates', 'citableOnlySources'] as const) {
    if (patch[key] !== undefined) setSetting(key, String(patch[key]))
  }
  if (patch.checkingStrictness !== undefined) setSetting('checkingStrictness', patch.checkingStrictness)
  if (patch.worksCitedHeading !== undefined) setSetting('worksCitedHeading', patch.worksCitedHeading)
  if (patch.avoidSourceSites !== undefined) {
    setSetting('avoidSourceSites', patch.avoidSourceSites.map(siteOf).filter((s): s is string => s !== null).join(','))
  }
  // "Never flag this": the list replaced (Settings → Memory), or one added (a card). Screen Watch reads it on its next tick.
  if (patch.neverFlagSentences !== undefined) {
    const list = patch.neverFlagSentences.reduce<string[]>((acc, s) => withNeverFlag(acc, s), [])
    setSetting('neverFlagSentences', JSON.stringify(list))
  }
  if (patch.neverFlagAdd !== undefined) {
    const list = withNeverFlag(neverFlagList(getAllSettingsRaw().neverFlagSentences), patch.neverFlagAdd)
    setSetting('neverFlagSentences', JSON.stringify(list))
  }

  return buildSettings()
}
