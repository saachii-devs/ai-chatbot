import { useEffect, useRef, type RefObject } from 'react'

// A light that runs along the composer's border only while the assistant thinks.
// The snake rides the border as a dash on a rounded-rect stroke, so its position
// is a DISTANCE along the perimeter — not a conic gradient, whose angle→point
// mapping would smear the dash into a blob at the corners of a wide pill.
const SPIN_PER_MS = 100 / 6000 // one lap per 6s, in pathLength units
const FRAME = 1000 / 60
export const LAP = 100 // every rect carries pathLength=100, so a lap is 100 units

export const STROKE = 1.5
export const HEAD = 2.4 // dash lengths, in those same units
export const TAIL = 13

// Drives the border snake; geometry/offsets are written straight to the DOM, not
// React state. Nothing is measured unless `active`, so idle costs no frames.
// `boxRef`'s corner radius is read from it rather than hardcoded, since the box
// changes between rounded-full and rounded-[1.75rem] and its height interpolates.
export function useSnakeTrace(active: boolean, boxRef: RefObject<HTMLElement | null>) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const headRef = useRef<SVGRectElement | null>(null)
  const tailRef = useRef<SVGRectElement | null>(null)

  useEffect(() => {
    if (!active) return
    const svg = svgRef.current
    const box = boxRef.current
    const head = headRef.current
    const tail = tailRef.current
    if (!svg || !box || !head || !tail) return

    const measure = () => {
      const svgBox = svg.getBoundingClientRect()
      const cssBox = box.getBoundingClientRect()
      if (!svgBox.width || !svgBox.height) return

      const half = STROKE / 2
      const x = half
      const y = half
      const w = Math.max(svgBox.width - STROKE, 0)
      const h = Math.max(svgBox.height - STROKE, 0)

      // `rounded-full` clamps to half the shorter side → a stadium, radius = half
      // the ring height. Otherwise the box radius plus the ring's centreline outset.
      const declared = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 0
      const isPill = declared >= Math.min(cssBox.width, cssBox.height) / 2
      const outset = cssBox.top - svgBox.top - y
      const r = isPill
        ? Math.min(w, h) / 2
        : Math.max(Math.min(declared + outset, w / 2, h / 2), 0)

      for (const rect of [head, tail]) {
        rect.setAttribute('x', String(x))
        rect.setAttribute('y', String(y))
        rect.setAttribute('width', String(w))
        rect.setAttribute('height', String(h))
        rect.setAttribute('rx', String(r))
      }
    }

    measure()
    // The box resizes as the draft wraps and as padding interpolates.
    const observer = new ResizeObserver(measure)
    observer.observe(svg)

    // motion-reduce:hidden keeps the dashes off screen; don't burn frames.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return () => observer.disconnect()
    }

    let at = 0 // where the head is now, in pathLength units
    let last = 0
    let frame = requestAnimationFrame(function step(now) {
      frame = requestAnimationFrame(step)
      const dt = last ? Math.min(now - last, 100) : FRAME // clamp so a backgrounded tab doesn't lurch
      last = now

      at = (at + SPIN_PER_MS * dt) % LAP // whole lap: no visible seam
      // Offsetting a dash by -d starts it at distance d; the tail ends where the head is.
      head.setAttribute('stroke-dashoffset', String(HEAD / 2 - at))
      tail.setAttribute('stroke-dashoffset', String(TAIL - at))
    })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [active, boxRef])

  return { svgRef, headRef, tailRef }
}
