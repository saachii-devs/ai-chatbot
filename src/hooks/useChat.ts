import { ChatServiceError, type ReplyOutcome } from '../services/chatService'
import {
  abortSession,
  isInFlight,
  releaseRequest,
  trackRequest,
} from '../services/inFlight'
import { chatService } from '../services/providers'
import { useSessions } from '../state/SessionsContext'
import type { ChatSession, Message } from '../types'
import { uuid } from '../utils/uuid'

// Bridges components and the network-only chat service:
// optimistic send → stream chunks into state → settle success, stop, or failure.
// The in-flight controllers live in ../services/inFlight, shared with the tab-sync
// path that has to abort a stream when another tab deletes the chat.

// A send whose session doesn't exist yet, so has no id to key by. Only one can
// exist: a second same-tick Enter still sees activeSessionId === null.
let creatingSession = false

function toFriendlyMessage(err: unknown): string {
  if (err instanceof ChatServiceError) {
    switch (err.kind) {
      case 'missing_key':
        return 'API key is missing — add VITE_CHAT_API_KEY to your .env file and restart the dev server.'
      case 'bad_key':
        return 'API key is invalid — check VITE_CHAT_API_KEY in your .env file.'
      case 'rate_limited':
        return err.retryAfterMs
          ? `Too many requests — retry in ${Math.ceil(err.retryAfterMs / 1000)}s.`
          : 'Too many requests — wait a moment and retry.'
      case 'network':
        return "Couldn't reach the AI service — check your connection."
      case 'timeout':
        return 'The AI service stopped responding — try again.'
      case 'truncated':
        return 'The connection dropped before the reply finished.'
      case 'empty_reply':
        return 'The AI returned an empty reply — try again.'
      case 'context_too_long':
        // Trimming runs every send, so reaching here means one message is itself
        // too big — retrying can't help.
        return 'This conversation is too long for the model — start a new chat.'
      case 'bad_request':
        return err.detail
          ? `The AI service rejected the request: ${err.detail}`
          : 'The AI service rejected the request.'
      case 'server_error':
        return 'The AI service had a problem — try again.'
      case 'canceled':
        // Never reaches the banner: sendMessage settles a stop before here.
        return ''
    }
  }
  return 'Something went wrong — try again.'
}

export function useChat() {
  const { state, dispatch } = useSessions()

  const activeSessionId = state.activeSessionId
  // Loading and errors are per-session, so this hook always reports the on-screen
  // chat, never one streaming in the background.
  const isLoading = activeSessionId
    ? state.loadingSessionIds.includes(activeSessionId)
    : false
  const activeError = activeSessionId ? (state.errors[activeSessionId] ?? null) : null

  // Resolves with the complete reply text (or text so far if stopped), null on
  // failure/no-op.
  //
  // Every option here exists because `state` is a render-old closure, and a caller
  // may know something it cannot see yet:
  //  - `sessionId`: send into THIS chat, whatever the closure thinks is active.
  //    Voice passes the session it bound to; without it, a closure that predates
  //    the session's own SESSION_CREATED would mint a second one and strand the
  //    reply in a chat nobody is looking at.
  //  - `priorMessages`: retry's history, blind to a just-dispatched rewind.
  //  - `onChunk`: fired per token, so a caller can time the FIRST one rather than
  //    the whole stream (voice's reply watchdog — see useVoiceCall).
  async function sendMessage(
    text: string,
    opts?: {
      sessionId?: string
      priorMessages?: Message[]
      onChunk?: (chunk: string) => void
    },
  ): Promise<string | null> {
    const trimmed = text.trim()
    if (!trimmed) return null

    // Synchronous through `trackRequest` so a second same-tick call sees these guards.
    let sessionId = opts?.sessionId ?? state.activeSessionId
    const active = state.sessions.find((s) => s.id === sessionId)
    if (sessionId && isInFlight(sessionId)) return null
    if (!sessionId && creatingSession) return null

    // Lazy session creation: sending from HomeView makes the chat exist.
    //
    // An explicit sessionId is TRUSTED — it is not checked against `active`. The
    // caller that passed it created that session moments ago, so a render-old
    // `state.sessions` may not list it yet; creating another because we cannot
    // see it is the very bug the parameter exists to prevent.
    let priorMessages: Message[] = opts?.priorMessages ?? active?.messages ?? []
    let created = false
    if (!sessionId || (!active && !opts?.sessionId)) {
      const session: ChatSession = {
        id: uuid(),
        title: 'New chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      }
      creatingSession = true
      created = true
      dispatch({ type: 'SESSION_CREATED', session })
      sessionId = session.id
      priorMessages = []
    }

    const controller = new AbortController()
    trackRequest(sessionId, controller)

    const userMessage: Message = {
      id: uuid(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      status: 'sending',
    }
    const assistantMessageId = uuid()
    dispatch({ type: 'SEND_STARTED', sessionId, userMessage, assistantMessageId })

    // Outside the try so a stop mid-stream can still return what arrived.
    let reply = ''
    try {
      // REST is stateless: resend the whole history every send. Filter out failed
      // sends, empty streaming stubs, and call markers — not part of the conversation.
      const history = [
        ...priorMessages.filter((m) => m.status === 'sent' && m.content !== '' && !m.kind),
        userMessage,
      ]
      // Iterated by hand because the reply's ending matters: the generator returns
      // how it finished, and `for await` discards that.
      const stream = chatService.sendMessage(history, controller.signal)
      let outcome: ReplyOutcome = { truncated: false }
      while (true) {
        const next = await stream.next()
        if (next.done) {
          outcome = next.value
          break
        }
        reply += next.value
        opts?.onChunk?.(next.value)
        dispatch({
          type: 'REPLY_CHUNK',
          sessionId,
          messageId: assistantMessageId,
          chunk: next.value,
        })
      }
      dispatch({
        type: 'REPLY_DONE',
        sessionId,
        userMessageId: userMessage.id,
        assistantMessageId,
        truncated: outcome.truncated,
      })
      return reply
    } catch (err) {
      if (err instanceof ChatServiceError && err.kind === 'canceled') {
        dispatch({
          type: 'REPLY_CANCELED',
          sessionId,
          userMessageId: userMessage.id,
          assistantMessageId,
        })
        return reply || null
      }
      const retryAfterMs =
        err instanceof ChatServiceError ? err.retryAfterMs : undefined
      dispatch({
        type: 'REQUEST_FAILED',
        sessionId,
        userMessageId: userMessage.id,
        assistantMessageId,
        errorMessage: toFriendlyMessage(err),
        retryAt: retryAfterMs ? Date.now() + retryAfterMs : undefined,
      })
      return null
    } finally {
      releaseRequest(sessionId, controller)
      if (created) creatingSession = false
    }
  }

  function stop(): void {
    if (activeSessionId) abortSession(activeSessionId)
  }

  // Re-sends the most recent failed message. The banner only shows the active
  // chat's error, so the retried failure is the one the user is looking at.
  function retry(): void {
    const active = state.sessions.find((s) => s.id === activeSessionId)
    if (!active) return
    const cut = active.messages.findLastIndex(
      (m) => m.role === 'user' && m.status === 'failed',
    )
    if (cut === -1) return
    const failed = active.messages[cut]
    // Rewind past the failed turn AND its partial reply — resending with the half
    // answer in history would show the model its own stump.
    dispatch({ type: 'MESSAGES_REWOUND', sessionId: active.id, messageId: failed.id })
    dispatch({ type: 'ERROR_DISMISSED', sessionId: active.id })
    void sendMessage(failed.content, {
      sessionId: active.id,
      priorMessages: active.messages.slice(0, cut),
    })
  }

  function dismissError(): void {
    if (activeSessionId) dispatch({ type: 'ERROR_DISMISSED', sessionId: activeSessionId })
  }

  return {
    sendMessage,
    stop,
    retry,
    dismissError,
    isLoading,
    error: activeError?.message ?? null,
    retryAt: activeError?.retryAt ?? null,
  }
}
