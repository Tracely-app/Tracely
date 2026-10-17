// The Settings page's small decisions, kept free of imports (but types) so the
// test runner can load them: when a pause ends and how it reads, what the
// server's usage answer says, what an export is called and leaves out, what
// Help → Copy diagnostics holds, and what's new. 2026-10-16: the extension's
// Settings (extension/options.*) mirrored on the desktop.
import type { UsageInfo } from './ipc-contract'

// ── General → Pause ──────────────────────────────────────────────────────

/** Pause for 1 hour. */
export function pauseForHour(now: number): number {
  return now + 60 * 60 * 1000
}

/** Pause for today: until the next midnight, local time. */
export function pauseForToday(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** "4:30 PM", or "midnight" for a pause for today (the extension's untilLabel). */
export function resumeLabel(at: number): string {
  const d = new Date(at)
  return d.getHours() === 0 && d.getMinutes() === 0
    ? 'midnight'
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// ── Account and billing → what's been used ──────────────────────────────

/**
 * GET /api/entitlement's counts (server.js entitlementDetails): the source
 * searches used today and this month against the plan's limits, and the
 * daily AI-action allowance. Null when the answer carries neither — a server
 * that meters nothing, or one too old to say.
 */
export function usageFromEntitlement(data: unknown): UsageInfo | null {
  const d = (data ?? {}) as {
    limits?: { aiActionsPerDay?: unknown; sources?: { day?: unknown; month?: unknown } | null } | null
    usage?: { sources?: { today?: unknown; month?: unknown } | null } | null
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const lim = d.limits?.sources
  const used = d.usage?.sources
  const sources =
    lim && used && num(used.today) !== null && num(used.month) !== null && (num(lim.day) !== null || num(lim.month) !== null)
      ? { today: num(used.today) as number, month: num(used.month) as number, day: num(lim.day), monthLimit: num(lim.month) }
      : null
  const aiActionsPerDay = num(d.limits?.aiActionsPerDay)
  if (!sources && aiActionsPerDay === null) return null
  return { sources, aiActionsPerDay }
}

/** The bars: each limit the server named, with what has been used against it. */
export function usageRows(usage: UsageInfo | null): { label: string; used: number; of: number }[] {
  const s = usage?.sources
  if (!s) return []
  const rows: { label: string; used: number; of: number }[] = []
  if (s.day !== null) rows.push({ label: 'Source searches today', used: s.today, of: s.day })
  if (s.monthLimit !== null) rows.push({ label: 'Source searches this month', used: s.month, of: s.monthLimit })
  return rows
}

// ── Privacy and data → Export my data ───────────────────────────────────

/** Settings rows that are the app's bookkeeping, not the person's choices: never in a file they take away. */
export const EXPORT_SETTINGS_LEAVE_OUT = ['learnedNamesForCleanup', 'crossrefMailto'] as const

export function exportFileName(now: Date): string {
  return `tracely-data-${now.toISOString().slice(0, 10)}.json`
}

// ── Help → Copy diagnostics ─────────────────────────────────────────────

/**
 * What a report needs to say what happened: the version and build, the
 * operating system, the plan, the settings and what Screen Watch is doing.
 * Never a word of anyone's writing, their name or their avatar.
 */
export function buildDiagnostics(input: {
  version: string | null
  isPreview: boolean
  platform: string
  plan: string
  settings: Record<string, unknown>
  screenWatch: Record<string, unknown> | null
}): Record<string, unknown> {
  const settings = { ...input.settings }
  for (const key of EXPORT_SETTINGS_LEAVE_OUT) delete settings[key]
  const sw = input.screenWatch
  return {
    app: 'Tracely desktop',
    version: input.version,
    build: input.isPreview ? 'preview' : 'stable',
    platform: input.platform,
    plan: input.plan,
    settings,
    // What it is doing, not what it read: the app it is in, never the text.
    screenWatch: sw
      ? {
          enabled: sw.enabled,
          active: sw.active,
          processName: sw.processName,
          supportsUnderlines: sw.supportsUnderlines,
          claimCount: sw.claimCount,
          lastError: sw.lastError,
          blockedApp: sw.blockedApp,
          resumeAt: sw.resumeAt ?? 0
        }
      : null
  }
}

// ── Help → What's new ───────────────────────────────────────────────────

/** Newest first, in the words a tester would use; dated, as the desktop ships by date as much as by number. */
export const WHATS_NEW: readonly { date: string; text: string }[] = [
  { date: '2026-10-16', text: 'A new Settings: pause Screen Watch for an hour or for the day, see what you have used, export your data, and this Help.' },
  { date: '2026-10-13', text: 'Apply revision changes one sentence at a time, writing tips are gone, and Needs evidence is blue.' },
  { date: '2026-10-12', text: 'Fewer wrong citation flags: a date is not a quantity, and a quoted title is not a quotation.' },
  { date: '2026-10-07', text: 'Source lists show what each source actually says before you cite it.' },
  { date: '2026-10-06', text: 'Hover cards stop jumping, and a card can find the work you cited or replace the citation.' }
]
