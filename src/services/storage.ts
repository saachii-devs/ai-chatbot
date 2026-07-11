import type { CallTurn, ChatSession, Message } from '../types'

// All localStorage access lives here — components never touch it directly.
// Never trust what comes back out: it may be corrupt, hand-edited, or stale.

export const SESSIONS_KEY = 'ai-assistant.sessions'
// Ids of deleted chats — a delete has to be stated, not inferred. A session
// missing from another tab's snapshot is ambiguous: it may have been deleted, or
// that tab may simply not have seen it yet (a chat is created in memory and
// written 300ms later). Guessing wrong either resurrects a deleted chat or
// destroys a new one, so the deleting tab records the id and every tab reads it.
export const DELETED_KEY = 'ai-assistant.deleted'

const MAX_SESSIONS = 100
// Tombstones only have to outlive the tabs that could still be holding the
// session in memory, so a bounded, newest-first list is enough. Ids are random
// and never reissued, so forgetting an old one cannot cause a mix-up.
const MAX_DELETED = 500
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

export function loadDeletedIds(): string[] {
  try {
    const raw = localStorage.getItem(DELETED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    // Corrupt: the worst case of forgetting a tombstone is a deleted chat coming
    // back, which beats crashing on every launch.
    return []
  }
}

// Best-effort. If this write is lost the delete still holds in this tab; it just
// may not reach the others, which is exactly where we were before tombstones.
export function saveDeletedIds(ids: string[]): void {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(ids.slice(0, MAX_DELETED)))
  } catch {
    // quota or blocked — nothing useful to do, and the app still works
  }
}

// Newest first, deduped, bounded. Union rather than replace: two tabs can each
// delete a different chat before either sees the other's write.
export function mergeDeletedIds(incoming: string[], local: string[]): string[] {
  return [...new Set([...incoming, ...local])].slice(0, MAX_DELETED)
}

// Reconcile what another tab wrote with what this tab holds.
//
// Incoming is the truth, with one carve-out: the session open here may be
// mid-stream and not yet written, so its absence from incoming is read as "that
// tab hasn't seen it yet" and it is not yanked out from under the user.
//
// `deleted` is what makes that carve-out safe. Without it, a chat deleted in
// another tab looks identical to an unflushed new one, so this function would
// re-add it — and this tab's next save would write it back, resurrecting the
// chat in the tab that deleted it. A tombstoned id is a real delete: honor it,
// even for the active session, even mid-stream.
export function mergeIncoming(
  incoming: ChatSession[],
  local: ChatSession[],
  activeSessionId: string | null,
  deleted: ReadonlySet<string>,
): ChatSession[] {
  // The deleting tab's own save is debounced, so incoming can still contain a
  // chat that is already tombstoned.
  const alive = incoming.filter((s) => !deleted.has(s.id))

  if (!activeSessionId || deleted.has(activeSessionId)) return alive
  if (alive.some((s) => s.id === activeSessionId)) return alive

  const active = local.find((s) => s.id === activeSessionId)
  return active ? [active, ...alive] : alive
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
    // A chat with nothing in it is not worth a slot, a sidebar row, or a URL.
    // Creation is lazy so one should never reach here — this enforces it at the
    // boundary rather than trusting that. Its id goes with it, and ids are
    // random, so it is never handed out again.
    c.messages.length > 0 &&
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
    // Legacy call markers (see types/index.ts). Nothing writes them any more,
    // but old saved sessions still contain them, and their extra fields are read
    // on render — an unchecked one crashes the app on load, the very crash
    // ErrorBoundary then offers to clear.
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
