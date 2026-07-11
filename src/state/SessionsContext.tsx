import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react'
import { abortSession } from '../services/inFlight'
import {
  DELETED_KEY,
  loadDeletedIds,
  loadSessions,
  mergeDeletedIds,
  mergeIncoming,
  saveDeletedIds,
  saveSessions,
  SESSIONS_KEY,
} from '../services/storage'
import type { ChatSession, SessionsState } from '../types'
import { initialState, sessionsReducer, type SessionsAction } from './sessionsReducer'

// Owns the sessions state and shares {state, dispatch} with the tree below.

interface SessionsContextValue {
  state: SessionsState
  dispatch: Dispatch<SessionsAction>
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  // Lazy initializer: read localStorage exactly once at startup.
  const [state, dispatch] = useReducer(sessionsReducer, undefined, () => ({
    ...initialState,
    sessions: loadSessions(),
    deletedIds: loadDeletedIds(),
  }))

  // The storage listener is registered once; without this ref it would close
  // over the first render's state forever.
  const stateRef = useRef(state)
  stateRef.current = state

  // Last value committed to storage: skips no-op writes and stops the ping-pong
  // where adopting another tab's write triggers a write back.
  const lastWritten = useRef<string | null>(null)

  // Debounced save: streaming mutates on every chunk, so wait for 300ms of
  // quiet before writing.
  useEffect(() => {
    const timer = setTimeout(() => {
      const json = JSON.stringify(state.sessions)
      if (json === lastWritten.current) return

      const result = saveSessions(state.sessions)
      if (result.ok) {
        lastWritten.current = json
        dispatch({ type: 'STORAGE_WARNING_CLEARED' })
        return
      }

      // Warn on failure, or the user closes the tab believing the chat saved.
      dispatch({
        type: 'STORAGE_WARNING_SET',
        message:
          result.reason === 'quota'
            ? 'Storage is full — this chat will be lost on reload.'
            : "This browser is blocking storage — chats won't survive a reload.",
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [state.sessions])

  // Tombstones are written immediately, not on the sessions debounce. A delete
  // has to reach the other tabs BEFORE the rewritten session list does, or for
  // those 300ms they see the chat still present and cannot tell it is doomed.
  const lastWrittenDeleted = useRef<string | null>(null)
  useEffect(() => {
    const json = JSON.stringify(state.deletedIds)
    if (json === lastWrittenDeleted.current) return
    lastWrittenDeleted.current = json
    saveDeletedIds(state.deletedIds)
  }, [state.deletedIds])

  // Another tab saved: merge it, or the last writer silently erases the other.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // key === null means the whole store was cleared. Either key matters: a
      // delete announces itself on DELETED_KEY first.
      if (
        event.key !== SESSIONS_KEY &&
        event.key !== DELETED_KEY &&
        event.key !== null
      ) {
        return
      }

      const deletedIds = mergeDeletedIds(loadDeletedIds(), stateRef.current.deletedIds)
      const deleted = new Set(deletedIds)

      // A reply may still be streaming into a chat that another tab just
      // deleted. Dropping it from state does not stop the request — this does.
      for (const id of stateRef.current.loadingSessionIds) {
        if (deleted.has(id)) abortSession(id)
      }

      const merged: ChatSession[] = mergeIncoming(
        loadSessions(),
        stateRef.current.sessions,
        stateRef.current.activeSessionId,
        deleted,
      )
      // Adopting another tab's write must not trigger a write back.
      lastWritten.current = JSON.stringify(merged)
      lastWrittenDeleted.current = JSON.stringify(deletedIds)
      saveDeletedIds(deletedIds)

      dispatch({ type: 'SESSIONS_SYNCED', sessions: merged, deletedIds })
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return (
    <SessionsContext.Provider value={{ state, dispatch }}>
      {children}
    </SessionsContext.Provider>
  )
}

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used inside <SessionsProvider>')
  return ctx
}

// Derived once here so the find() isn't copy-pasted into every component.
export function useActiveSession(): ChatSession | null {
  const { state } = useSessions()
  return state.sessions.find((s) => s.id === state.activeSessionId) ?? null
}
