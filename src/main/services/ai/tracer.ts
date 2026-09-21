import type { TracerMessage } from '@shared/types'
import { callServer } from './client'
import {
  MAX_TRACER_DOCUMENT_CHARS,
  MAX_TRACER_HISTORY_MESSAGES,
  MAX_TRACER_MESSAGE_CHARS
} from './costGuard'
import { getLatestDocument } from '../storage/documentsRepo'

/**
 * Tracer — the conversational half of the app, restored.
 *
 * It was removed when the Screen Watch widget was rebuilt on the Figma frames,
 * which have no Tracer in them. What survived was the two SQLite tables, the
 * `Tracer*` types, the `TRACER_*` channels, and a relay endpoint nobody took
 * down. Home's frame draws a "Chat with Tracer" launcher, so it is back — as a
 * panel inside the main window rather than a `BrowserWindow` of its own.
 *
 * Two things still separate this from every other AI call here:
 *
 *  1. **Nothing is cached.** The others are keyed by a hash of their input and
 *     served from `cacheRepo` on a repeat, which works because they are pure
 *     functions of that input. A chat turn depends on the whole conversation so
 *     far, and the same follow-up in two conversations should get two answers —
 *     a cache would be actively wrong here, not merely useless.
 *  2. **The prompt lives on the server** (`server/lib/prompts/tracer.js`,
 *     ported verbatim from the relay), same as the others. This side only
 *     ever sends raw content.
 */

export interface TracerReply {
  reply: string
}

/**
 * `body_html` as prose.
 *
 * Local rather than shared because it exists for one caller and has one job:
 * produce something a language model can read. It is deliberately not a
 * general HTML parser — block tags become newlines, everything else is dropped,
 * and the five XML entities are decoded. The editor writes this HTML itself
 * (`execCommand`), so the input is a small, known dialect rather than the web.
 */
function plainText(html: string): string {
  return html
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * What Tracer is answering against.
 *
 * The original built this from Screen Watch — whatever document was focused in
 * some other application. That is the wrong source now: the launcher is on
 * Home, which means the app's own window is focused, which means Screen Watch
 * is by definition not reading anything. It takes the most recently edited
 * draft instead, which is both what the user was last working on and what every
 * other number on Home is about.
 *
 * Truncated hard, because the context is re-sent on every turn — an uncapped
 * essay would dominate the token cost of a long conversation.
 */
export function currentContext(): string {
  const doc = getLatestDocument()
  if (!doc) return ''

  const body = plainText(doc.bodyHtml)
  if (!body) return ''

  const truncated =
    body.length > MAX_TRACER_DOCUMENT_CHARS
      ? `${body.slice(0, MAX_TRACER_DOCUMENT_CHARS)}\n[…truncated]`
      : body
  return `The student's most recent draft, titled "${doc.title}":\n${truncated}`
}

/**
 * One conversational turn. `history` is the conversation so far, oldest first
 * and already persisted; `message` is what was just typed.
 */
export async function askTracer(
  message: string,
  history: TracerMessage[],
  context: string
): Promise<TracerReply> {
  const trimmedHistory = history.slice(-MAX_TRACER_HISTORY_MESSAGES).map((m) => ({
    // The server maps 'tracer' onto OpenAI's 'assistant' role, so the app's own
    // vocabulary never leaks into the API call.
    role: m.role,
    content: m.content.slice(0, MAX_TRACER_MESSAGE_CHARS)
  }))

  // No model passed: nothing here is cached, so there is no key for the
  // request to agree with, and callServer resolves the plan's model itself.
  return await callServer<TracerReply>('tracer', {
    message: message.slice(0, MAX_TRACER_MESSAGE_CHARS),
    history: trimmedHistory,
    context
  })
}
