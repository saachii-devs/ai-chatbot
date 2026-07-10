import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { FluidRenderer, MAX_RIPPLES, type FluidUniforms } from '../services/fluid/FluidRenderer'

// Fluid state, kept SEPARATE from sessions and calls. Updates ~60/s, so values
// live in refs and only `phase` triggers a render. One spring integrates
// `settle` (0 = new chat, 1 = ongoing); every consumer reads it the same frame.

// 'settling' is the in-between; both views are mounted so they cross-fade.
export type FluidPhase = 'home' | 'settling' | 'chat'

interface FluidContextValue {
  phase: FluidPhase
  webglSupported: boolean
  // `immediate` snaps without animating — used on first paint.
  setSettleTarget: (target: number, immediate?: boolean) => void
  setPulse: (active: boolean) => void
  // Drops a ripple at a viewport coordinate.
  emitRipple: (clientX: number, clientY: number) => void
  registerComposer: (el: HTMLElement | null) => void
  attachCanvas: (el: HTMLCanvasElement | null) => void
  // Re-measure after a layout change the loop can't see (e.g. sidebar push).
  invalidate: () => void
}

const FluidContext = createContext<FluidContextValue | null>(null)

// Underdamped on purpose (zeta ~= 0.64): the ~7% overshoot IS the liquid
// weight; an overdamped spring just slides.
const STIFFNESS = 120
const DAMPING = 14

// Integrate the spring in FIXED steps, not raw frame deltas: explicit Euler on
// a stiff spring gains energy as the step grows, so the animation would differ
// across refresh rates. Accumulate real time, spend it in 1/120s quanta.
const FIXED_DT = 1 / 120
const MAX_SUBSTEPS = 8 // beyond this we drop the backlog rather than spiral

const PULSE_RATE = 6 // exponential approach, ~1/6s to close 63% of the gap

const SETTLED_EPSILON = 5e-4
// Read the browser's computed radius rather than duplicate the CSS breakpoint
// rule; `rounded-full` reports a huge value, so clamp to half the shorter side.
const composerRadiusPx = (box: DOMRect, cssRadius: number) =>
  Math.min(cssRadius, box.width / 2, box.height / 2)

function readCssRadius(el: HTMLElement): number {
  const value = parseFloat(getComputedStyle(el).borderTopLeftRadius)
  return Number.isFinite(value) ? value : 28
}
// Screen-heights. Large and dim: the halo reads as one soft field, not a collar.
const BLOOM_REACH = 0.45

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function FluidProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<FluidPhase>('home')
  const [webglSupported, setWebglSupported] = useState(true)

  const settle = useRef(0)
  const velocity = useRef(0)
  const target = useRef(0)
  const pulse = useRef(0)
  const pulseTarget = useRef(0)
  const time = useRef(0)

  const ripples = useRef(new Float32Array(MAX_RIPPLES * 4))
  const rippleSlot = useRef(0)

  const composerEl = useRef<HTMLElement | null>(null)
  // Cached, not read per frame: getComputedStyle forces a style recalc.
  const composerCssRadius = useRef(28)
  const canvasEl = useRef<HTMLCanvasElement | null>(null)
  const renderer = useRef<FluidRenderer | null>(null)

  const rafId = useRef(0)
  const lastTime = useRef(0)
  const accumulator = useRef(0)
  const dirty = useRef(true)
  const reduced = useRef(false)
  // Mirrors `phase` so the loop can compare without reading React state.
  const phaseRef = useRef<FluidPhase>('home')

  const frame = useRef<(now: number) => void>(() => {})

  const kick = useCallback(() => {
    if (rafId.current || document.hidden) return
    lastTime.current = performance.now()
    rafId.current = requestAnimationFrame((t) => frame.current(t))
  }, [])

  const invalidate = useCallback(() => {
    dirty.current = true
    if (composerEl.current) composerCssRadius.current = readCssRadius(composerEl.current)
    kick()
  }, [kick])

  frame.current = (now: number) => {
    rafId.current = 0

    // Clamp dt: a backgrounded tab or long GC pause must not integrate a huge
    // step and fling the composer off-screen.
    const dt = Math.min(Math.max(now - lastTime.current, 0) / 1000, 1 / 30)
    lastTime.current = now

    if (reduced.current) {
      settle.current = target.current
      velocity.current = 0
      pulse.current = 0
      accumulator.current = 0
    } else {
      time.current += dt

      accumulator.current += dt
      let steps = 0
      while (accumulator.current >= FIXED_DT && steps < MAX_SUBSTEPS) {
        const accel =
          STIFFNESS * (target.current - settle.current) - DAMPING * velocity.current
        velocity.current += accel * FIXED_DT
        settle.current += velocity.current * FIXED_DT
        accumulator.current -= FIXED_DT
        steps++
      }
      if (steps === MAX_SUBSTEPS) accumulator.current = 0

      // Exponential approach is unconditionally stable, so the raw delta is fine.
      pulse.current += (pulseTarget.current - pulse.current) * (1 - Math.exp(-dt * PULSE_RATE))
    }

    if (
      Math.abs(target.current - settle.current) < SETTLED_EPSILON &&
      Math.abs(velocity.current) < SETTLED_EPSILON
    ) {
      settle.current = target.current
      velocity.current = 0
    }
    const settled = settle.current === target.current && velocity.current === 0

    // Publish `--settle-inv` rather than derive it in CSS: nested calc() in a
    // multiplication is where browsers disagree.
    const root = document.documentElement.style
    root.setProperty('--settle', settle.current.toFixed(4))
    root.setProperty('--settle-inv', (1 - settle.current).toFixed(4))

    const nextPhase: FluidPhase = !settled ? 'settling' : target.current >= 1 ? 'chat' : 'home'
    if (nextPhase !== phaseRef.current) {
      phaseRef.current = nextPhase
      setPhase(nextPhase)
    }

    let rendered = false
    const gl = renderer.current
    const canvas = canvasEl.current
    if (gl && canvas && (!reduced.current || dirty.current)) {
      // One rect read per frame lets the anchor track the sidebar push and
      // textarea growth for free, with no observers.
      const host = canvas.getBoundingClientRect()
      if (host.width > 0 && host.height > 0) {
        const box = composerEl.current?.getBoundingClientRect()
        const anchor: FluidUniforms['anchor'] = box
          ? [
              (box.left - host.left + box.width / 2) / host.width,
              1 - (box.top - host.top + box.height / 2) / host.height,
              box.width / 2 / host.width,
              box.height / 2 / host.height,
            ]
          : [0.5, 0.5, 0.2, 0.04]

        gl.render(
          {
            time: time.current,
            settle: settle.current,
            settleVel: velocity.current,
            pulse: pulse.current,
            anchor,
            radius: (box ? composerRadiusPx(box, composerCssRadius.current) : 26) / host.height,
            reach: BLOOM_REACH,
            ripples: ripples.current,
          },
          host.width,
          host.height,
        )
        dirty.current = false
        rendered = true
      }
    }

    // Reduced motion: stop the loop once settled rather than spin rAF on a
    // static frame — but keep going until a live renderer has drawn once (the
    // canvas has no layout on the first frame).
    if (reduced.current && settled && (rendered || !gl)) return
    if (document.hidden) return
    rafId.current = requestAnimationFrame((t) => frame.current(t))
  }

  // Track the OS preference live; toggling it mid-session must take effect.
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION)
    const sync = () => {
      reduced.current = mq.matches
      invalidate()
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [invalidate])

  // Stops us resuming a hidden tab with a stale `lastTime` and one huge step.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafId.current)
        rafId.current = 0
      } else {
        kick()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [kick])

  useEffect(() => {
    kick()
    return () => {
      cancelAnimationFrame(rafId.current)
      rafId.current = 0
    }
  }, [kick])

  const setSettleTarget = useCallback(
    (next: number, immediate = false) => {
      target.current = next
      if (immediate) {
        settle.current = next
        velocity.current = 0
      }
      invalidate()
    },
    [invalidate],
  )

  const setPulse = useCallback(
    (active: boolean) => {
      pulseTarget.current = active ? 1 : 0
      kick()
    },
    [kick],
  )

  const emitRipple = useCallback((clientX: number, clientY: number) => {
    if (reduced.current) return
    const canvas = canvasEl.current
    if (!canvas) return
    const host = canvas.getBoundingClientRect()
    if (host.width <= 0 || host.height <= 0) return

    // Ring buffer: the oldest ripple has fully decayed before its slot recurs.
    const offset = rippleSlot.current * 4
    rippleSlot.current = (rippleSlot.current + 1) % MAX_RIPPLES
    const buffer = ripples.current
    buffer[offset] = (clientX - host.left) / host.width
    buffer[offset + 1] = 1 - (clientY - host.top) / host.height
    buffer[offset + 2] = time.current
    buffer[offset + 3] = 1
  }, [])

  const registerComposer = useCallback((el: HTMLElement | null) => {
    composerEl.current = el
    if (el) composerCssRadius.current = readCssRadius(el)
  }, [])

  const attachCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (el === canvasEl.current) return
      renderer.current?.dispose()
      renderer.current = null
      canvasEl.current = el
      if (!el) return

      const created = FluidRenderer.create(el)
      renderer.current = created
      setWebglSupported(created !== null)
      invalidate()
    },
    [invalidate],
  )

  return (
    <FluidContext.Provider
      value={{
        phase,
        webglSupported,
        setSettleTarget,
        setPulse,
        emitRipple,
        registerComposer,
        attachCanvas,
        invalidate,
      }}
    >
      {children}
    </FluidContext.Provider>
  )
}

export function useFluid(): FluidContextValue {
  const ctx = useContext(FluidContext)
  if (!ctx) throw new Error('useFluid must be used inside <FluidProvider>')
  return ctx
}
