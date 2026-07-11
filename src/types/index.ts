// Shared data shapes — the vocabulary every layer speaks.

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: 'sending' | 'sent' | 'failed'
  // The reply stopped short of its own ending. The text is real, just unfinished.
  // Set both when the user hits Stop and when they talk over a spoken reply.
  truncated?: boolean

  // 'call' = the "Voice call · 2m 34s" header a voice session leaves in the
  // transcript. Everything said during that session follows it as ordinary
  // user/assistant messages — the marker introduces them, it does not contain
  // them.
  kind?: 'call'
  durationMs?: number

  // LEGACY — read, never written. Voice used to be a self-contained call whose
  // whole transcript was nested inside the marker, unfolding on click. It now
  // writes real messages instead, so nothing fills this any more. It stays so
  // calls saved by the old build still deserialize and render their transcript
  // (see MessageBubble.CallMarker). Deleting it silently corrupts that history.
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
  // Ids of deleted chats, newest first. A delete has to be recorded, not
  // inferred: to another tab, a chat that was deleted and a chat it simply
  // hasn't seen yet look the same. Ids are random and never reissued, so this
  // list only has to outlive the tabs that might still hold the session.
  deletedIds: string[]
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
  // Heard you, now generating the reply. The mic stays open (you can still cut
  // in), but without this the UI would sit on "Say anything!" through the whole
  // wait, as if nothing had been heard.
  | 'thinking'
  | 'speaking'
  | 'disconnected'

// LEGACY, alongside Message.turns — one line of an old call's nested transcript.
// Nothing writes these now that voice speaks in ordinary messages; kept so old
// saved sessions still load.
export interface CallTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
}
