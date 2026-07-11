import { useEffect } from 'react'
import { useSessions } from '../state/SessionsContext'
import {
  bindSession,
  consumeSessionAdoption,
  getBoundSessionId,
  isVoiceActive,
  teardown,
  useVoiceCall,
} from './useVoiceCall'

// The rules that end a voice session from OUTSIDE the session itself.
//
// Mounted once, in App — deliberately not in VoicePanel. The panel unmounts the
// moment the status goes idle, and a guard that unmounts along with the thing it
// guards is not a guard.

export function useVoiceGuards(): void {
  const { state } = useSessions()
  const { endCall } = useVoiceCall()
  const activeSessionId = state.activeSessionId

  // Rule 1: the user moved to a different chat. What is being said belongs to
  // the chat it was said in, so voice does not follow them across.
  useEffect(() => {
    if (!isVoiceActive()) return

    const bound = getBoundSessionId()
    if (bound === null) {
      // Started from the home screen: nothing has been said, so no session
      // exists yet.
      if (activeSessionId === null) return
      // One just appeared. Either the first utterance created it (ours — adopt
      // it) or the user picked a chat from the sidebar (a switch).
      if (consumeSessionAdoption()) {
        bindSession(activeSessionId)
        return
      }
      endCall()
      return
    }

    if (activeSessionId !== bound) endCall()
    // `endCall` is rebuilt every render, so this re-runs often — including on
    // every streamed chunk. That is fine: every branch above is a comparison
    // that no-ops when nothing moved, and `consumeSessionAdoption` only ever
    // fires once.
  }, [activeSessionId, endCall])

  // Back/forward, or a hand-edited ?chat= — the URL is a way of switching chats
  // like any other, so it ends the session too.
  //
  // The effect above would catch this anyway once useSessionRoute's dispatch
  // re-renders, but "immediately" means immediately: popstate fires before that
  // lands, so the mic closes on the navigation itself rather than a frame later.
  useEffect(() => {
    const onPopState = () => {
      if (isVoiceActive()) endCall()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [endCall])

  // The tab went to the background. Nobody talks to a page they cannot see, so a
  // mic still open here is a mic recording a room nobody meant to record — and
  // the browser's recording indicator is on a tab the user has walked away from.
  // End it; the conversation so far is already saved as messages.
  //
  // visibilitychange, not blur: blur fires for clicking the devtools or another
  // window while the page is still in view, which is not leaving.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && isVoiceActive()) endCall()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [endCall])

  // A reload or a closed tab must not leave the recording light on. `teardown`
  // is setter-free precisely so it can run with no React left to render into.
  useEffect(() => {
    window.addEventListener('pagehide', teardown)
    return () => {
      window.removeEventListener('pagehide', teardown)
      if (isVoiceActive()) teardown()
    }
  }, [])
}
