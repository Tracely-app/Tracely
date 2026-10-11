import { Fragment, useEffect, useRef, useState } from 'react'
import type { TracerMessage } from '@shared/types'
import { parseTracerReply, type TracerRewrite } from '@shared/tracerRewrite'
import { planRank } from '@shared/plan'
import { tracelyApi, TracelyApiError } from '../lib/api'
import { usePlan } from '../lib/plan'
import tracerBadge from '../assets/tracer-badge.png'
import { formatClock } from '../voice/session'
import { WaveformIcon } from './icons'
import VoiceMode from './voice/VoiceMode'

/**
 * The Tracer chat panel, opened from Home's launcher.
 *
 * Tracer used to be its own focusable `BrowserWindow`, opened from the Screen
 * Watch widget, and was removed when that widget was rebuilt on the Figma
 * frames. This is the same conversation in the shape the owner asked for: a
 * panel anchored over Home, above the launcher that opens it.
 *
 * What is real here: the relay call, the SQLite conversation, and the
 * document context. What is not: nothing. The panel sends `tracer:send` and
 * renders what comes back.
 */

/**
 * Where each saved voice call starts in the chat: first message id → who and
 * how long. Drawn as a divider by the panel only — the stored messages stay
 * plain, because they are re-sent to the model as history. Per device, like
 * the conversation; a convenience, so blocked storage just means no dividers.
 */
const VOICE_MARKERS_KEY = 'tracely.voice.markers'
const VOICE_MARKERS_KEPT = 100
type VoiceMarkers = Record<string, { voice: string; seconds: number }>

function readVoiceMarkers(): VoiceMarkers {
  try {
    const raw = localStorage.getItem(VOICE_MARKERS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as VoiceMarkers) : {}
  } catch {
    return {}
  }
}

function writeVoiceMarkers(markers: VoiceMarkers): void {
  try {
    localStorage.setItem(VOICE_MARKERS_KEY, JSON.stringify(markers))
  } catch {
    /* storage blocked: no dividers next time */
  }
}

/** Local ids for the two messages that exist only on screen. */
const PENDING_ID = '__pending__'
const GREETING_ID = '__greeting__'

export default function TracerChat({
  onClose,
  onApplyRewrite,
  initialQuestion = null
}: {
  onClose: () => void
  /**
   * A question typed into the box for the writer — the off-topic card's "Ask
   * Tracer" — and NOT sent. Sending is a paid call, so the writer presses
   * Send; this only saves them composing it. A new question replaces whatever
   * is in the box, since it is the answer to the button they just pressed.
   */
  initialQuestion?: string | null
  /**
   * Apply a proposed rewrite to the document, returning whether it landed.
   *
   * Optional, and its absence is what makes the offer disappear: on Home there
   * is no open document to edit, so a card with an Apply button would be a
   * button that cannot work. In the editor it is provided, and the rewrite goes
   * in through the same execCommand path as every other edit — one Ctrl+Z
   * takes it back out.
   */
  onApplyRewrite?: (rewrite: TracerRewrite) => boolean
}): JSX.Element {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TracerMessage[]>([])
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [serverConfigured, setServerConfigured] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState(initialQuestion ?? '')
  useEffect(() => {
    if (initialQuestion) setInput(initialQuestion)
  }, [initialQuestion])
  // Message id -> what happened when its rewrite was applied. Keyed by id
  // rather than held on the message so re-fetching the conversation cannot
  // resurrect an offer the writer has already taken.
  const [applied, setApplied] = useState<Record<string, 'done' | 'missing' | 'dismissed'>>({})
  // Tracer Voice: the voice view replaces the log and the composer while open.
  // Everything above stays mounted, so a typed question, an Apply offer and
  // the conversation are all where they were when the chat comes back.
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [voiceMarkers, setVoiceMarkers] = useState<VoiceMarkers>(readVoiceMarkers)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    tracelyApi
      .getTracerConversation()
      .then((res) => {
        if (cancelled) return
        setConversationId(res.conversation.id)
        setMessages(res.messages)
        setServerConfigured(res.serverConfigured)
        // The context string starts `The student's most recent draft, titled
        // "…"` — the title is pulled back out of it rather than carried in a
        // field of its own, because `TracerContext` is a shared type and
        // shared types here are additive: adding a field to serve one label is
        // the kind of change that file exists to discourage.
        const match = /titled "([^"]+)"/.exec(res.context.documentText)
        setDraftTitle(match?.[1] ?? null)
      })
      .catch((e) => setError(e instanceof TracelyApiError ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Pinned to the newest message, including while one is being typed.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  const greeting: TracerMessage | null =
    messages.length > 0
      ? null
      : {
          id: GREETING_ID,
          conversationId: conversationId ?? '',
          role: 'tracer',
          content: draftTitle
            ? `Hey! I can see your ${draftTitle} draft. Ask me about a claim that reads too strongly, a paragraph that is not landing, or what the grade is reacting to.`
            : 'Hey! Start a document and I can read it with you — or ask me anything about building an argument, sourcing it, or what the grade is reacting to.',
          createdAt: new Date().toISOString()
        }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || !conversationId || sending) return

    // The typed message goes up immediately under a placeholder id, then the
    // stored pair from the database replaces it. Showing what was typed and
    // then swapping in the row that was actually saved is what keeps the ids
    // real — the panel never invents one that SQLite does not have.
    const pending: TracerMessage = {
      id: PENDING_ID,
      conversationId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    setMessages((prev) => [...prev, pending])
    setInput('')
    // Send goes away with the text (Talk takes its slot), so focus a click on
    // it left behind goes back to the box rather than falling to the page.
    inputRef.current?.focus()
    setError(null)
    setSending(true)

    try {
      const res = await tracelyApi.sendToTracer(conversationId, text)
      setMessages((prev) => [...prev.filter((m) => m.id !== PENDING_ID), res.userMessage, res.reply])
    } catch (e) {
      // The question stays on screen. It is the user's writing, and the main
      // process has already saved it — dropping the bubble would mean retyping
      // something the database is holding.
      setError(e instanceof TracelyApiError ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const shown = greeting ? [greeting] : messages

  function closeVoice(transcriptSaved: boolean): void {
    setVoiceOpen(false)
    // A saved call is in the conversation now; read it back so it shows.
    if (transcriptSaved && conversationId) {
      tracelyApi
        .getTracerConversation(conversationId)
        .then((res) => setMessages(res.messages))
        .catch(() => {})
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }
  // A call's transcript was just saved: read the conversation back (the log
  // is hidden behind the voice view, but it's current when the chat returns)
  // and mark where the call's messages begin.
  function markVoiceCall(call: { voiceName: string; seconds: number }): void {
    if (!conversationId) return
    const before = new Set(messagesRef.current.map((m) => m.id))
    tracelyApi
      .getTracerConversation(conversationId)
      .then((res) => {
        setMessages(res.messages)
        const first = res.messages.find((m) => !before.has(m.id))
        if (!first) return
        const next: VoiceMarkers = { ...readVoiceMarkers(), [first.id]: { voice: call.voiceName, seconds: call.seconds } }
        const ids = Object.keys(next)
        for (const id of ids.slice(0, Math.max(0, ids.length - VOICE_MARKERS_KEPT))) delete next[id]
        writeVoiceMarkers(next)
        setVoiceMarkers(next)
      })
      .catch(() => {})
  }
  const talkDisabled = !serverConfigured || conversationId === null
  // Voice is Pro-only; the tooltips say so before the click (VoiceMode then
  // explains, and the server decides).
  const proHint = planRank(usePlan()) < planRank('pro') ? ' (Pro)' : ''

  return (
    <div className="tracer-panel" role="dialog" aria-label="Chat with Tracer">
      <header className="tracer-head">
        <img className="tracer-head-badge" src={tracerBadge} alt="" />
        <div className="tracer-head-text">
          <b>Tracer</b>
          <span>
            <i className="tracer-dot" aria-hidden="true" />
            Online — here to help
          </span>
        </div>
        {voiceOpen ? null : (
          <button
            type="button"
            className="tracer-head-talk"
            onClick={() => setVoiceOpen(true)}
            aria-label="Start a voice call"
            title={`Start a voice call${proHint}`}
            disabled={talkDisabled}
          >
            <WaveformIcon size={17} />
          </button>
        )}
        <button className="tracer-close" onClick={onClose} aria-label="Close chat">
          <svg viewBox="0 0 21 21" fill="none" aria-hidden="true">
            <path d="M4 4l13 13M17 4L4 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {voiceOpen ? (
        <VoiceMode conversationId={conversationId} onExit={closeVoice} onTranscriptSaved={markVoiceCall} />
      ) : (
      <>
      <div className="tracer-log" ref={scrollRef}>
        {shown.map((m) => {
          // Parsed at render, not at receipt, so a conversation reopened
          // tomorrow still offers the rewrite it offered today — the block is
          // stored with the message rather than stripped before saving.
          const { prose, rewrite } = m.role === 'tracer'
            ? parseTracerReply(m.content)
            : { prose: m.content, rewrite: null }
          const state = applied[m.id]
          const voiceCall = voiceMarkers[m.id]
          return (
            <Fragment key={m.id}>
              {voiceCall ? (
                <p className="tracer-voice-divider">
                  Voice call with {voiceCall.voice} · {formatClock(voiceCall.seconds)}
                </p>
              ) : null}
              <div className="tracer-turn">
                <p className={`tracer-msg ${m.role === 'user' ? 'from-user' : 'from-tracer'}`}>
                  {prose}
                </p>
                {rewrite && onApplyRewrite ? (
                  <div className="tracer-rewrite">
                    <b>Suggested rewrite</b>
                    <p className="tracer-rewrite-was">{rewrite.find}</p>
                    <p className="tracer-rewrite-now">{rewrite.replace}</p>
                    {state === 'done' ? (
                      <span className="tracer-rewrite-done">
                        Applied — Ctrl+Z undoes it.
                      </span>
                    ) : state === 'missing' ? (
                      <span className="tracer-rewrite-gone">
                        That sentence is not in the document any more — nothing was changed.
                      </span>
                    ) : state === 'dismissed' ? (
                      <span className="tracer-rewrite-gone">Dismissed.</span>
                    ) : (
                      <div className="tracer-rewrite-actions">
                        <button
                          className="tracer-apply"
                          onClick={() => {
                            // The edit runs HERE, not inside the state updater.
                            // React invokes an updater twice under StrictMode, so
                            // the second call re-ran the rewrite against a
                            // document that had already taken it: the text was
                            // correct and the card said "that sentence is not in
                            // the document any more". Caught in the harness.
                            const landed = onApplyRewrite(rewrite)
                            setApplied((prev) => ({ ...prev, [m.id]: landed ? 'done' : 'missing' }))
                          }}
                        >
                          Apply
                        </button>
                        <button
                          className="tracer-dismiss"
                          onClick={() => setApplied((prev) => ({ ...prev, [m.id]: 'dismissed' }))}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </Fragment>
          )
        })}
        {sending ? (
          <p className="tracer-msg from-tracer tracer-typing" aria-label="Tracer is typing">
            <i />
            <i />
            <i />
          </p>
        ) : null}
        {error ? <p className="tracer-error">{error}</p> : null}
        {!serverConfigured ? (
          <p className="tracer-error">
            This build has no Tracely server configured, so Tracer cannot answer. Everything else
            in Tracely works without one.
          </p>
        ) : null}
      </div>

      <form
        className="tracer-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Tracer anything…"
          disabled={!serverConfigured || conversationId === null}
        />
        {/* With nothing typed, Talk takes Send's slot, filled, as the one
            action; once there is text, Send comes back as the filled action
            and Talk steps down to the wash. Same element either way, so focus
            on it survives the swap. */}
        <button
          type="button"
          className={`tracer-talk ${input.trim() ? '' : 'tracer-talk-primary'}`}
          aria-label="Talk to Tracer"
          title={`Talk to Tracer${proHint}`}
          disabled={talkDisabled}
          onClick={() => setVoiceOpen(true)}
        >
          <WaveformIcon size={19} />
        </button>
        {input.trim() ? (
          <button
            type="submit"
            className="tracer-send"
            aria-label="Send"
            disabled={sending || !serverConfigured}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 19V5M12 5l-6 6M12 5l6 6"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
      </form>
      </>
      )}
    </div>
  )
}
