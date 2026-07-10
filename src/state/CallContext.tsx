import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import type { CallStatus, CallTurn } from '../types'

// Voice call state, kept SEPARATE from sessions: interim transcripts update
// many times per second, so isolating them re-renders only the call UI. Turns
// live here too; the chat session gets only a duration marker after the call.

interface CallContextValue {
  status: CallStatus
  liveTranscript: string
  turns: CallTurn[]
  startedAt: number | null
  error: string | null
  setStatus: Dispatch<SetStateAction<CallStatus>>
  setLiveTranscript: Dispatch<SetStateAction<string>>
  setTurns: Dispatch<SetStateAction<CallTurn[]>>
  setStartedAt: Dispatch<SetStateAction<number | null>>
  setError: Dispatch<SetStateAction<string | null>>
}

const CallContext = createContext<CallContextValue | null>(null)

export function CallProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CallStatus>('idle')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [turns, setTurns] = useState<CallTurn[]>([])
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <CallContext.Provider
      value={{
        status,
        liveTranscript,
        turns,
        startedAt,
        error,
        setStatus,
        setLiveTranscript,
        setTurns,
        setStartedAt,
        setError,
      }}
    >
      {children}
    </CallContext.Provider>
  )
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext)
  if (!ctx) throw new Error('useCall must be used inside <CallProvider>')
  return ctx
}
