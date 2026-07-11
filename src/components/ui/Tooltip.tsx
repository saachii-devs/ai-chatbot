import type { ReactNode } from 'react'

// Hover/focus-visible label for icon-only controls. Purely CSS so it can't get
// stuck open. pointer-events-none: else the tooltip sits under the cursor and
// re-triggers its own trigger's hover.
export default function Tooltip({
  label,
  align = 'start',
  side = 'bottom',
  children,
}: {
  label: string
  // 'end' grows the label leftward — for triggers near a clipping right edge.
  align?: 'start' | 'end'
  // 'right' is for a narrow column, where a label under the icon has no room to
  // grow sideways and would be clipped by the column's own edge.
  side?: 'bottom' | 'right'
  children: ReactNode
}) {
  const placement =
    side === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2 origin-left'
      : `top-full mt-1.5 origin-top ${align === 'end' ? 'right-0' : 'left-0'}`

  return (
    <div className="group/tip relative flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-40 scale-95 whitespace-nowrap rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 opacity-0 shadow-lg transition duration-150 ease-out group-hover/tip:scale-100 group-hover/tip:opacity-100 group-has-focus-visible/tip:scale-100 group-has-focus-visible/tip:opacity-100 ${placement}`}
      >
        {label}
      </span>
    </div>
  )
}
