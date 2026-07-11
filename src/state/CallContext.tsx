import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import type { CallStatus } from '../types'

// Voice session state, kept SEPARATE from sessions — but only what is genuinely
// not a chat message. The spoken exchange itself now lives in the session as
// ordinary messages; the voice UI holds no copy of it.
//
// `liveTranscript` is the exception, and the reason this context still exists:
// an interim utterance is not yet a message (it becomes one at onFinal), and it
// changes many times a second. Routing that through sessionsReducer would
// re-render the whole chat and write half-spoken words to localStorage.

interface CallContextValue {
  status: CallStatus
  liveTranscript: string
  // What the assistant is saying aloud right now, and WHERE IN IT the voice
  // currently is (a character index, not a count of characters finished — see
  // SpeechProgress). The reply text is complete long before it is spoken, so the
  // caption is drawn from the speech engine's own progress, not from the text
  // arriving.
  spokenText: string
  spokenCharIndex: number
  // Also the "did we ever connect" flag the disconnect tone reads.
  startedAt: number | null
  error: string | null
  setStatus: Dispatch<SetStateAction<CallStatus>>
  setLiveTranscript: Dispatch<SetStateAction<string>>
  setSpokenText: Dispatch<SetStateAction<string>>
  setSpokenCharIndex: Dispatch<SetStateAction<number>>
  setStartedAt: Dispatch<SetStateAction<number | null>>
  setError: Dispatch<SetStateAction<string | null>>
}

const CallContext = createContext<CallContextValue | null>(null)

export function CallProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CallStatus>('idle')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [spokenText, setSpokenText] = useState('')
  const [spokenCharIndex, setSpokenCharIndex] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <CallContext.Provider
      value={{
        status,
        liveTranscript,
        spokenText,
        spokenCharIndex,
        startedAt,
        error,
        setStatus,
        setLiveTranscript,
        setSpokenText,
        setSpokenCharIndex,
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
