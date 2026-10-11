import { queryOne, run } from './db'

const DEFAULTS: Record<string, string> = {
  defaultCitationStyle: 'APA',
  hotkeyAccelerator: 'CommandOrControl+Shift+F',
  // Contact address sent to Crossref as `mailto`, which routes identified
  // callers into its polite pool and throttles anonymous traffic. Crossref
  // only — OpenAlex removed the parameter when it replaced the polite pool
  // with a metered budget, so sending it there is dead weight.
  //
  // A real default rather than '' because nothing ever set it: there is no
  // Settings field for it, so every install ran anonymous against Crossref.
  // Read through politePoolMailto(), not getSetting(), so a stored blank
  // cannot shadow it.
  crossrefMailto: 'info@jointracely.com',
  enableStrengthSummaries: 'false',
  screenWatchEnabled: 'false',
  theme: 'dark',
  accentColor: 'orange',
  density: 'comfortable',
  fontSize: 'medium',
  claimSensitivity: '0.55',
  screenWatchHotkeyAccelerator: 'CommandOrControl+Shift+S',
  // Process image names (e.g. "Discord.exe") Screen Watch IS allowed to
  // read text from — opt-in allowlist, not an opt-out blocklist: nothing
  // works anywhere until the user explicitly picks apps in Settings >
  // Preferences. Comma-separated, case-insensitive. Empty means nothing is
  // enabled yet.
  screenWatchAllowedApps: '',
  // The "Do not show anymore" checkbox on the Save changes dialog (Figma
  // 212:65). Off by default so the dialog appears until the user opts out of
  // it — a confirm nobody can turn off is one they learn to click through
  // without reading, which is worse than not having it.
  suppressSaveConfirm: 'false',
  // Year 12 — the level GRADE_BANDS was written against, so an install that
  // never opens this setting grades exactly as it did before it existed.
  gradingLevel: '12',
  // ON by default, and that is a deliberate departure from how Screen Watch
  // treats the same call. The difference is consent: Screen Watch reads
  // whatever is on screen forever without being asked, so an unprompted paid
  // call there is a bill the user cannot watch being run up. This fires only
  // inside a document the user opened, on claims they themselves attached a
  // source to, capped per analysis, and cached on the claim text so re-opening
  // costs nothing. Off by default would mean the citation check that makes the
  // report honest is one almost nobody ever turns on.
  autoCritiqueCited: 'true',
  // How much model the user WANTS behind a check, critique or grade — a
  // request, not a grant. services/ai/modelTier.ts clamps it to whatever the
  // signed-in plan allows on every call, so the top tier as a default means
  // "as thorough as this account is entitled to" rather than "always the
  // expensive model": a free account resolves it to `fast` and never leaves it.
  // Anyone who wants quicker answers than they pay for can still choose down.
  modelTier: 'thorough',
  // Tracer Voice. Which persona answers (an id from shared/voices.ts, read
  // through voiceById so a row naming a persona this build lacks reads as the
  // default), whether live captions show, whether a call's transcript is added
  // to the Tracer chat afterwards, and whether the user has accepted the
  // first-use disclosure. Consent starts false on purpose: the sheet that says
  // the microphone and the draft go to OpenAI has to be seen once before any
  // call can start.
  voiceId: 'linden',
  voiceCaptions: 'true',
  voiceSaveTranscript: 'true',
  voiceConsent: 'false',
  // Names Tracely taught the spellchecker for the open document, as JSON.
  // Bookkeeping, not a preference: it exists so a crash cannot make
  // session-scoped name learning permanent. Read and cleared at startup — see
  // recoverLearnedNames in spellcheck.ts.
  learnedNamesForCleanup: '[]'
}

export function getSetting(key: string): string {
  const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = $key', { $key: key })
  if (row) return row.value
  return DEFAULTS[key] ?? ''
}

/**
 * The address sent to OpenAlex and Crossref to stay in their polite pools.
 *
 * Deliberately not a plain getSetting call. A stored value wins over DEFAULTS,
 * so any install that ever wrote a blank here — and the old default WAS blank —
 * would keep sending anonymous requests forever, silently, no matter what this
 * file says. That is the same shape as the config.json bug that made an .env
 * API key unreadable on every machine that had run the app once.
 *
 * The guard is scoped to this one key rather than applied inside getSetting,
 * because blank is a meaningful value elsewhere: an empty
 * screenWatchAllowedApps means "no apps enabled", and an empty
 * hotkeyAccelerator would be a user disabling their hotkey. Falling back to a
 * default there would override a real choice.
 */
export function politePoolMailto(): string {
  return getSetting('crossrefMailto').trim() || DEFAULTS.crossrefMailto
}

export function setSetting(key: string, value: string): void {
  run('INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = $value', {
    $key: key,
    $value: value
  })
}

export function getAllSettingsRaw(): Record<string, string> {
  const result: Record<string, string> = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    result[key] = getSetting(key)
  }
  return result
}
