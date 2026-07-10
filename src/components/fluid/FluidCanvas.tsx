import { useEffect, useRef } from 'react'
import { useFluid } from '../../state/FluidContext'

// Fluid canvas behind <main> (not the viewport), so it never runs under the sidebar.
// The observer only wakes the loop when it is asleep for reduced motion.
export default function FluidCanvas() {
  const { attachCanvas, invalidate, webglSupported } = useFluid()
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    attachCanvas(canvas)
    if (!canvas) return

    const observer = new ResizeObserver(invalidate)
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      attachCanvas(null)
    }
  }, [attachCanvas, invalidate])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      // Hidden, not unmounted: attachCanvas must run to discover WebGL is missing.
      className={`pointer-events-none absolute inset-0 z-0 size-full ${
        webglSupported ? '' : 'invisible'
      }`}
    />
  )
}
