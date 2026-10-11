import { randomUUID } from 'crypto'
import type { TracerConversation, TracerMessage, TracerRole } from '@shared/types'
import { queryAll, queryOne, run, transaction } from './db'
import { transcriptTimestamps, type TranscriptMessage } from '../voice/transcript'

// The one place in Screen Watch that persists anything. Everything else
// there is deliberately ephemeral (see screenWatchService.ts) so passive
// background reading never pollutes saved history — but a tutor that
// forgets the lesson every time you close the window isn't a tutor, so
// Tracer conversations are real rows.

interface ConversationRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  created_at: string
}

const UNTITLED = 'New conversation'
// Long enough to tell two conversations apart in the history list, short
// enough not to wrap — the full first message is still in tracer_messages.
const MAX_TITLE_CHARS = 60

function toConversation(row: ConversationRow): TracerConversation {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}

function toMessage(row: MessageRow): TracerMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    // Anything not written by the user is Tracer — the column is only ever
    // written from the union type, so this is a narrowing cast, not a guess.
    role: row.role === 'user' ? 'user' : 'tracer',
    content: row.content,
    createdAt: row.created_at
  }
}

export function createConversation(): TracerConversation {
  const now = new Date().toISOString()
  const conversation: TracerConversation = { id: randomUUID(), title: UNTITLED, createdAt: now, updatedAt: now }
  run(
    'INSERT INTO tracer_conversations (id, title, created_at, updated_at) VALUES ($id, $title, $created, $updated)',
    { $id: conversation.id, $title: conversation.title, $created: now, $updated: now }
  )
  return conversation
}

export function getConversation(id: string): TracerConversation | null {
  const row = queryOne<ConversationRow>('SELECT * FROM tracer_conversations WHERE id = $id', { $id: id })
  return row ? toConversation(row) : null
}

export function listConversations(): TracerConversation[] {
  return queryAll<ConversationRow>('SELECT * FROM tracer_conversations ORDER BY updated_at DESC').map(toConversation)
}

/**
 * The conversation the Tracer window should resume into: the most recently
 * used one, or a fresh one if there's never been a conversation. Opening
 * Tracer should land you back in the middle of what you were discussing,
 * not on a blank slate you have to re-explain yourself to.
 */
export function getOrCreateLatestConversation(): TracerConversation {
  const row = queryOne<ConversationRow>('SELECT * FROM tracer_conversations ORDER BY updated_at DESC LIMIT 1')
  return row ? toConversation(row) : createConversation()
}

export function listMessages(conversationId: string): TracerMessage[] {
  return queryAll<MessageRow>(
    'SELECT * FROM tracer_messages WHERE conversation_id = $id ORDER BY created_at ASC',
    { $id: conversationId }
  ).map(toMessage)
}

export function addMessage(conversationId: string, role: TracerRole, content: string): TracerMessage {
  const now = new Date().toISOString()
  const message: TracerMessage = { id: randomUUID(), conversationId, role, content, createdAt: now }
  run(
    'INSERT INTO tracer_messages (id, conversation_id, role, content, created_at) VALUES ($id, $conv, $role, $content, $created)',
    { $id: message.id, $conv: conversationId, $role: role, $content: content, $created: now }
  )

  // Bump updated_at so the history list stays in real most-recent order, and
  // adopt the first user message as the title while it's still untitled.
  const isFirstUserMessage =
    role === 'user' &&
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tracer_messages WHERE conversation_id = $id AND role = 'user'",
      { $id: conversationId }
    )?.n === 1

  if (isFirstUserMessage) {
    const title = content.length > MAX_TITLE_CHARS ? `${content.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : content
    run('UPDATE tracer_conversations SET title = $title, updated_at = $updated WHERE id = $id', {
      $title: title,
      $updated: now,
      $id: conversationId
    })
  } else {
    run('UPDATE tracer_conversations SET updated_at = $updated WHERE id = $id', {
      $updated: now,
      $id: conversationId
    })
  }

  return message
}

/**
 * A finished voice call's transcript, appended to a conversation in one write.
 *
 * Not addMessage in a loop, for two reasons. Order: addMessage stamps each row
 * with `new Date()`, and rows written in one burst share a millisecond, which
 * leaves their order — this table is read ORDER BY created_at — to SQLite. And
 * cost: every run() re-serializes the whole database to disk, so a call's
 * forty turns would be forty full writes; transaction() makes it one.
 *
 * Lands in `conversationId` when it still exists, else the latest
 * conversation (the one the panel resumes into). Takes the first user turn as
 * the title while the conversation is untitled, exactly like addMessage.
 */
export function appendVoiceTranscript(
  conversationId: string | undefined,
  messages: TranscriptMessage[]
): TracerMessage[] {
  if (messages.length === 0) return []
  const conversation = (conversationId ? getConversation(conversationId) : null) ?? getOrCreateLatestConversation()
  const newest = queryOne<{ created_at: string }>(
    'SELECT created_at FROM tracer_messages WHERE conversation_id = $id ORDER BY created_at DESC LIMIT 1',
    { $id: conversation.id }
  )
  const stamps = transcriptTimestamps(newest?.created_at ?? null, Date.now(), messages.length)
  const written = messages.map(
    (m, i): TracerMessage => ({
      id: randomUUID(),
      conversationId: conversation.id,
      role: m.role,
      content: m.content,
      createdAt: stamps[i]
    })
  )
  const firstUser = written.find((m) => m.role === 'user')
  const title =
    conversation.title === UNTITLED && firstUser
      ? firstUser.content.length > MAX_TITLE_CHARS
        ? `${firstUser.content.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
        : firstUser.content
      : conversation.title

  transaction(() => {
    for (const m of written) {
      run(
        'INSERT INTO tracer_messages (id, conversation_id, role, content, created_at) VALUES ($id, $conv, $role, $content, $created)',
        { $id: m.id, $conv: m.conversationId, $role: m.role, $content: m.content, $created: m.createdAt }
      )
    }
    run('UPDATE tracer_conversations SET title = $title, updated_at = $updated WHERE id = $id', {
      $title: title,
      $updated: written[written.length - 1].createdAt,
      $id: conversation.id
    })
  })
  return written
}

/**
 * Removes the most recent user message and everything after it, returning
 * that message's text so the caller can re-ask it. Backs "Retry": a retried
 * turn should replace the answer you didn't like, not append a duplicate
 * question to the transcript — and since the whole prior conversation is
 * re-sent as history on every turn (see costGuard's history cap), leaving the
 * discarded pair in place would also feed the rejected answer back to the
 * model as context for its replacement.
 *
 * Returns null when there is no user message to retry.
 */
export function popLastExchange(conversationId: string): string | null {
  const last = queryOne<MessageRow>(
    "SELECT * FROM tracer_messages WHERE conversation_id = $id AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    { $id: conversationId }
  )
  if (!last) return null

  // `>=` on created_at rather than deleting by id: it takes the reply (and
  // any later rows) with it in one statement. Ties on the timestamp can only
  // be the same turn's own reply, which is exactly what should go too.
  run('DELETE FROM tracer_messages WHERE conversation_id = $id AND created_at >= $from', {
    $id: conversationId,
    $from: last.created_at
  })
  return last.content
}

export function deleteConversation(id: string): void {
  // Messages go with it via ON DELETE CASCADE (foreign keys are enabled in
  // db.ts's initDb).
  run('DELETE FROM tracer_conversations WHERE id = $id', { $id: id })
}
