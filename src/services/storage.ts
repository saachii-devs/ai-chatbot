import type { CallTurn, ChatSession, Message } from '../types'

// All localStorage access lives here — components never touch it directly.
// Never trust what comes back out: it may be corrupt, hand-edited, or stale.

export const SESSIONS_KEY = 'ai-assistant.sessions'

const MAX_SESSIONS = 100
// localStorage is ~5MB per origin, shared with everything else; stay well
// under. Counted in UTF-16 code units, which is what the quota measures.
const MAX_CHARS = 2_000_000

export type SaveResult =
  | { ok: true; evicted: number }
  // Quota full or storage blocked (private mode). This visit works; next won't.
  | { ok: false; reason: 'quota' | 'blocked' }

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidSession)
  } catch {
    // corrupt beyond saving → start fresh rather than crash on every launch
    return []
  }
}

export function saveSessions(sessions: ChatSession[]): SaveResult {
  let candidate = pruneToLimits(sessions).kept

  // The real ceiling is whatever the browser has left, so don't reason about
  // it — write, and if it bounces, halve the history and retry.
  while (true) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(candidate))
      return { ok: true, evicted: sessions.length - candidate.length }
    } catch (err) {
      if (!isQuotaError(err)) return { ok: false, reason: 'blocked' }
      // One session that alone will not fit: nothing left to give up.
      if (candidate.length <= 1) return { ok: false, reason: 'quota' }
      candidate = dropOldestHalf(candidate)
    }
  }
}

// Halving, not one-at-a-time: a full store shouldn't cost 100 failed writes.
function dropOldestHalf(sessions: ChatSession[]): ChatSession[] {
  const doomed = new Set(
    [...sessions]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, Math.ceil(sessions.length / 2))
      .map((s) => s.id),
  )
  return sessions.filter((s) => !doomed.has(s.id))
}

// Escape hatch from a crash loop: a message that crashes the renderer is
// already persisted, so the reload re-crashes on it. ErrorBoundary offers this.
export function clearSessions(): void {
  try {
    localStorage.removeItem(SESSIONS_KEY)
  } catch {
    // storage blocked entirely — nothing to clear, and the reload is what matters
  }
}

// Bound what we write. Sessions are dropped oldest-first by last-touched time —
// never the newest, which is the one on screen.
export function pruneToLimits(
  sessions: ChatSession[],
  maxChars = MAX_CHARS,
): { kept: ChatSession[]; evicted: number } {
  if (sessions.length === 0) return { kept: sessions, evicted: 0 }

  // Newest first, so `pop()` always discards the least recently touched.
  const byRecency = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const kept = byRecency.slice(0, MAX_SESSIONS)

  while (kept.length > 1 && JSON.stringify(kept).length > maxChars) kept.pop()

  // Restore the caller's ordering for the survivors.
  const survivors = new Set(kept.map((s) => s.id))
  return {
    kept: sessions.filter((s) => survivors.has(s.id)),
    evicted: sessions.length - kept.length,
  }
}

// Reconcile what another tab wrote with what this tab holds. Incoming is the
// truth (so a delete propagates), except the active session — it may be
// mid-stream and unflushed, so it is not yanked out from under the user.
export function mergeIncoming(
  incoming: ChatSession[],
  local: ChatSession[],
  activeSessionId: string | null,
): ChatSession[] {
  if (!activeSessionId) return incoming
  if (incoming.some((s) => s.id === activeSessionId)) return incoming

  const active = local.find((s) => s.id === activeSessionId)
  return active ? [active, ...incoming] : incoming
}

// Browsers disagree on the name; both agree on the code.
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22
  )
}

function isValidSession(s: unknown): s is ChatSession {
  if (typeof s !== 'object' || s === null) return false
  const c = s as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    Array.isArray(c.messages) &&
    c.messages.every(isValidMessage)
  )
}

function isValidMessage(m: unknown): m is Message {
  if (typeof m !== 'object' || m === null) return false
  const c = m as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    (c.role === 'user' || c.role === 'assistant') &&
    typeof c.content === 'string' &&
    typeof c.createdAt === 'number' &&
    (c.status === 'sending' || c.status === 'sent' || c.status === 'failed') &&
    (c.truncated === undefined || typeof c.truncated === 'boolean') &&
    // A call marker's extra fields are read on render; an unchecked one crashes
    // the app on load — the very crash ErrorBoundary then offers to clear.
    (c.kind === undefined || c.kind === 'call') &&
    (c.durationMs === undefined || typeof c.durationMs === 'number') &&
    (c.turns === undefined || (Array.isArray(c.turns) && c.turns.every(isValidTurn)))
  )
}

function isValidTurn(t: unknown): t is CallTurn {
  if (typeof t !== 'object' || t === null) return false
  const c = t as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    (c.role === 'user' || c.role === 'assistant') &&
    typeof c.text === 'string'
  )
}
