import type { VoiceMicStatus } from '@shared/ipc-contract'

/**
 * The OS half of "may Tracely use the microphone", before the renderer calls
 * getUserMedia.
 *
 * macOS gates the mic per app (TCC): until the user answers the system prompt
 * once, getUserMedia from an Electron renderer can fail or hang without ever
 * showing it, so main asks explicitly — askForMediaAccess shows the prompt
 * only when the status is `not-determined`, never again after an answer.
 * The packaged app also needs NSMicrophoneUsageDescription in its Info.plist
 * (electron-builder.yml): without it macOS refuses the request outright, or
 * terminates a hardened-runtime app, instead of showing the prompt.
 * Windows has a per-app privacy toggle Electron can read but not prompt for.
 * Everything else answers `unknown` and getUserMedia's own error is the truth.
 *
 * `prefs` is electron's systemPreferences, injected so this can be tested.
 */
export interface MediaAccessPrefs {
  getMediaAccessStatus(mediaType: 'microphone'): VoiceMicStatus
  askForMediaAccess?(mediaType: 'microphone'): Promise<boolean>
}

export async function resolveMicAccess(platform: string, prefs: MediaAccessPrefs): Promise<VoiceMicStatus> {
  if (platform !== 'darwin' && platform !== 'win32') return 'unknown'
  try {
    const status = prefs.getMediaAccessStatus('microphone')
    if (platform !== 'darwin' || status !== 'not-determined' || !prefs.askForMediaAccess) return status
    return (await prefs.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  } catch {
    // Never a reason to refuse the call: the renderer still tries getUserMedia
    // and reports what actually happens.
    return 'unknown'
  }
}
