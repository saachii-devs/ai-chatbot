import { useEffect, useState } from 'react'
import { useVoiceCall } from '../../hooks/useVoiceCall'
import { useCall } from '../../state/CallContext'
import type { CallStatus } from '../../types'
import { formatDuration } from '../../utils/formatDuration'
import { AudioLinesIcon } from '../icons'
import Visualizer from './Visualizer'

// The voice interface IS the chat screen while a session runs — not a panel on
// top of one. The transcript slides out of the viewport (see ChatView), leaving
// this: status at the top, the mic in the middle, and the words being said.
//
// It has no chrome and no buttons of its own. There is no card, no border, no
// backdrop — those are what made it read as a modal. Stop lives in the composer,
// where the button that started the session already was.

const STATUS_LABELS: Record<Exclude<CallStatus, 'idle'>, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  // Open but silent; once the mic hears you the bars move and the label swaps.
  listening: 'Say anything!',
  // Heard you, working on it. Without this the label would sit on "Say
  // anything!" for the whole wait, as if nothing had landed.
  thinking: 'Thinking…',
  speaking: 'Responding…',
  disconnected: 'Disconnected',
}

const LISTENING_LABEL = 'Listening…'

// The assistant's caption, lit word by word as the voice reaches it.
//
// `charIndex` is where the voice IS (word boundaries from the browser synth; the
// playback clock for a streamed MP3) — never the text arriving, since the whole
// reply exists well before it is said and would run far ahead of the voice.
//
// A word lights when the voice REACHES it — start <= charIndex — not when it
// leaves it. Waiting for the end lags a full word behind the speech, which is
// what made this feel late; and the word's end can't be trusted anyway, because
// most engines report charLength as 0.
function SpokenCaption({ text, charIndex }: { text: string; charIndex: number }) {
  const words: { word: string; start: number }[] = []
  const matcher = /\S+/g
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    words.push({ word: match[0], start: match.index })
  }

  return (
    <p
      aria-live="polite"
      className="min-h-8 text-center text-xl font-light leading-snug text-neutral-600 sm:text-2xl"
    >
      {words.map(({ word, start }, i) => (
        <span
          key={`${i}-${word}`}
          // Short, so the word arrives WITH the sound. A slow fade reintroduces
          // the very lag being fixed — the eye reads the midpoint of a fade as
          // the moment, not its beginning.
          className={`transition-colors duration-75 ${
            start <= charIndex ? 'text-neutral-50' : 'text-neutral-600'
          }`}
        >
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}

export default function VoicePanel() {
  const { status, liveTranscript, spokenText, spokenCharIndex, startedAt, error } =
    useCall()
  const { getAnalyser } = useVoiceCall()

  // Raised by the visualizer while the mic is picking up your voice.
  const [userSpeaking, setUserSpeaking] = useState(false)
  const isListening = status === 'listening'

  // Live means the mic is actually open. 'disconnected' is the beat afterwards:
  // the session is over, so the bars go with it and only the reason remains.
  const isLive = status !== 'idle' && status !== 'disconnected'

  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (startedAt === null) return
    setElapsedMs(Date.now() - startedAt)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  // pointer-events-none: nothing here is interactive, and the composer beneath
  // must stay reachable — Stop is down there.
  return (
    <div
      className="animate-fade-in pointer-events-none absolute inset-0 z-10 flex flex-col items-center pt-16"
      style={{ paddingBottom: 'calc(var(--composer-h, 0px) + 4rem)' }}
    >
      <span
        aria-live="polite"
        className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors duration-200 ${
          status === 'disconnected'
            ? 'border-red-500/30 bg-red-500/10 text-red-300'
            : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
        }`}
      >
        <AudioLinesIcon className="size-4" />
        {isListening && userSpeaking
          ? LISTENING_LABEL
          : STATUS_LABELS[status as Exclude<CallStatus, 'idle'>]}
      </span>

      {startedAt !== null && isLive && (
        <span className="mt-1.5 font-mono text-xs text-neutral-500">
          {formatDuration(elapsedMs)}
        </span>
      )}

      <div className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8 px-4">
        {/* Only while a session is actually running. */}
        {isLive && (
          <Visualizer
            getAnalyser={getAnalyser}
            // The mic is still open while the reply is being generated, so the
            // bars must keep moving — freezing them would read as "it stopped
            // hearing me", and you can still cut in during this.
            listening={isListening || status === 'thinking'}
            speaking={status === 'speaking'}
            onSpeakingChange={setUserSpeaking}
          />
        )}

        {/* One caption line, showing whoever holds the floor. The assistant's is
            lit in time with its voice; yours is the interim transcript. Neither
            is a message yet — what you finish saying, and what it finishes
            replying, become real bubbles in the transcript behind. */}
        {isLive &&
          (spokenText ? (
            <SpokenCaption text={spokenText} charIndex={spokenCharIndex} />
          ) : (
            <p
              aria-live="polite"
              className="min-h-8 text-center text-xl font-light leading-snug text-neutral-300 sm:text-2xl"
            >
              {liveTranscript || (
                <span className="text-neutral-600">
                  {status === 'connecting' ? 'Connecting…' : 'Say something…'}
                </span>
              )}
            </p>
          ))}

        {error && <p className="text-center text-sm text-red-400">{error}</p>}
      </div>
    </div>
  )
}
