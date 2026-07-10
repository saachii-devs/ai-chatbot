import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { XIcon } from '../icons'
import Button from './Button'

// Shared wrapper for ErrorBanner and StorageNotice. Error is role="alert"
// (interrupts); warn is role="status" (merely informs).

const TONES = {
  error: {
    box: 'border-red-900/60 bg-red-950/60 text-red-300',
    dismiss: 'danger',
    role: 'alert',
  },
  warn: {
    box: 'border-amber-900/60 bg-amber-950/50 text-amber-300',
    dismiss: 'warn',
    role: 'status',
  },
} as const

export default function Notice({
  tone,
  message,
  onDismiss,
  dismissLabel,
  children,
}: {
  tone: keyof typeof TONES
  message: string
  onDismiss: () => void
  // Icon-only dismiss buttons need their own name; "×" is not one.
  dismissLabel: string
  // An action to offer alongside the dismiss — Retry, on the error tone.
  children?: ReactNode
}) {
  const { box, dismiss, role } = TONES[tone]

  return (
    <div
      role={role}
      aria-live="polite"
      className={cn(
        'animate-rise-in mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border px-4 py-2 text-sm',
        box,
      )}
    >
      <span>{message}</span>
      {/* gap-2, not gap-1: the dismiss button's 44px hit area overhangs its 28px
          box, so a tighter gap would let it swallow the action beside it. */}
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <Button
          variant={dismiss}
          size="md"
          radius="md"
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  )
}
