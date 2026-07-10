import { useEffect, useRef, useState } from 'react'
import { useTypewriter } from '../../hooks/useTypewriter'
import { useVoiceCall } from '../../hooks/useVoiceCall'
import { useCall } from '../../state/CallContext'
import type { CallStatus } from '../../types'
import { formatDuration } from '../../utils/formatDuration'
import { AudioLinesIcon } from '../icons'
import Visualizer from './Visualizer'

const STATUS_LABELS: Record<Exclude<CallStatus, 'idle'>, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  // Open but silent; once the mic hears you the bars move and the label swaps to LISTENING_LABEL.
  listening: 'Say anything!',
  speaking: 'Speaking',
  disconnected: 'Disconnected',
}

const LISTENING_LABEL = 'Listening…'

// Sits on the baseline and grows upward like a text cursor; align-middle would drift
// on lines taller than the letters. The negative vertical-align dips it just under the baseline.
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="animate-caret-blink ml-0.5 inline-block h-[0.9em] w-[2px] rounded-full bg-blue-400 align-[-0.06em]"
    />
  )
}

export default function CallOverlay() {
  const { status, liveTranscript, turns, startedAt, error } = useCall()
  const { endCall, getAnalyser } = useVoiceCall()

  // Raised by the visualizer while the mic is picking up your voice.
  const [userSpeaking, setUserSpeaking] = useState(false)
  const isListening = status === 'listening'

  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (startedAt === null) return
    setElapsedMs(Date.now() - startedAt)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  // Only the latest exchange is shown — the full history is what the chat is for.
  let lastUserAt = -1
  let lastAssistantAt = -1
  turns.forEach((turn, i) => {
    if (turn.role === 'user') lastUserAt = i
    else lastAssistantAt = i
  })
  const lastUser = turns[lastUserAt]
  const lastAssistant = turns[lastAssistantAt]

  // Interim speech beats the settled turn: it is what you are saying right now.
  const userText = liveTranscript || lastUser?.text || ''
  const assistantText = lastAssistant?.text ?? ''

  // Which line is newer, so the pair reads as a flow. Live speech is by definition newest.
  const userIsNewer = Boolean(liveTranscript) || lastUserAt > lastAssistantAt

  const userShown = useTypewriter(userText, 14)
  const assistantShown = useTypewriter(assistantText, 18)

  // Exactly one caret, on whichever line is currently being written.
  const userTyping = Boolean(liveTranscript) || userShown.length < userText.length
  const assistantTyping = !userTyping && (status === 'speaking' || assistantShown.length < assistantText.length)

  const idle = !userText && !assistantText && !error
  const isDisconnected = status === 'disconnected'

  // Keep the newest streaming line pinned to the bottom as it grows. mt-auto lets the top
  // scroll into view, but an overflowing container won't follow growing content on its own.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [userShown, assistantShown])

  // The user line, receded: hierarchy between the two is carried by colour, not weight.
  const userLine = userText ? (
    <p className="break-words text-2xl font-light leading-snug text-neutral-500 sm:text-3xl">
      {userShown}
      {userTyping && <Caret />}
    </p>
  ) : null

  const assistantLine = assistantText ? (
    <p className="break-words text-2xl font-normal leading-snug text-neutral-50 sm:text-3xl">
      {assistantShown}
      {assistantTyping && <Caret />}
    </p>
  ) : null

  return (
    <div className="animate-fade-in fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="animate-scale-in flex h-[85dvh] w-full max-w-2xl flex-col rounded-3xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <span
            aria-live="polite"
            className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors duration-200 ${
              isDisconnected
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
            }`}
          >
            <AudioLinesIcon className="size-4" />
            {isListening && userSpeaking
              ? LISTENING_LABEL
              : STATUS_LABELS[status as Exclude<CallStatus, 'idle'>]}
          </span>
          {startedAt !== null && (
            <span className="font-mono text-xs text-neutral-500">{formatDuration(elapsedMs)}</span>
          )}
        </div>

        {/* The exchange, anchored to the bottom so a growing reply pushes the question up.
            mt-auto (not justify-end on the scroller) keeps short content at the bottom while
            still letting the top line scroll into view once the pair overflows — justify-end
            would clip the top and make it unreachable. */}
        <div
          ref={scrollRef}
          aria-live="polite"
          className="flex flex-1 flex-col overflow-y-auto px-2 py-8 text-center"
        >
          <div className="mt-auto flex flex-col gap-4">
            {idle && (
              <p className="text-center text-sm text-neutral-500">
                {status === 'connecting'
                  ? 'Connecting…'
                  : 'Say something — the conversation will appear here.'}
              </p>
            )}

            {/* Chronological in the DOM, not just on screen: this is an aria-live region, so
                a CSS-only reorder would announce the exchange backwards. */}
            {userIsNewer ? (
              <>
                {assistantLine}
                {userLine}
              </>
            ) : (
              <>
                {userLine}
                {assistantLine}
              </>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        </div>

        <Visualizer
          getAnalyser={getAnalyser}
          listening={isListening}
          speaking={status === 'speaking'}
          onSpeakingChange={setUserSpeaking}
        />

        <button
          type="button"
          onClick={endCall}
          className="mx-auto mt-4 min-h-11 shrink-0 rounded-full bg-red-600 px-10 text-sm font-medium text-white transition duration-150 ease-out hover:bg-red-500 active:scale-[0.98]"
        >
          {error ? 'Close' : 'Disconnect'}
        </button>
      </div>
    </div>
  )
}
