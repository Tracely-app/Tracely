import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type {
  TracerGetConversationResponse,
  TracerNewConversationResponse,
  TracerSendResponse
} from '@shared/ipc-contract'
import { isServerConfigured } from '../services/ai/client'
import { MAX_TRACER_MESSAGE_CHARS } from '../services/ai/costGuard'
import { askTracer, currentContext } from '../services/ai/tracer'
import { getLatestDocument } from '../services/storage/documentsRepo'
import {
  addMessage,
  createConversation,
  getConversation,
  getOrCreateLatestConversation,
  listMessages
} from '../services/storage/tracerRepo'

/**
 * The chat behind Home's "Chat with Tracer".
 *
 * A quarter of what the removed version had: no window to open or close, no
 * conversation list, no retry. Those existed for a separate `BrowserWindow`
 * with its own history sidebar; the panel this drives lives inside the main
 * window and shows one conversation. The channels and response shapes are the
 * ones already in `shared/` — that file is additive, and the old ones fit.
 */

const sendSchema = z.object({
  conversationId: z.string(),
  message: z.string().min(1).max(MAX_TRACER_MESSAGE_CHARS)
})
const getSchema = z.object({ conversationId: z.string().optional() })

/**
 * `TracerContext` in the shape the contract already defines, filled from the
 * draft rather than from Screen Watch. `claims` is empty and `processName` null
 * on purpose: nothing here is reading another application, and inventing a
 * process name to fill a field would be a lie the UI could show.
 */
function contextPayload(): TracerGetConversationResponse['context'] {
  return { processName: null, documentText: currentContext(), claims: [] }
}

/** One turn: store the question, ask, store the reply. */
async function runTurn(conversationId: string, message: string): Promise<TracerSendResponse> {
  // History is read BEFORE the new message is stored — otherwise the question
  // being asked would also appear in the history sent alongside it, and the
  // model would see it twice.
  const history = listMessages(conversationId)
  const userMessage = addMessage(conversationId, 'user', message)

  // The user's message stays saved even when the reply fails. It is their
  // writing; dropping it would mean retyping the question. The renderer shows
  // the error against the message that is already on screen.
  const { reply } = await askTracer(message, history, currentContext())
  return { userMessage, reply: addMessage(conversationId, 'tracer', reply) }
}

export function registerTracerHandlers(): void {
  ipcMain.handle(IPC.TRACER_GET_CONVERSATION, (_event, raw): TracerGetConversationResponse => {
    const { conversationId } = getSchema.parse(raw)
    const conversation = conversationId
      ? getConversation(conversationId) ?? getOrCreateLatestConversation()
      : getOrCreateLatestConversation()

    return {
      conversation,
      messages: listMessages(conversation.id),
      context: contextPayload(),
      serverConfigured: isServerConfigured(),
      focusedClaimId: null,
      focusedPrompt: null
    }
  })

  ipcMain.handle(IPC.TRACER_SEND, async (_event, raw): Promise<TracerSendResponse> => {
    const { conversationId, message } = sendSchema.parse(raw)
    return await runTurn(conversationId, message)
  })

  ipcMain.handle(IPC.TRACER_NEW_CONVERSATION, (): TracerNewConversationResponse => {
    return { conversation: createConversation() }
  })
}

/**
 * The draft's title, for the panel's opening line.
 *
 * Exported here rather than reached for from the renderer because the renderer
 * has no business reading the documents table directly — and because "there is
 * no draft yet" is a real answer the greeting has to handle.
 */
export function latestDraftTitle(): string | null {
  return getLatestDocument()?.title ?? null
}
