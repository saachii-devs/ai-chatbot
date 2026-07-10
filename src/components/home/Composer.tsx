import { useEffect, useRef } from 'react'
import ErrorBanner from '../chat/ErrorBanner'
import StorageNotice from '../chat/StorageNotice'
import PromptBar from './PromptBar'

// The shared composer, mounted once above both views; it slides between home and
// chat positions as `--settle` moves, so the glow travels with it.

// --kb-inset lifts the box clear of the iOS keyboard (iOS paints it over the viewport
// rather than shrinking it); safe-area-inset clears the home bar. Both 0 on desktop.
const FLOOR = 'calc(2rem + var(--kb-inset, 0px) + env(safe-area-inset-bottom, 0px))'

// translateY(50%·inv) turns the box's bottom edge into its centre: settle 0 → centre
// 2rem below mid-<main>; settle 1 → edge at the floor. Overshoot (settle>1) rocks back.
const POSITION = {
  bottom: `calc(${FLOOR} + (50% - 4rem) * var(--settle-inv))`,
  transform: 'translateY(calc(50% * var(--settle-inv)))',
}

const WIDTH = { maxWidth: 'calc(48rem + 8rem * var(--settle-inv))' }

export default function Composer() {
  const ref = useRef<HTMLDivElement | null>(null)

  // Publish our height so the last bubble clears us; the textarea is field-sizing-content,
  // so this changes as you type, not only on resize.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const publish = () =>
      document.documentElement.style.setProperty('--composer-h', `${el.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="absolute inset-x-0 z-20 px-4" style={POSITION}>
      <div className="mx-auto flex w-full flex-col gap-2" style={WIDTH}>
        <StorageNotice />
        <ErrorBanner />
        <PromptBar />
      </div>
    </div>
  )
}
