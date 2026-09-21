import { Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  AccentColor,
  AppSettings,
  CitationStyle,
  Density,
  FontSize,
  Theme
} from '@shared/types'
import type {
  AppGetBuildInfoResponse,
  ProfileInfo,
  ScannedApp,
  ScreenWatchStatus
} from '@shared/ipc-contract'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import ConfirmSheet from '../components/ConfirmSheet'
import SettingsField from '../components/SettingsField'
import SettingsUnavailable from '../components/SettingsUnavailable'
import { Bell, CreditCard, Link2, ShieldCheck } from 'lucide-react'
import {
  UserIcon,
  SunIcon,
  SlidersIcon,
  ShieldIcon,
  BackIcon
} from '../components/icons'
import { tracelyApi } from '../lib/api'
import { useSetGradeLevel } from '../lib/gradeLevel'
import { usePlan } from '../lib/plan'
import { GRADE_LEVELS, gradeLevelLabel } from '@shared/gradeLevel'
import {
  MODEL_TIERS,
  MODEL_TIER_DESCRIPTION,
  MODEL_TIER_LABEL,
  MODEL_TIER_REQUIRES,
  PLAN_INCLUDES,
  PLAN_LABEL,
  PLAN_PRICE,
  UPGRADE_URL,
  modelTierUnlocked,
  resolveModelTier,
  type ModelTier
} from '@shared/plan'
import { applyTheme } from '../lib/theme'
import { applyAccentColor, applyDensity, applyFontSize } from '../lib/appearance'
import type { Tab } from '../App'

const ACCENT_COLORS: { id: AccentColor; label: string; swatch: string }[] = [
  { id: 'orange', label: 'Orange', swatch: 'linear-gradient(135deg, #ffaf01, #ff6a00)' },
  { id: 'blue', label: 'Blue', swatch: 'linear-gradient(135deg, #60a5fa, #3b82f6)' },
  { id: 'green', label: 'Green', swatch: 'linear-gradient(135deg, #4ade80, #22c55e)' },
  { id: 'purple', label: 'Purple', swatch: 'linear-gradient(135deg, #c084fc, #a855f7)' }
]

/**
 * Records the next key chord pressed, as an Electron accelerator string
 * ("Control+Shift+T").
 *
 * A capture field rather than a text input: an accelerator is a syntax most
 * people do not know, and a typo produces a shortcut that silently never fires.
 * The main process refuses to persist one the OS will not grant — already
 * claimed by another app, or malformed — so the displayed value snapping back
 * to the previous chord is how a rejection shows up.
 */
function HotkeyField({
  value,
  onCapture
}: {
  value: string
  onCapture: (accelerator: string) => void
}): JSX.Element {
  const [capturing, setCapturing] = useState(false)

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (!capturing) return
    e.preventDefault()
    if (e.key === 'Escape') {
      setCapturing(false)
      return
    }
    // Modifiers alone are not a shortcut — wait for the real key.
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

    const parts: string[] = []
    if (e.ctrlKey) parts.push('Control')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Super')
    // Electron wants a bare uppercase letter/digit, or a named key.
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
    // A global shortcut with no modifier would swallow that key everywhere.
    if (parts.length < 2) return

    setCapturing(false)
    onCapture(parts.join('+'))
  }

  return (
    <button
      type="button"
      className={`settings-hotkey ${capturing ? 'settings-hotkey-capturing' : ''}`}
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={onKeyDown}
    >
      {capturing ? 'Press a shortcut…' : value}
    </button>
  )
}

// Every section here is real: each control is wired through IPC to settingsRepo
// or profileHandlers, persists, and has a consumer that reads it back.
//
// That is now the standard for this file. Four more sections used to exist —
// Notifications, Security, Integrations, Billing — reproducing Figma frames
// verbatim with sample values, selects holding local state nothing read, and
// deliberate no-op "Save changes" buttons. They were removed rather than
// finished, because none of them had anything behind them: no notification
// code, no OAuth provider, no payments. If any of that is ever built, add the
// section back with the feature, not before it.
//
// Billing is the first one to come back on those terms: three plans now exist,
// the app reads which one the account is on, and the model tier is gated
// against it. The other three still have nothing behind them.
type Section =
  | 'profile'
  | 'appearance'
  | 'preferences'
  | 'notifications'
  | 'security'
  | 'integrations'
  | 'billing'
  | 'privacy'

const NAV: { id: Section; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: SunIcon },
  { id: 'preferences', label: 'Preferences', icon: SlidersIcon },
  { id: 'notifications', label: 'Notifications', icon: (p) => <Bell size={p.size ?? 15} /> },
  { id: 'security', label: 'Security', icon: (p) => <ShieldCheck size={p.size ?? 15} /> },
  { id: 'integrations', label: 'Integrations', icon: (p) => <Link2 size={p.size ?? 15} /> },
  { id: 'billing', label: 'Billing', icon: (p) => <CreditCard size={p.size ?? 15} /> },
  // NOT in the Figma frames, which list seven sections and no Privacy. Kept
  // anyway: it is the only way to reach "clear history" and "delete all local
  // data", both of which work. Deleting a real, reachable feature to match a
  // mockup is a different thing from making the app look like the mockup.
  { id: 'privacy', label: 'Privacy', icon: ShieldIcon }
]

export default function SettingsView({ onNavigate }: { onNavigate: (tab: Tab) => void }): JSX.Element {
  const [section, setSection] = useState<Section>('profile')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // The provider caches the level for every letter in this window, and there
  // is no settings-changed event to invalidate it — so the dropdown tells it
  // directly. Without this, Home's average grade kept the old letter until the
  // app was restarted.
  const setGradingLevel = useSetGradeLevel()
  const plan = usePlan()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    tracelyApi
      .getSettings()
      .then(setSettings)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // Preview-only: the app has no OS title bar (windows are frameless), so
  // without this a beta build and a real release look identical while you're
  // actually using them. Never shown in a real release — a version number
  // isn't something a user needs to see.
  const [buildInfo, setBuildInfo] = useState<AppGetBuildInfoResponse | null>(null)
  useEffect(() => {
    tracelyApi.getBuildInfo().then(setBuildInfo).catch(() => {})
  }, [])

  async function save(patch: Parameters<typeof tracelyApi.setSettings>[0]): Promise<void> {
    setError(null)
    try {
      const updated = await tracelyApi.setSettings(patch)
      setSettings(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const [hotkeyError, setHotkeyError] = useState<string | null>(null)

  /**
   * The main process only persists an accelerator the OS actually granted, so
   * "did it stick?" is answered by reading it back out of the response rather
   * than by a separate error channel.
   */
  async function saveHotkey(
    key: 'hotkeyAccelerator' | 'screenWatchHotkeyAccelerator',
    accelerator: string
  ): Promise<void> {
    setHotkeyError(null)
    try {
      const updated = await tracelyApi.setSettings({ [key]: accelerator })
      setSettings(updated)
      if (updated[key] !== accelerator) {
        setHotkeyError(`${accelerator} is already used by another app — keeping ${updated[key]}.`)
      }
    } catch (err) {
      setHotkeyError(err instanceof Error ? err.message : String(err))
    }
  }

  // Both Privacy actions are irreversible and there is no copy anywhere else,
  // so each goes through the existing ConfirmDialog rather than firing on click.
  const [clearConfirm, setClearConfirm] = useState<'history' | 'all' | null>(null)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const [clearDone, setClearDone] = useState<string | null>(null)

  async function runClear(scope: 'history' | 'all'): Promise<void> {
    setClearing(true)
    setClearError(null)
    setClearDone(null)
    try {
      await tracelyApi.clearHistory(scope === 'all')
      setClearDone(
        scope === 'all'
          ? 'History, saved sources and citations deleted.'
          : 'Analysis history deleted. Saved sources kept.'
      )
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
      setClearConfirm(null)
    }
  }

  function changeTheme(theme: Theme): void {
    applyTheme(theme)
    setSettings((s) => (s ? { ...s, theme } : s))
    void save({ theme })
  }

  function changeAccentColor(accentColor: AccentColor): void {
    applyAccentColor(accentColor)
    setSettings((s) => (s ? { ...s, accentColor } : s))
    void save({ accentColor })
  }

  function changeDensity(density: Density): void {
    applyDensity(density)
    setSettings((s) => (s ? { ...s, density } : s))
    void save({ density })
  }

  function changeFontSize(fontSize: FontSize): void {
    applyFontSize(fontSize)
    setSettings((s) => (s ? { ...s, fontSize } : s))
    void save({ fontSize })
  }

  // Real, locally-persisted (see profileHandlers.ts) — not tied to any
  // account, just local display preferences + an avatar image file.
  const [profile, setProfile] = useState<ProfileInfo | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    tracelyApi
      .getProfile()
      .then(setProfile)
      .catch((err) => setProfileError(err instanceof Error ? err.message : String(err)))
  }, [])

  /**
   * The Save changes confirm (Figma 212:65) sits in front of this.
   *
   * Only in front of the EXPLICIT saves — the ones with a button. The theme,
   * accent, density and font-size controls apply on change and have no Save
   * button by design (see the note further down), and putting a modal in front
   * of a live preview would make choosing a colour a three-click operation.
   */
  const [confirmingSave, setConfirmingSave] = useState(false)

  async function saveProfile(): Promise<void> {
    if (!profile) return
    setProfileSaving(true)
    setProfileError(null)
    try {
      const updated = await tracelyApi.setProfile({
        firstName: profile.firstName,
        lastName: profile.lastName,
        bio: profile.bio
      })
      setProfile(updated)
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err))
    } finally {
      setProfileSaving(false)
    }
  }

  /** Confirm first, unless the user ticked "Do not show anymore". */
  function requestSaveProfile(): void {
    if (settings?.suppressSaveConfirm) {
      void saveProfile()
      return
    }
    setConfirmingSave(true)
  }

  async function confirmSaveProfile(suppress: boolean): Promise<void> {
    setConfirmingSave(false)
    if (suppress) void save({ suppressSaveConfirm: true })
    await saveProfile()
  }

  function handleAvatarFile(file: File): void {
    if (file.size > 2 * 1024 * 1024) {
      setProfileError('Avatar image must be 2 MB or smaller')
      return
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setProfileError('Avatar must be a JPG or PNG image')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      setProfileError(null)
      tracelyApi
        .setProfile({ avatarDataUrl: dataUrl })
        .then(setProfile)
        .catch((err) => setProfileError(err instanceof Error ? err.message : String(err)))
    }
    reader.readAsDataURL(file)
  }

  // --- Preferences: Screen Watch on/off (moved here from the Home page
  // heading, which used to double as a click-to-toggle control) + the app
  // allowlist, backed by the same screenWatchAllowedApps setting and
  // settings:scanInstalledApps IPC that already existed before this UI
  // surface was added.
  const [screenWatch, setScreenWatch] = useState<ScreenWatchStatus | null>(null)
  const [screenWatchToggling, setScreenWatchToggling] = useState(false)
  const [installedApps, setInstalledApps] = useState<ScannedApp[] | null>(null)
  const [manualApp, setManualApp] = useState('')
  const [prefsError, setPrefsError] = useState<string | null>(null)

  useEffect(() => {
    tracelyApi.getScreenWatchStatus().then(setScreenWatch)
    return tracelyApi.onScreenWatchStatus(setScreenWatch)
  }, [])

  async function toggleScreenWatch(): Promise<void> {
    if (!screenWatch || screenWatchToggling) return
    setScreenWatchToggling(true)
    try {
      const status = await tracelyApi.setScreenWatchEnabled(!screenWatch.enabled)
      setScreenWatch(status)
    } finally {
      setScreenWatchToggling(false)
    }
  }

  useEffect(() => {
    if (section !== 'preferences' || installedApps !== null) return
    tracelyApi
      .scanInstalledApps()
      .then((res) => setInstalledApps(res.found))
      .catch((err) => setPrefsError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  const allowedApps = (settings?.screenWatchAllowedApps ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Scanned apps (with a real display name) plus any allowed exe that
  // wasn't found by the scan (e.g. manually added, or a portable app) —
  // those fall back to showing their exe name as the label since there's
  // no friendly name known for them.
  const scanned = installedApps ?? []
  const scannedExeSet = new Set(scanned.map((a) => a.exe.toLowerCase()))
  const knownApps = [
    ...scanned,
    ...allowedApps.filter((exe) => !scannedExeSet.has(exe.toLowerCase())).map((exe) => ({ name: exe, exe }))
  ].sort((a, b) => a.name.localeCompare(b.name))

  async function setAppAllowed(exe: string, allowed: boolean): Promise<void> {
    setPrefsError(null)
    const current = new Set(allowedApps.map((a) => a.toLowerCase()))
    if (allowed) current.add(exe.toLowerCase())
    else current.delete(exe.toLowerCase())
    try {
      await save({ screenWatchAllowedApps: Array.from(current).join(',') })
    } catch (err) {
      setPrefsError(err instanceof Error ? err.message : String(err))
    }
  }

  async function addManualApp(): Promise<void> {
    const exe = manualApp.trim()
    if (!exe) return
    setManualApp('')
    if (!knownApps.some((a) => a.exe.toLowerCase() === exe.toLowerCase())) {
      setInstalledApps((prev) => [...(prev ?? []), { name: exe, exe }])
    }
    // Newly-added apps aren't automatically allowed — adding them here just
    // makes them checkable; the user still has to check the box.
  }


  if (!settings) {
    return <div className="settings-view">{error ? <p className="error-text">{error}</p> : <p>Loading…</p>}</div>
  }

  return (
    <div className="settings-view">
      <div className="settings-shell">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <button className="settings-back-link" onClick={() => onNavigate('home')}>
              <BackIcon /> Back
            </button>
            <h2>Settings</h2>
          </div>
          <nav className="settings-nav">
            {NAV.map((n) => (
              <Fragment key={n.id}>
                <button
                  className={`settings-nav-item ${section === n.id ? 'active' : ''}`}
                  onClick={() => setSection(n.id)}
                >
                  <n.icon size={15} />
                  {n.label}
                </button>
              </Fragment>
            ))}
          </nav>
          {buildInfo?.isPreview ? (
            <div className="settings-sidebar-footer">
              <span className="settings-build-version">Preview v{buildInfo.version}</span>
            </div>
          ) : null}
        </aside>

        {confirmingSave ? (
          <ConfirmSheet
            busy={profileSaving}
            onConfirm={(suppress) => void confirmSaveProfile(suppress)}
            onCancel={() => setConfirmingSave(false)}
          />
        ) : null}

        {clearConfirm ? (
          <ConfirmDialog
            title={clearConfirm === 'all' ? 'Delete everything?' : 'Clear analysis history?'}
            message={
              clearConfirm === 'all'
                ? 'Deletes every past analysis, every source you saved and every citation generated. This machine holds the only copy.'
                : 'Deletes every past analysis and its claims and evidence. Saved sources are kept.'
            }
            confirmLabel={clearConfirm === 'all' ? 'Delete everything' : 'Clear history'}
            danger
            busy={clearing}
            // The wider one takes the library with it and cannot be undone, so
            // it gets the same type-to-confirm gate as deleting an account.
            requireText={clearConfirm === 'all' ? 'DELETE' : undefined}
            onConfirm={() => void runClear(clearConfirm)}
            onCancel={() => setClearConfirm(null)}
          />
        ) : null}

        <div className="settings-panel">
          {section === 'profile' && profile ? (
            <div key="profile" className="settings-panel-content">
              <div className="settings-panel-header">
                <h3>Profile</h3>
                <p>Your name, shown on this machine. Nothing here leaves it.</p>
              </div>
              <div className="settings-avatar-row">
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="" className="settings-avatar settings-avatar-photo" />
                ) : (
                  <div className="settings-avatar">
                    {(profile.firstName[0] ?? '') + (profile.lastName[0] ?? '') || '?'}
                  </div>
                )}
                <div className="settings-avatar-meta">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleAvatarFile(file)
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="settings-avatar-upload"
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    Upload photo
                  </button>
                  <p>JPG or PNG · max 2 MB</p>
                </div>
              </div>
              <div className="settings-panel-grid">
                <SettingsField label="First name">
                  <input
                    value={profile.firstName}
                    placeholder="First name"
                    onChange={(e) => setProfile({ ...profile, firstName: e.target.value })}
                  />
                </SettingsField>
                <SettingsField label="Last name">
                  <input
                    value={profile.lastName}
                    placeholder="Last name"
                    onChange={(e) => setProfile({ ...profile, lastName: e.target.value })}
                  />
                </SettingsField>
                {/*
                  No "Bio" field. It persisted fine and had no possible reader:
                  Tracely is local-first with no account page, no profile
                  anyone else sees, and nothing that could display a bio to a
                  second person — because there is no second person. Left in, it
                  invited someone to write something that goes nowhere.
                */}
              </div>
              {profileError ? <p className="error-text">{profileError}</p> : null}
              <Button variant="dark" onClick={requestSaveProfile} disabled={profileSaving}>
                {profileSaving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          ) : null}

          {section === 'appearance' ? (
            <div key="appearance" className="settings-panel-content">
              <div className="settings-panel-header">
                <h3>Appearance</h3>
                <p>Customize how Tracely looks for you.</p>
              </div>
              <div className="settings-panel-grid">
                <SettingsField label="Theme">
                  <select value={settings.theme} onChange={(e) => changeTheme(e.target.value as Theme)}>
                    <option value="system">System default</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </SettingsField>
                <SettingsField label="Accent color">
                  <div className="accent-swatch-row">
                    {ACCENT_COLORS.map((c) => (
                      <button
                        key={c.id}
                        className={`accent-swatch ${settings.accentColor === c.id ? 'accent-swatch-active' : ''}`}
                        style={{ background: c.swatch }}
                        title={c.label}
                        onClick={() => changeAccentColor(c.id)}
                      />
                    ))}
                  </div>
                </SettingsField>
                <SettingsField label="Font size">
                  <select
                    value={settings.fontSize}
                    onChange={(e) => changeFontSize(e.target.value as FontSize)}
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </SettingsField>
                <SettingsField label="Density">
                  <select value={settings.density} onChange={(e) => changeDensity(e.target.value as Density)}>
                    <option value="comfortable">Comfortable spacing across lists and cards</option>
                    <option value="compact">Compact spacing across lists and cards</option>
                  </select>
                </SettingsField>
              </div>
              {/*
                No "Save changes" button. changeTheme/changeAccentColor/
                changeDensity/changeFontSize each persist on change already, so
                the button re-sent the values that were already stored and could
                never alter any state — a control whose only possible effect was
                a spinner.
              */}
            </div>
          ) : null}

          {section === 'preferences' ? (
            <div key="preferences" className="settings-panel-content">
              <div className="settings-panel-header">
                <h3>Preferences</h3>
                <p>Turn Screen Watch on or off, and choose which apps it's allowed to read text from.</p>
              </div>
              <label className="settings-toggle-row">
                <div>
                  <div className="settings-toggle-row-title">Screen Watch</div>
                  <div className="settings-toggle-row-subtitle">
                    {screenWatch?.enabled ? 'On — reading focused apps for flagged claims.' : 'Off.'}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={screenWatch?.enabled ?? false}
                  disabled={!screenWatch || screenWatchToggling}
                  onChange={toggleScreenWatch}
                />
              </label>
              <div className="settings-app-grid">
                {installedApps === null ? (
                  <p className="muted">Scanning installed apps…</p>
                ) : knownApps.length === 0 ? (
                  <p className="muted">No apps found. Add one by name below.</p>
                ) : (
                  knownApps.map((app: ScannedApp) => {
                    const allowed = allowedApps.some((a) => a.toLowerCase() === app.exe.toLowerCase())
                    return (
                      <label key={app.exe} className="settings-app-check" title={app.exe}>
                        <input
                          type="checkbox"
                          checked={allowed}
                          onChange={(e) => void setAppAllowed(app.exe, e.target.checked)}
                        />
                        <span className="settings-app-check-name">{app.name}</span>
                      </label>
                    )
                  })
                )}
              </div>
              <div className="settings-app-add">
                <input
                  value={manualApp}
                  placeholder="Add an app by .exe name (e.g. notepad.exe)"
                  onChange={(e) => setManualApp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addManualApp()
                  }}
                />
                <Button variant="secondary" onClick={addManualApp}>
                  Add
                </Button>
              </div>
              {prefsError ? <p className="error-text">{prefsError}</p> : null}
              <p className="muted settings-app-note">
                Screen Watch only reads text in apps you check below — nothing is enabled anywhere until you pick
                it. Uncheck an app any time to stop it from being read.
              </p>

              {/*
                Everything below already worked end to end — persisted, and read
                by a real consumer — and simply had no control anywhere in the
                app. screenWatchService.ts even carried a comment pointing at
                "Settings > General > sensitivity", a section that never existed.
              */}
              <div className="settings-panel-grid settings-panel-grid-spaced">
                <SettingsField label="Analyze clipboard shortcut">
                  <HotkeyField
                    value={settings.hotkeyAccelerator}
                    onCapture={(a) => void saveHotkey('hotkeyAccelerator', a)}
                  />
                </SettingsField>
                <SettingsField label="Toggle Screen Watch shortcut">
                  <HotkeyField
                    value={settings.screenWatchHotkeyAccelerator}
                    onCapture={(a) => void saveHotkey('screenWatchHotkeyAccelerator', a)}
                  />
                </SettingsField>
                <SettingsField label="Default citation style">
                  <select
                    value={settings.defaultCitationStyle}
                    onChange={(e) => void save({ defaultCitationStyle: e.target.value as CitationStyle })}
                  >
                    <option value="APA">APA</option>
                    <option value="MLA">MLA</option>
                    <option value="Chicago">Chicago</option>
                  </select>
                </SettingsField>
                {/*
                  The school year the LETTER is graded against.

                  It does not touch the /100: the rubric measures the same six
                  things at every level, and the report's own breakdown adds up
                  to that number. What changes is what the number is worth — see
                  shared/gradeLevel.ts. Saying so here matters, because a
                  dropdown that silently moved a score would make the whole
                  report unarguable.
                */}
                <SettingsField label="Grading level">
                  <select
                    value={settings.gradingLevel}
                    onChange={(e) => {
                      const level = Number(e.target.value)
                      setGradingLevel(level)
                      void save({ gradingLevel: level })
                    }}
                  >
                    {GRADE_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {gradeLevelLabel(level)}
                      </option>
                    ))}
                  </select>
                </SettingsField>
                {/*
                  The only setting in here that spends money on its own, so it
                  says what it costs rather than what it does. It is on by
                  default (see settingsRepo) because the check it performs is
                  the one that makes a cited claim's verdict honest — the
                  evidence search never opens the work the writer named, and
                  this call is the only thing in Tracely that does.
                */}
                <label className="settings-toggle-row">
                  <div>
                    {/*
                      Named for what it does now, not for what it did first.
                      It read "Check my citations automatically" over a setting
                      that has also fact-checked uncited claims since the
                      claimType gate landed — a toggle whose label describes
                      half of it is one nobody can make an informed decision
                      about, and this is the switch that spends money.
                    */}
                    <div className="settings-toggle-row-title">Fact-check my claims automatically</div>
                    <div className="settings-toggle-row-subtitle">
                      {settings.autoCritiqueCited
                        ? 'On — when you analyse a document, Tracely checks whether your factual claims are actually true, and looks up the sources you cited to see they say what you say they do. Uses AI credits.'
                        : 'Off — claims are checked only when you press Critique.'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.autoCritiqueCited}
                    onChange={(e) => void save({ autoCritiqueCited: e.target.checked })}
                  />
                </label>
                {/*
                  Which model does the work. The select shows the tier that
                  will actually RUN — resolveModelTier, the same function the
                  main process clamps with before every relay call — so a
                  `thorough` row left behind by a lapsed subscription reads as
                  Fast here rather than naming a model this account is not
                  getting. The tiers above the plan stay in the list, disabled
                  and labelled with what they cost; removing them would hide
                  that there is anything to upgrade to.
                */}
                <SettingsField label="Model">
                  <select
                    value={resolveModelTier(settings.modelTier, plan)}
                    onChange={(e) => void save({ modelTier: e.target.value as ModelTier })}
                  >
                    {MODEL_TIERS.map((tier) => (
                      <option key={tier} value={tier} disabled={!modelTierUnlocked(tier, plan)}>
                        {MODEL_TIER_LABEL[tier]}
                        {modelTierUnlocked(tier, plan)
                          ? ''
                          : ` — ${PLAN_LABEL[MODEL_TIER_REQUIRES[tier]]} plan`}
                      </option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsField label={`Claim sensitivity — ${Math.round(settings.claimSensitivity * 100)}%`}>
                  <input
                    type="range"
                    min={0.3}
                    max={0.9}
                    step={0.05}
                    value={settings.claimSensitivity}
                    onChange={(e) => void save({ claimSensitivity: Number(e.target.value) })}
                  />
                </SettingsField>
              </div>
              {hotkeyError ? <p className="error-text">{hotkeyError}</p> : null}
              <p className="muted settings-app-note">
                Grading level moves the letter, not the score out of 100 — the rubric measures the same six
                things at every level. The same draft that earns an A in grade 3 is a D in grade 12, because the
                expectations are what changed, and the breakdown in the report still explains every point.
              </p>
              <p className="muted settings-app-note">
                A lower sensitivity flags more sentences, including borderline ones. Screen Watch underlines
                passively, without you asking about any one sentence, so over-flagging is more annoying here than
                in a session you started yourself.
              </p>
              <p className="muted settings-app-note">
                Checks, critique and grading run on the {MODEL_TIER_LABEL[resolveModelTier(settings.modelTier, plan)].toLowerCase()} model
                — {MODEL_TIER_DESCRIPTION[resolveModelTier(settings.modelTier, plan)].toLowerCase()} Tiers your
                plan does not include are listed but cannot be chosen; Billing says what unlocks them.
              </p>
            </div>
          ) : null}

          {/* The four sections the Figma file draws and the product does not
              have. Labels and order are each frame's own; the values are not —
              see SettingsUnavailable for why. */}
          {section === 'notifications' ? (
            <SettingsUnavailable
              key="notifications"
              title="Notifications"
              description="Choose what Tracely tells you about."
              note="Tracely does not send notifications yet — there is no notification code behind this screen, so nothing here can be switched on."
              fields={[
                { label: 'Email notifications' },
                { label: 'Push notifications' },
                { label: 'SMS alerts' },
                { label: 'Notification schedule', full: true },
                { label: 'Time zone', full: true }
              ]}
            />
          ) : null}

          {section === 'security' ? (
            <SettingsUnavailable
              key="security"
              title="Security"
              description="Keep your account protected."
              note="Sign-in is handled by Supabase and these controls are not wired to it. Two-factor, recovery email and session management are not built."
              fields={[
                { label: 'Two-factor authentication' },
                { label: 'Recovery email' },
                { label: 'Password', full: true },
                { label: 'Active sessions', full: true },
                { label: 'Recent login activity', full: true }
              ]}
            />
          ) : null}

          {section === 'integrations' ? (
            <SettingsUnavailable
              key="integrations"
              title="Integrations"
              description="Connect the tools you use every day."
              note="Nothing is connected, and nothing can be — there is no OAuth provider behind this screen. The frame shows Google Calendar, Nextdoor and Gmail as connected; none of those integrations exist."
              fields={[
                { label: 'Google Calendar' },
                { label: 'Nextdoor' },
                { label: 'Gmail', full: true },
                { label: 'Available integrations', full: true }
              ]}
            />
          ) : null}

          {/*
            The one of those four frames that now has a feature behind it, so
            it is a real panel rather than a SettingsUnavailable — the rule at
            the top of this file is to add the section back WITH the feature.
            What it still does not have is payments: the checkout, the card and
            the invoices all live on jointracely.com, so this reads the plan and
            hands off to the browser rather than reproducing the frame's payment
            method and billing-history boxes over nothing.
          */}
          {section === 'billing' ? (
            <div key="billing" className="settings-panel-content">
              <div className="settings-panel-header">
                <h3>Billing</h3>
                <p>Your plan, and what it unlocks.</p>
              </div>
              <div className="settings-plan-card">
                <div className="settings-plan-head">
                  <div>
                    <div className="settings-plan-name">{PLAN_LABEL[plan]}</div>
                    <div className="settings-plan-price">{PLAN_PRICE[plan]}</div>
                  </div>
                  <span className="settings-plan-badge">Current plan</span>
                </div>
                <ul className="settings-plan-includes">
                  {PLAN_INCLUDES[plan].map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              {plan === 'free' ? (
                <div className="settings-plan-upgrade">
                  <div>
                    <div className="settings-toggle-row-title">Upgrade</div>
                    <div className="settings-toggle-row-subtitle">
                      Student is {PLAN_PRICE.student} for unlimited checks and sources and the Balanced model. Pro is{' '}
                      {PLAN_PRICE.pro} and adds the most thorough one.
                    </div>
                  </div>
                  {/* The user's own browser, never a window of ours — the same
                      route every other outbound link in this app takes. */}
                  <Button variant="primary" onClick={() => void tracelyApi.openExternal(UPGRADE_URL)}>
                    See plans
                  </Button>
                </div>
              ) : null}
              {/* The last clause used to offer "or immediately if you sign out
                  and back in", which is no longer a thing anyone can do. Note
                  that with no sign-in there is also no way for a purchase made
                  on the website to find this install — every account here is
                  anonymous, so this panel can only ever read Free. Raised in
                  the PR rather than answered here: what replaces the upgrade
                  path is a product decision, not a cleanup. */}
              <p className="muted settings-app-note">
                Plans are bought and cancelled on jointracely.com. No card is stored in this app and nothing on
                this screen charges you. A change made there reaches this window the next time your session
                refreshes.
              </p>
            </div>
          ) : null}

          {section === 'privacy' ? (
            <div key="privacy" className="settings-panel-content">
              <div className="settings-panel-header">
                <h3>Privacy</h3>
                <p>
                  Everything Tracely stores lives on this machine. These delete it — there is no copy anywhere
                  else, and neither can be undone.
                </p>
              </div>
              <div className="settings-danger-list">
                <div className="settings-danger-row">
                  <div>
                    <div className="settings-toggle-row-title">Clear analysis history</div>
                    <div className="settings-toggle-row-subtitle">
                      Deletes past analyses, their claims and evidence. Saved sources stay.
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => setClearConfirm('history')} disabled={clearing}>
                    Clear history
                  </Button>
                </div>
                <div className="settings-danger-row">
                  <div>
                    <div className="settings-toggle-row-title">Clear history and library</div>
                    <div className="settings-toggle-row-subtitle">
                      Everything above, plus every source you saved and every citation generated.
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => setClearConfirm('all')} disabled={clearing}>
                    Clear everything
                  </Button>
                </div>
              </div>
              {clearError ? <p className="error-text">{clearError}</p> : null}
              {clearDone ? <p className="muted">{clearDone}</p> : null}
            </div>
          ) : null}

          {/*
            Notifications, Security, Integrations and Billing were four static
            Figma mockups: hardcoded text, selects bound to local state nothing
            ever read, and "Save changes" buttons with no onClick at all. There
            was no notification code, no OAuth provider and no plans anywhere in
            this repo, so none of them could have done anything.

            Each was also rendered TWICE — once in a keyed <div>, then again
            byte-identically in a fragment, both testing the same `section` —
            so selecting Billing painted the panel twice with two dead buttons.

            Billing left that list when the three plans became real. The other
            three have not.
          */}

          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}
