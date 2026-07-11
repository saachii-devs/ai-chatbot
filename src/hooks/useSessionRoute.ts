import { useEffect, useRef } from 'react'
import { useSessions } from '../state/SessionsContext'

// The URL mirrors `activeSessionId` — state stays the source of truth and the
// address bar is derived from it. Nothing writes the param at the call sites, so
// every way a chat can open (a first message, a voice call, a sidebar click,
// Back) gets a URL for free.
//
// A chat with no messages has no id yet, and so no param: "New chat" only nulls
// `activeSessionId`, and the uuid is not minted until the first send.

const PARAM = 'chat'

function readParam(): string | null {
  return new URLSearchParams(window.location.search).get(PARAM)
}

// Rebuilt from the live URL so an unrelated query param or hash survives, and
// returned relative so a deployment under a base path keeps it.
function urlFor(sessionId: string | null): string {
  const url = new URL(window.location.href)
  if (sessionId) url.searchParams.set(PARAM, sessionId)
  else url.searchParams.delete(PARAM)
  return url.pathname + url.search + url.hash
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash
}

export function useSessionRoute(): void {
  const { state, dispatch } = useSessions()
  const { activeSessionId, sessions } = state

  // The popstate listener is registered once, so it would otherwise close over
  // the first render's session list forever.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // The id the page was opened with, captured during the first render — before
  // any effect can rewrite the URL. Held until the adopting dispatch lands, or
  // until it is judged dead; while it is set, the URL is ahead of state and the
  // mirror below must keep its hands off.
  const deepLink = useRef<string | null>(readParam())
  const adopted = useRef(false)

  // Resolve the opening URL. The provider's lazy initializer has already read
  // localStorage synchronously, so `sessions` is the real list by now.
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true

    const id = deepLink.current
    if (!id) return

    if (sessions.some((s) => s.id === id)) {
      dispatch({ type: 'SESSION_SELECTED', sessionId: id })
      return
    }

    // Unknown or deleted: a dead link must not leave a stale id in the address
    // bar. Clearing the ref unblocks the mirror, which would otherwise wait
    // forever for an adoption that is never coming.
    deepLink.current = null
    window.history.replaceState(null, '', urlFor(null))
    // Mount-only on purpose: this resolves the URL the page was opened with,
    // once. `adopted` makes StrictMode's second pass a no-op.
  }, [dispatch, sessions])

  // Mirror state into the URL.
  useEffect(() => {
    if (deepLink.current) {
      // Adoption landed — from here on the mirror owns the URL.
      if (deepLink.current === activeSessionId) deepLink.current = null
      // Still pending: `activeSessionId` is null only because the dispatch has
      // not rendered yet. Writing now would strip the param we are adopting.
      else return
    }

    const target = urlFor(activeSessionId)
    // Already right — including every REPLY_CHUNK re-run, and the URL that
    // popstate itself just moved us to.
    if (target === currentUrl()) return

    // The id leaving the URL no longer exists: this is a deletion, here or in
    // another tab. That entry is dead, so overwrite it rather than pushing on
    // top of it — Back must not lead to a chat that isn't there.
    const leaving = readParam()
    const dead = leaving !== null && !sessions.some((s) => s.id === leaving)

    if (dead) window.history.replaceState(null, '', target)
    else window.history.pushState(null, '', target)
  }, [activeSessionId, sessions])

  // Back/forward. The mirror's no-op guard means the dispatch below does not
  // bounce the URL straight back: by then it already reads what we want.
  useEffect(() => {
    const onPopState = () => {
      const id = readParam()
      if (!id) {
        dispatch({ type: 'SESSION_CLEARED' })
        return
      }

      if (sessionsRef.current.some((s) => s.id === id)) {
        dispatch({ type: 'SESSION_SELECTED', sessionId: id })
        return
      }

      // Visited, then deleted. Land on home and overwrite the dead entry so
      // Back doesn't walk into it again.
      dispatch({ type: 'SESSION_CLEARED' })
      window.history.replaceState(null, '', urlFor(null))
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [dispatch])
}
