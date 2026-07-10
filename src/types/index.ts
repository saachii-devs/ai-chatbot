// Shared data shapes — the vocabulary every layer speaks.

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: 'sending' | 'sent' | 'failed'
  // The reply stopped short of its own ending. The text is real, just unfinished.
  truncated?: boolean
  // 'call' = a marker bubble ("Voice call · 2m 34s"), not a real chat turn.
  kind?: 'call'
  durationMs?: number
  // Only on call markers: the conversation during the call, so it can be expanded.
  turns?: CallTurn[]
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

// A failure belongs to the chat it happened in, not to the app.
export interface SessionError {
  message: string
  // Epoch ms before which a retry cannot succeed (from a 429's Retry-After).
  // Null when retrying is allowed immediately.
  retryAt: number | null
}

export interface SessionsState {
  sessions: ChatSession[]
  activeSessionId: string | null
  // "Loading" is per-session, not per-app, so a reply in one chat does not
  // freeze the composer in another; more than one can be true at a time.
  loadingSessionIds: string[]
  // Keyed by session id. The banner shows only the active chat's error.
  errors: Record<string, SessionError>
  // Set when chats have stopped being persisted (quota full, storage blocked).
  // The app still works; this visit is just all there is.
  storageWarning: string | null
}

// Finite state machine: exactly one status at a time, so impossible combinations
// ("listening AND speaking") are unrepresentable.
export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'listening'
  | 'speaking'
  | 'disconnected'

// One line of the in-call transcript. Lives ONLY in the call overlay; the chat
// session receives just a duration marker after the call ends.
export interface CallTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
}
