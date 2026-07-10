import type { RefObject } from 'react'
import { HEAD, LAP, STROKE, TAIL, useSnakeTrace } from '../../hooks/useSnakeTrace'
import { useFluid } from '../../state/FluidContext'

// The chat input's lit border. Idle/focus states are `.composer-ring` in index.css;
// only the "thinking" snake (useSnakeTrace) is drawn here, and only while active.

// CSS bloom fallback for browsers without WebGL2 (the fluid shader draws it otherwise).
const ELECTRIC_BLUE =
  'conic-gradient(from 180deg at 50% 50%, #0033ff, #0091ff, #00e5ff, #0091ff, #0033ff)'

export default function GradientGlow({
  thinking,
  boxRef,
}: {
  thinking: boolean
  /** The box the snake wraps: the hook reads its radius and its rect. */
  boxRef: RefObject<HTMLElement | null>
}) {
  const { webglSupported } = useFluid()
  const { svgRef, headRef, tailRef } = useSnakeTrace(thinking, boxRef)

  return (
    <>
      {!webglSupported && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-8 rounded-full opacity-25 blur-3xl motion-safe:animate-glow-breathe"
          style={{ background: ELECTRIC_BLUE }}
        />
      )}

      {/* The hook writes both rects' geometry (it measures the box anyway — one source
          of truth). overflow-visible lets the head's blur bleed past the box. pathLength
          ={LAP} rescales each path to a fixed length so dash offsets stay correct as the
          box grows. Size is explicit: an svg with no viewBox has no intrinsic ratio. */}
      {thinking && (
        <svg
          ref={svgRef}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] overflow-visible motion-reduce:hidden"
        >
          {/* Tail first so the head paints over its leading end; round caps make each dash a capsule. */}
          <rect
            ref={tailRef}
            fill="none"
            stroke="#38a9ff"
            strokeWidth={STROKE}
            strokeLinecap="round"
            pathLength={LAP}
            strokeDasharray={`${TAIL} ${LAP - TAIL}`}
            opacity={0.9}
            style={{ filter: 'blur(3px)' }}
          />
          {/* Reads as a light, not a line: near-white core + drop-shadow that spills colour
              past the border. Order matters — blur() softens the core, then drop-shadow() haloes it. */}
          <rect
            ref={headRef}
            fill="none"
            stroke="#d6fbff"
            strokeWidth={STROKE + 1}
            strokeLinecap="round"
            pathLength={LAP}
            strokeDasharray={`${HEAD} ${LAP - HEAD}`}
            style={{ filter: 'blur(1.1px) drop-shadow(0 0 5px #38d8ff)' }}
          />
        </svg>
      )}
    </>
  )
}
