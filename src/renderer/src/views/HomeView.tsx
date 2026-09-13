import { useEffect, useMemo, useState } from 'react'
import type { ScreenWatchStatus } from '@shared/ipc-contract'
import type { DocumentListItem } from '@shared/types'
import { computeHomeStats } from '@shared/homeStats'
import { greetingFor } from '@shared/greeting'
import SourceFinderPanel from '../components/SourceFinderPanel'
import type { CitationStyle } from '@shared/types'
import type { Tab } from '../App'
import figmaLogo from '../assets/figma-logo.png'
import tracerBadge from '../assets/tracer-badge.png'
import iconPersuasive from '../assets/resource-persuasive.svg'
import iconRubric from '../assets/resource-rubric.svg'
import iconResearch from '../assets/resource-research.svg'
import iconSources from '../assets/resource-sources.svg'
import homeArrow from '../assets/home-arrow.svg'
import { gradeFor } from '../components/essayGrade'
import { tracelyApi } from '../lib/api'
import { useGradeLevel } from '../lib/gradeLevel'
import GuideReader from '../components/GuideReader'
import TracerChat from '../components/TracerChat'
import { GUIDES, guideById } from '../content/guides'

/**
 * Home — rebuilt from the owner's mockup, 2026-08-18.
 *
 * What it replaces: a pixel-exact transcription of Figma's "Frame Main Page",
 * whose sixteen elements sat at literal design coordinates inside a fixed
 * 870x606 canvas. That is why Home was the one view in the app that could not
 * reflow, and why it had to keep its size and centre when the window became
 * freely resizable. This layout is ordinary flow and grid, so that exception is
 * gone with it — Home fills the window like everything else now.
 *
 * The old screen was also mostly illustration: a decorative popover, a dotted
 * flight path, a flying logo. This one is almost entirely real state — three
 * computed statistics, the actual recent documents, and the live Screen Watch
 * status — which is the substance of the change rather than the arrangement.
 */

/**
 * The four cards under "Resources". Content, not layout, so it sits up here.
 *
 * Each icon is one exported 40x40 SVG holding both the tinted disc and its
 * glyph, transcribed from the frame's own geometry — `Resource Card - *`
 * (525:141/147/153/159) read through `get_design_context`, which gives the
 * shapes to three decimals along with colours guessing had wrong: the pencil
 * is #f1650b rather than the brand orange, and the magnifier #7b44d4 rather
 * than a violet chosen to look about right.
 *
 * They were hand-drawn here for one build and did not match — wrong angle on
 * the pencil, wrong bar widths, a document at the wrong proportions. Redrawing
 * brand art from a screenshot is the mistake the mascot took two attempts to
 * stop making.
 */
const RESOURCE_ICONS: Record<string, string> = {
  persuasive: iconPersuasive,
  rubric: iconRubric,
  research: iconResearch,
  sources: iconSources
}

const RESOURCES = GUIDES.map((guide) => ({
  id: guide.id,
  title: guide.title,
  blurb: guide.blurb,
  icon: RESOURCE_ICONS[guide.id]
}))

/**
 * "Opened today" / "Opened yesterday" / "Opened May 12".
 *
 * Relative for the two days anyone can hold in their head and absolute after
 * that — "Opened 47 days ago" is arithmetic the reader has to undo, and a bare
 * date for something touched an hour ago reads as stale.
 */
function openedLabel(iso: string, now: Date): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return 'Opened recently'
  const day = (d: Date): number =>
    Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000)
  const delta = day(now) - day(at)
  if (delta <= 0) return 'Opened today'
  if (delta === 1) return 'Opened yesterday'
  return `Opened ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export default function HomeView({
  onNavigate,
  onNewDocument,
  onOpenDocument
}: {
  onNavigate: (tab: Tab) => void
  onNewDocument: () => void
  /**
   * Open one draft in the editor. The same callback the Documents list uses, so
   * a card here and a row there land in exactly the same place.
   *
   * These cards used to call `onNavigate('documents')` — clicking your own
   * essay dropped you on a list you then had to find it in again, one click
   * from where you already were. "View all documents", directly above them, is
   * the control that means "show me the list".
   */
  onOpenDocument: (id: string) => void
}): JSX.Element {
  const gradingLevel = useGradeLevel()
  const [screenWatch, setScreenWatch] = useState<ScreenWatchStatus | null>(null)
  const [openGuide, setOpenGuide] = useState<string | null>(null)
  const [tracerOpen, setTracerOpen] = useState(false)
  const [finderOpen, setFinderOpen] = useState(false)
  /**
   * The style the finder formats its results in.
   *
   * Read from settings rather than defaulted, because a citation shown in a
   * style the user does not write in is one they have to retype. Falls back to
   * APA only until the read resolves.
   */
  const [citationStyle, setCitationStyle] = useState<CitationStyle>('APA')
  const [documents, setDocuments] = useState<DocumentListItem[]>([])

  useEffect(() => {
    tracelyApi.getScreenWatchStatus().then(setScreenWatch)
    // The finder formats its results in the user's own style. A failed read
    // leaves the APA default rather than blocking the panel.
    tracelyApi
      .getSettings()
      .then((s) => setCitationStyle(s.defaultCitationStyle))
      .catch(() => {})
    return tracelyApi.onScreenWatchStatus(setScreenWatch)
  }, [])

  useEffect(() => {
    tracelyApi
      .listDocuments()
      .then((res) => setDocuments(res.documents))
      .catch(() => setDocuments([]))
  }, [])

  // One instant for the whole render, so the greeting, the streak and every
  // "Opened today" agree with each other. Reading the clock separately in each
  // place is how a card says "yesterday" next to a streak that counted it.
  const now = useMemo(() => new Date(), [])
  const stats = useMemo(() => computeHomeStats(documents, now), [documents, now])
  const recent = documents.slice(0, 3)

  return (
    <div className="home">
      <div className="home-inner">
        {/*
          The white card across the top, on the page's grey.

          The frame builds Home as cards floating on #e5e7eb, and this row —
          brand, greeting, status, Settings — is one of them. It was a flat
          white page here, which is why every border and tint below was being
          drawn against the wrong ground.
        */}
        <section className="home-card">
        <header className="home-top">
          <div className="home-brand">
            <img src={figmaLogo} alt="" />
            <span>Tracely</span>
          </div>
          {/*
            No close button here.

            The design has one and this had one, hiding to the tray. The window
            now draws the real Windows close in the same corner (the title BAR
            is hidden, its buttons are not — see mainWindow.ts), and it does
            exactly the same thing: `close` is intercepted and hides to the
            tray, because window-all-closed keeps the app alive for the global
            hotkey. Two X's a few pixels apart, doing one thing, is the reason
            the app's own window controls were deleted in the first place.
          */}
          {/* Unnamed, because nothing knows the name any more. It came from
              the sign-up form, and there is no sign-up. This already rendered
              as a bare "Good afternoon!" for any account that reached the app
              without one, so the greeting loses a comma rather than a
              branch. */}
          <h1 className="home-greeting">{greetingFor(now.getHours())}!</h1>
        </header>

        <div className="home-statusrow">
          <p className={`home-status${screenWatch?.enabled ? ' on' : ''}`}>
            <span className="home-status-dot" aria-hidden="true" />
            {/* `authRequired` is a 401 from the relay. It used to mean "you
                are signed out" and said so; nobody signs in now, so when it
                fires the account the app holds for itself could not be
                established or refreshed — which is not something the reader
                can act on by signing in, and must not tell them to. */}
            {screenWatch?.authRequired
              ? 'Tracely cannot reach its account service. Checks are paused.'
              : screenWatch?.enabled
                ? 'Tracely is running and ready.'
                : 'Tracely is off.'}
          </p>
          <button className="home-settings" onClick={() => onNavigate('settings')}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 4v2M12 18v2M4 12h2M18 12h2M6.5 6.5l1.4 1.4M16.1 16.1l1.4 1.4M17.5 6.5l-1.4 1.4M7.9 16.1l-1.4 1.4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            Settings
          </button>
        </div>
        </section>

        {/*
          Three real numbers, computed from the document list this page already
          loads — see shared/homeStats.ts. An em dash rather than a 0 when there
          is nothing to average: 0 renders as "F", which is a grade nobody
          earned, and a brand-new account should not open on one.
        */}
        <section className="home-stats" aria-label="Your writing at a glance">
          <div className="home-stat">
            <b>{stats.gradedThisMonth}</b>
            <span>Documents graded this month</span>
          </div>
          <div className="home-stat">
            <b>{stats.averageScore === null ? '—' : gradeFor(stats.averageScore, gradingLevel).letter}</b>
            <span>Average grade</span>
          </div>
          <div className="home-stat">
            <b>
              {stats.streakDays} {stats.streakDays === 1 ? 'day' : 'days'}
            </b>
            <span>Current grading streak</span>
          </div>
        </section>

        <section className="home-actions">
          <button className="home-action primary" onClick={onNewDocument}>
            <span className="home-action-icon" aria-hidden="true">
              +
            </span>
            <span className="home-action-text">
              <b>New document</b>
              <span>Paste or upload writing for Tracely to grade.</span>
            </span>
          </button>
          {/*
            Replaces the disabled "Paste a link" card that sat here.

            That card was in the design and had nothing behind it — nothing in
            the app fetches a URL, and the four indexes hold papers rather than
            arbitrary pages — so it was rendered disabled rather than wired to
            something adjacent. This is the same slot doing something real.

            Owner, 2026-08-22: a place on Home to "enter a piece of evidence and
            it returns sources that work with it". Every other route to
            retrieval needs a document, a detected claim and a stored row first;
            this is the same search with none of that, for the question people
            actually arrive with.
          */}
          <button className="home-action" onClick={() => setFinderOpen(true)}>
            <span className="home-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="6.2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M15.5 15.5L20 20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <span className="home-action-text">
              <b>Find sources</b>
              <span>Paste a fact and Tracely finds work that supports it.</span>
            </span>
          </button>
        </section>

        {/*
          Two columns on a wide window, stacked otherwise — see .home-lower.
          A wrapper rather than a class on each section, because the grid has
          to own both of them: making the sections themselves grid items of
          .home-inner would put the header, the stats and the actions in the
          same track list.
        */}
        <div className="home-lower">
          <section className="home-section">
            <div className="home-section-head">
              <h2>Recent documents</h2>
              <button className="home-link" onClick={() => onNavigate('documents')}>
                View all documents →
              </button>
            </div>
            {recent.length === 0 ? (
              <p className="home-empty">
                Nothing here yet. Start a document and Tracely will grade it as you write.
              </p>
            ) : (
              <div className="home-docs">
                {recent.map((doc) => (
                  <button key={doc.id} className="home-doc" onClick={() => onOpenDocument(doc.id)}>
                    <span className="home-doc-thumb" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      {doc.score !== null ? (
                        <span className={`home-doc-grade tone-${doc.score >= 80 ? 'good' : doc.score >= 65 ? 'mid' : 'low'}`}>
                          {gradeFor(doc.score, gradingLevel).letter}
                        </span>
                      ) : null}
                    </span>
                    <span className="home-doc-title">{doc.title}</span>
                    <span className="home-doc-meta">{openedLabel(doc.updatedAt, now)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="home-section home-section--resources">
            <div className="home-section-head">
              <h2>Resources</h2>
            </div>
            <p className="home-section-sub">Guides to help you write and grade with confidence.</p>
            <div className="home-resources">
              {RESOURCES.map((item) => (
                // Same call as "Paste a link": the four guides are named in the
                // design and none of them is written. A "Read →" that goes
                // nowhere is a worse first impression than one that is plainly
                // not ready yet.
                <button
                  key={item.id}
                  className="home-resource"
                  onClick={() => setOpenGuide(item.id)}
                >
                  <img className="home-resource-icon" src={item.icon} alt="" width={40} height={40} />
                  <b>{item.title}</b>
                  <span className="home-resource-blurb">{item.blurb}</span>
                  <span className="home-resource-read">Read →</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="home-foot">
          {/*
            Tracer was removed from this app when the Screen Watch widget was
            rebuilt on the Figma frames — window, relay client, IPC handlers,
            repo and every entry point. What survived was the two SQLite
            tables, the `Tracer*` types, the `TRACER_*` channels and a relay
            endpoint nobody took down, which is why bringing it back was a
            morning rather than a week.

            It is back here because this frame draws it, and the owner asked
            for the panel: components/TracerChat.tsx, inside this window
            rather than a BrowserWindow of its own.
          */}
          <div className="home-tracer">
            {/*
              The owner's own artwork, used as supplied rather than redrawn.
              A hand-authored SVG approximation shipped here for one build and
              was rejected on sight — "use this exact image" — which is the
              right call: the character is brand art, and an approximation of
              brand art is just a worse version of it.

              The orange disc is part of the image, so the container adds no
              halo of its own; doing that gave it two rings.
            */}
            <img className="home-tracer-badge" src={tracerBadge} alt="" />
            <button className="home-tracer-btn" onClick={() => setTracerOpen(true)}>
              Chat with Tracer
            </button>
          </div>
          <button className="home-worklink" onClick={() => onNavigate('settings')}>
            You choose where Tracely works
            <img src={homeArrow} alt="" width={17} height={22} />
          </button>
        </footer>
      </div>

      {finderOpen ? (
        <SourceFinderPanel style={citationStyle} onClose={() => setFinderOpen(false)} />
      ) : null}
      {tracerOpen ? <TracerChat onClose={() => setTracerOpen(false)} /> : null}
      {openGuide ? (
        <GuideReader guide={guideById(openGuide)!} onClose={() => setOpenGuide(null)} />
      ) : null}
    </div>
  )
}
