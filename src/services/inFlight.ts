// The live requests, keyed by the session they stream into.
//
// Its own module because both `useChat` (which owns sends) and `SessionsContext`
// (which learns from another tab that a chat is gone) need to abort one, and
// `useChat` already imports the context — putting this there would make a cycle.
//
// Written synchronously so two Enter presses in one tick can't both pass the
// "already sending" check the way a state read would.
const inFlight = new Map<string, AbortController>()

export function trackRequest(sessionId: string, controller: AbortController): void {
  inFlight.set(sessionId, controller)
}

export function isInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId)
}

// Only disown the controller if a later send hasn't already replaced it.
export function releaseRequest(sessionId: string, controller: AbortController): void {
  if (inFlight.get(sessionId) === controller) inFlight.delete(sessionId)
}

// Stops the reply streaming into a session. Deleting a chat calls this — here or
// in another tab — else the request keeps streaming into a session that is gone.
export function abortSession(sessionId: string): void {
  inFlight.get(sessionId)?.abort()
}
