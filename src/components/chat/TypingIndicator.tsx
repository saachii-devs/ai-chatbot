import { cn } from '../../utils/cn'
import AssistantRow from './AssistantRow'
import { ASSISTANT_BUBBLE, BUBBLE_LINE_HEIGHT } from './bubbleStyles'

// Dots and reply swap in place without a layout jump: both are an <AssistantRow>
// wrapping an ASSISTANT_BUBBLE, the same two constants.
export default function TypingIndicator() {
  return (
    <AssistantRow className="animate-fade-in">
      {/* box-content makes the height one line box with padding added outside it;
          border-box would swallow the padding and halve the bubble's height. */}
      <span
        role="status"
        aria-label="Assistant is typing"
        className={cn(
          ASSISTANT_BUBBLE,
          BUBBLE_LINE_HEIGHT,
          'box-content flex items-center gap-1.5',
        )}
      >
        <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:300ms]" />
      </span>
    </AssistantRow>
  )
}
