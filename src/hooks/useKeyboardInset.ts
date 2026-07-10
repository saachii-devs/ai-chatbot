import { useEffect } from 'react'

// Publishes how much of the viewport the on-screen keyboard covers as
// `--kb-inset` on :root; the composer adds it to its own `bottom`. Needed because
// iOS paints the keyboard OVER an h-dvh container rather than shrinking it.
// `offsetTop` is in the sum because iOS scrolls the visual viewport up when
// focusing a field near the fold; without it the composer floats into the middle.
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return // Firefox < 91 and older Safari: fall back to no inset.

    const root = document.documentElement
    const publish = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop
      root.style.setProperty('--kb-inset', `${Math.max(0, covered)}px`)
    }

    publish()
    vv.addEventListener('resize', publish)
    vv.addEventListener('scroll', publish)
    return () => {
      vv.removeEventListener('resize', publish)
      vv.removeEventListener('scroll', publish)
      root.style.removeProperty('--kb-inset')
    }
  }, [])
}
