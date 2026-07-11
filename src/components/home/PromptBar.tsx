import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../hooks/useChat'
import { useVoiceCall } from '../../hooks/useVoiceCall'
import { useCall } from '../../state/CallContext'
import { useFluid } from '../../state/FluidContext'
import { useSessions } from '../../state/SessionsContext'
import { AudioLinesIcon, SendIcon, StopIcon } from '../icons'
import Button from '../ui/Button'
import Tooltip from '../ui/Tooltip'
import GradientGlow from './GradientGlow'

// Longer than this is a paste accident: unbounded it bloats the request body and the
// history trimmer drops turns to fit it.
const MAX_DRAFT_CHARS = 8_000
const COUNTER_VISIBLE_FROM = MAX_DRAFT_CHARS - 500

export default function PromptBar() {
  const [draft, setDraft] = useState('')
  const { sendMessage, stop, isLoading } = useChat()
  const { startCall, endCall, isSupported } = useVoiceCall()
  const { status: voiceStatus } = useCall()
  const { registerComposer, setPulse, emitRipple } = useFluid()
  const { state } = useSessions()
  const hasText = draft.trim().length > 0

  // One input mode at a time. The bar stays — the composer is where Stop lives
  // now — but typing is inert while the mic is open, so a half-typed draft can
  // never race an utterance to the same session.
  const voiceActive = voiceStatus !== 'idle'

  const voiceSupported = isSupported()

  const boxRef = useRef<HTMLDivElement | null>(null)
  const sendRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Focus the box on arrival and on every chat switch. preventScroll: the composer
  // travels on --settle and the browser's scroll-into-view would fight that animation.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [state.activeSessionId])

  // Anchor the bloom to the padded box (not the wrapper): it carries the border
  // radius the glow traces. Their rects coincide.
  useEffect(() => {
    registerComposer(boxRef.current)
    return () => registerComposer(null)
  }, [registerComposer])

  useEffect(() => {
    setPulse(isLoading)
  }, [isLoading, setPulse])

  const handleSend = () => {
    const text = draft.trim()
    if (!text || isLoading) return

    // Ripple from the pressed button, before the layout shifts, so the fluid looks struck at impact.
    const button = sendRef.current?.getBoundingClientRect()
    if (button) emitRipple(button.left + button.width / 2, button.top + button.height / 2)

    setDraft('') // clear the box immediately — the bubble appears optimistically
    void sendMessage(text)
  }

  return (
    <div className="relative w-full">
      <GradientGlow thinking={isLoading} boxRef={boxRef} />

      {/* rounded-full is only right while this is ONE row; stacked (below sm) the box is
          ~110px tall and a full radius eats its corners, so use a large finite radius. */}
      {/* composer-ring is the idle/focus border — an outline, so it costs no layout. */}
      <div
        ref={boxRef}
        className="composer-pad composer-ring relative flex w-full flex-col gap-2 rounded-[1.75rem] bg-neutral-900 sm:flex-row sm:items-end sm:rounded-full"
      >
        {/* Stays editable while a reply streams — only sending is held back.
            Voice is the exception: while the mic is open this is disabled
            outright, so the two input modes can never both be live. */}
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={voiceActive}
          maxLength={MAX_DRAFT_CHARS}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_DRAFT_CHARS))}
          onKeyDown={(e) => {
            // Mid-composition, Enter commits the IME candidate, not a submit —
            // sending here would cut CJK words in half.
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={voiceActive ? 'Listening — press Stop to type' : 'Ask Assistant'}
          aria-label="Message"
          // outline-none kills the always-on focus ring, so the keyboard-only ring must be
          // handed back explicitly. dvh not vh: the mobile URL bar must not push the box off-screen.
          className="field-sizing-content max-h-[40dvh] w-full resize-none overflow-y-auto rounded-lg bg-transparent px-1 pb-1 pt-0.5 text-base text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:min-w-0 sm:flex-1 sm:self-center sm:px-2 sm:pt-0"
        />

        {draft.length >= COUNTER_VISIBLE_FROM && (
          <span
            aria-live="polite"
            className={`animate-fade-in self-end pb-1.5 text-xs tabular-nums sm:self-center ${
              draft.length >= MAX_DRAFT_CHARS ? 'text-amber-400' : 'text-neutral-500'
            }`}
          >
            {draft.length.toLocaleString()}/{MAX_DRAFT_CHARS.toLocaleString()}
          </span>
        )}

        <div className="flex items-center justify-between gap-2 sm:shrink-0">
          {/* One button, two states: it starts the session and it ends it. Stop
              belongs where Start was — nowhere else on screen is there anything
              to press, because the voice interface itself has no chrome.

              The other half of "one mode at a time" is the disable: voice cannot
              start while a typed reply is still streaming, so the two can never
              both own the conversation. An unsupported browser says so rather
              than starting a session that dies on the first API call. */}
          {voiceActive ? (
            <Button
              variant="dangerSolid"
              size="text"
              onClick={endCall}
              aria-label="Stop voice"
              className="animate-fade-in"
            >
              <StopIcon className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Tooltip
              label={
                !voiceSupported
                  ? 'Voice is not supported in this browser'
                  : isLoading
                    ? 'Wait for the reply to finish'
                    : 'Start voice'
              }
            >
              <Button
                variant="pill"
                size="text"
                onClick={() => void startCall()}
                disabled={!voiceSupported || isLoading}
              >
                <AudioLinesIcon className="size-4" />
                Voice
              </Button>
            </Tooltip>
          )}

          {/* A voice turn streams through the same send path, so `isLoading` is
              true mid-reply. Don't offer the chat's stop button then: the red
              one beside it already ends the session, and two different stops
              would be two different meanings. */}
          {isLoading && !voiceActive ? (
            <Button
              variant="bare"
              onClick={stop}
              aria-label="Stop generating"
              className="animate-fade-in"
            >
              <span
                aria-hidden
                className="absolute inset-0.5 animate-spin rounded-full border-2 border-neutral-700 border-t-blue-500"
              />
              <StopIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              ref={sendRef}
              variant="primary"
              onClick={handleSend}
              disabled={!hasText || voiceActive}
              aria-label="Send message"
            >
              <SendIcon className="size-5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
