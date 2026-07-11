import type { ChatSession, Message, SessionError, SessionsState } from '../types'

// Every event that can change session state; a discriminated union on `type`.
export type SessionsAction =
  | { type: 'SESSION_CREATED'; session: ChatSession }
  | { type: 'SESSION_SELECTED'; sessionId: string }
  | { type: 'SESSION_CLEARED' }
  | { type: 'SESSION_DELETED'; sessionId: string }
  | {
      type: 'SEND_STARTED'
      sessionId: string
      userMessage: Message
      assistantMessageId: string
    }
  | { type: 'REPLY_CHUNK'; sessionId: string; messageId: string; chunk: string }
  | {
      type: 'REPLY_DONE'
      sessionId: string
      userMessageId: string
      assistantMessageId: string
      // Model hit its token ceiling: keep the text, mark it unfinished.
      truncated: boolean
    }
  | {
      type: 'REQUEST_FAILED'
      sessionId: string
      userMessageId: string
      assistantMessageId: string
      errorMessage: string
      // Epoch ms before which retrying is pointless (from Retry-After).
      retryAt?: number
    }
  | {
      type: 'REPLY_CANCELED'
      sessionId: string
      userMessageId: string
      assistantMessageId: string
    }
  // Rewinds to just before `messageId`, dropping it and everything after; retry
  // uses it to take back the partial reply of the failed turn.
  | { type: 'MESSAGES_REWOUND'; sessionId: string; messageId: string }
  // A voice session begins: drop a header into the transcript that the spoken
  // turns then appear beneath. Its duration isn't known yet — CALL_ENDED fills
  // it in when the session stops.
  | { type: 'CALL_STARTED'; sessionId: string; message: Message }
  | {
      type: 'CALL_ENDED'
      sessionId: string
      messageId: string
      durationMs: number
      content: string
    }
  | { type: 'ERROR_DISMISSED'; sessionId: string }
  // Another tab wrote to localStorage; adopt what it saved. `deletedIds` is the
  // union of both tabs' tombstones — see storage.mergeIncoming.
  | { type: 'SESSIONS_SYNCED'; sessions: ChatSession[]; deletedIds: string[] }
  // A save failed, or started succeeding again.
  | { type: 'STORAGE_WARNING_SET'; message: string }
  | { type: 'STORAGE_WARNING_CLEARED' }

export const initialState: SessionsState = {
  sessions: [],
  activeSessionId: null, // null = no chat open → App shows HomeView
  deletedIds: [],
  loadingSessionIds: [],
  errors: {},
  storageWarning: null,
}

// Tombstones are bounded and newest-first; see storage.MAX_DELETED for why
// forgetting the oldest is safe.
const MAX_DELETED = 500

// Replace one session with a transformed copy (immutably).
function updateSession(
  state: SessionsState,
  sessionId: string,
  transform: (session: ChatSession) => ChatSession,
): SessionsState {
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? transform(s) : s)),
  }
}

// Marks a session as streaming, or no longer streaming.
function setLoading(state: SessionsState, sessionId: string, loading: boolean): string[] {
  const without = state.loadingSessionIds.filter((id) => id !== sessionId)
  return loading ? [...without, sessionId] : without
}

// Drops one session's error without disturbing anyone else's.
function withoutError(
  errors: Record<string, SessionError>,
  sessionId: string,
): Record<string, SessionError> {
  if (!(sessionId in errors)) return errors
  const next = { ...errors }
  delete next[sessionId]
  return next
}

// First user message becomes the session title, trimmed to ~40 chars.
function makeTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length <= 40 ? clean : `${clean.slice(0, 40).trimEnd()}…`
}

export function sessionsReducer(
  state: SessionsState,
  action: SessionsAction,
): SessionsState {
  switch (action.type) {
    case 'SESSION_CREATED':
      return {
        ...state,
        sessions: [action.session, ...state.sessions],
        activeSessionId: action.session.id, // creating = opening
      }

    case 'SESSION_SELECTED':
      // Switch chats by changing one id; a session's error and spinner stay with
      // it rather than being cleared on the way out.
      return { ...state, activeSessionId: action.sessionId }

    case 'SESSION_CLEARED':
      // "New chat" — no empty session is created until the first message.
      return { ...state, activeSessionId: null }

    case 'SESSION_DELETED':
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.sessionId),
        // Say so out loud, or another tab holding this chat cannot tell the
        // delete from a snapshot that simply predates it — and would write the
        // chat back.
        deletedIds: [action.sessionId, ...state.deletedIds].slice(0, MAX_DELETED),
        // Deleting the OPEN chat resets to null (→ HomeView) so it can't point
        // at a ghost.
        activeSessionId:
          state.activeSessionId === action.sessionId
            ? null
            : state.activeSessionId,
        // Caller aborts the request; this just forgets the bookkeeping so a
        // deleted chat can't leave a spinner running forever.
        loadingSessionIds: setLoading(state, action.sessionId, false),
        errors: withoutError(state.errors, action.sessionId),
      }

    case 'SEND_STARTED': {
      // Optimistic UI: the user bubble plus an empty assistant bubble (the
      // streaming target) appear before any network happens.
      const next = updateSession(state, action.sessionId, (s) => ({
        ...s,
        title: s.messages.length === 0 ? makeTitle(action.userMessage.content) : s.title,
        updatedAt: action.userMessage.createdAt,
        messages: [
          ...s.messages,
          action.userMessage,
          {
            id: action.assistantMessageId,
            role: 'assistant',
            content: '',
            createdAt: action.userMessage.createdAt,
            status: 'sent',
          },
        ],
      }))
      return {
        ...next,
        loadingSessionIds: setLoading(state, action.sessionId, true),
        errors: withoutError(state.errors, action.sessionId),
      }
    }

    case 'REPLY_CHUNK':
      return updateSession(state, action.sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === action.messageId ? { ...m, content: m.content + action.chunk } : m,
        ),
      }))

    case 'REPLY_DONE': {
      const next = updateSession(state, action.sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: s.messages.map((m) => {
          if (m.id === action.userMessageId) return { ...m, status: 'sent' as const }
          if (m.id === action.assistantMessageId && action.truncated) {
            return { ...m, truncated: true }
          }
          return m
        }),
      }))
      return { ...next, loadingSessionIds: setLoading(state, action.sessionId, false) }
    }

    case 'REQUEST_FAILED': {
      const next = updateSession(state, action.sessionId, (s) => ({
        ...s,
        messages: s.messages
          // Keep any streamed text; drop only an empty stub that got no token.
          .filter((m) => !(m.id === action.assistantMessageId && m.content === ''))
          .map((m) => {
            if (m.id === action.userMessageId) return { ...m, status: 'failed' as const }
            if (m.id === action.assistantMessageId) return { ...m, truncated: true }
            return m
          }),
      }))
      return {
        ...next,
        loadingSessionIds: setLoading(state, action.sessionId, false),
        errors: {
          ...state.errors,
          [action.sessionId]: {
            message: action.errorMessage,
            retryAt: action.retryAt ?? null,
          },
        },
      }
    }

    case 'REPLY_CANCELED': {
      // Stopping is not failing: the user message stands as sent and streamed
      // text is kept; only an empty stub is dropped.
      const next = updateSession(state, action.sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: s.messages
          .filter((m) => !(m.id === action.assistantMessageId && m.content === ''))
          .map((m) => {
            if (m.id === action.userMessageId) return { ...m, status: 'sent' as const }
            if (m.id === action.assistantMessageId) return { ...m, truncated: true }
            return m
          }),
      }))
      return {
        ...next,
        loadingSessionIds: setLoading(state, action.sessionId, false),
        errors: withoutError(state.errors, action.sessionId),
      }
    }

    case 'MESSAGES_REWOUND':
      return updateSession(state, action.sessionId, (s) => {
        const cut = s.messages.findIndex((m) => m.id === action.messageId)
        return cut === -1 ? s : { ...s, messages: s.messages.slice(0, cut) }
      })

    case 'CALL_STARTED':
      // Appended, not nested: everything said during the call follows it as
      // ordinary messages. The marker is a heading for them, not a container.
      return updateSession(state, action.sessionId, (s) => ({
        ...s,
        // A call started from the home screen titles the chat, since no typed
        // message will ever get the chance to.
        title: s.messages.length === 0 ? 'Voice call' : s.title,
        updatedAt: action.message.createdAt,
        messages: [...s.messages, action.message],
      }))

    case 'CALL_ENDED':
      // The header was written before the duration existed; stamp it now.
      return updateSession(state, action.sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === action.messageId
            ? { ...m, content: action.content, durationMs: action.durationMs }
            : m,
        ),
      }))

    case 'ERROR_DISMISSED':
      return { ...state, errors: withoutError(state.errors, action.sessionId) }

    case 'SESSIONS_SYNCED': {
      // The other tab's write wins, except the session open here may be
      // mid-stream and is never yanked away — unless it was deleted, which is
      // the one absence that is unambiguous (see storage.mergeIncoming).
      const sessions = action.sessions
      const alive = new Set(sessions.map((s) => s.id))
      const stillOpen = sessions.some((s) => s.id === state.activeSessionId)

      // Drop errors/spinners for chats that no longer exist — unreachable state.
      const errors = Object.fromEntries(
        Object.entries(state.errors).filter(([id]) => alive.has(id)),
      )
      return {
        ...state,
        sessions,
        deletedIds: action.deletedIds,
        // The open chat was deleted elsewhere → null → App falls back to
        // HomeView, and useSessionRoute strips ?chat= from the URL.
        activeSessionId: stillOpen ? state.activeSessionId : null,
        loadingSessionIds: state.loadingSessionIds.filter((id) => alive.has(id)),
        errors,
      }
    }

    case 'STORAGE_WARNING_SET':
      return { ...state, storageWarning: action.message }

    case 'STORAGE_WARNING_CLEARED':
      return { ...state, storageWarning: null }
  }
}
