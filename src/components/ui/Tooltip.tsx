import type { ReactNode } from 'react'

// Hover/focus-visible label for icon-only controls. Purely CSS so it can't get
// stuck open. pointer-events-none: else the tooltip sits under the cursor and
// re-triggers its own trigger's hover.
export default function Tooltip({
  label,
  align = 'start',
  children,
}: {
  label: string
  // 'end' grows the label leftward — for triggers near a clipping right edge.
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <div className="group/tip relative flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-40 mt-1.5 origin-top scale-95 whitespace-nowrap rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 opacity-0 shadow-lg transition duration-150 ease-out group-hover/tip:scale-100 group-hover/tip:opacity-100 group-has-focus-visible/tip:scale-100 group-has-focus-visible/tip:opacity-100 ${
          align === 'end' ? 'right-0' : 'left-0'
        }`}
      >
        {label}
      </span>
    </div>
  )
}
