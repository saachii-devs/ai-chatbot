import { cn } from '../../utils/cn'

// The chat's two bubble shapes, defined once. Kept apart from AssistantRow so
// that file exports only a component (Fast Refresh can't hot-swap a mixed module).

const BUBBLE_BASE = 'min-w-0 break-words rounded-3xl px-4 py-2.5 text-sm leading-relaxed'

export const ASSISTANT_BUBBLE = cn(BUBBLE_BASE, 'rounded-bl-lg bg-neutral-900 text-neutral-200')

export const USER_BUBBLE = cn(BUBBLE_BASE, 'rounded-br-lg bg-neutral-800 text-neutral-100')

// One line of bubble text as a ratio (leading-relaxed 1.625 of text-sm) so it
// tracks font changes. TypingIndicator uses it since the dots set no line box.
export const BUBBLE_LINE_HEIGHT = 'h-[1.625em]'
