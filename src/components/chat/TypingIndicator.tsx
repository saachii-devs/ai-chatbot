import { useEffect, useState } from 'react'
import { cn } from '../../utils/cn'
import AssistantRow from './AssistantRow'
import { ASSISTANT_BUBBLE, BUBBLE_LINE_HEIGHT } from './bubbleStyles'

// What the wait is filled with. Ordered vaguest → most specific, so the sequence
// reads as work progressing rather than a random word generator: whatever the
// model is actually doing, "reading" plausibly precedes "writing".
const PHRASES = [
  'Thinking',
  'Reading your message',
  'Gathering context',
  'Consulting the archives',
  'Connecting the dots',
  'Weighing the options',
  'Drafting a reply',
  'Choosing the right words',
]

// The last phrase is where a long wait parks. It must stay true no matter how
// long it is held, which rules out anything that implies it is nearly over.
const HOLD = 'Still working on it'

const EVERY_MS = 2200

// Cycles through PHRASES, then holds. It never wraps back to 'Thinking': a
// restarted list reads as a request that restarted.
function useWaitingPhrase(): string {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setStep((n) => (n >= PHRASES.length ? n : n + 1))
    }, EVERY_MS)
    return () => clearInterval(id)
  }, [])

  return PHRASES[step] ?? HOLD
}

// Dots and reply swap in place without a layout jump: both are an <AssistantRow>
// wrapping an ASSISTANT_BUBBLE, the same two constants.
export default function TypingIndicator() {
  const phrase = useWaitingPhrase()

  return (
    <AssistantRow className="animate-fade-in">
      {/* box-content makes the height one line box with padding added outside it;
          border-box would swallow the padding and halve the bubble's height. */}
      <span
        role="status"
        // One stable label for screen readers. The phrases are decoration — a live
        // region that re-announces "Gathering context" every 2s is not progress,
        // it is noise, so they are hidden and this says the one true thing.
        aria-label="Assistant is typing"
        className={cn(
          ASSISTANT_BUBBLE,
          BUBBLE_LINE_HEIGHT,
          'box-content flex items-center gap-2',
        )}
      >
        {/* Two spans, one animation each: `animation` is a single property, so a
            fade and a shimmer on one element would overwrite each other. Outer
            fades the new phrase in (re-keyed, so React swaps the node and the
            animation replays); inner sweeps it. */}
        <span aria-hidden="true" key={phrase} className="animate-fade-in text-sm">
          {/* bg-clip-text over transparent glyphs: the highlight travels through
              the letters, not a box behind them. motion-reduce drops it to flat grey. */}
          <span className="animate-shimmer bg-[linear-gradient(90deg,var(--color-neutral-500)_35%,var(--color-neutral-200)_50%,var(--color-neutral-500)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-neutral-400">
            {phrase}
          </span>
        </span>

        <span className="flex items-center gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:300ms]" />
        </span>
      </span>
    </AssistantRow>
  )
}
