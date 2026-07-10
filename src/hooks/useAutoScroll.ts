import { useEffect, useRef } from 'react'

// Pins a scrollable container to the bottom as content arrives, but only if the
// user is already near the bottom — someone who scrolled up is never yanked down.
// "Near bottom" is tracked from scroll events, not measured on new content: by
// then the new bubble is in the DOM and its height would count against the user.
const NEAR_BOTTOM_PX = 120

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

export function useAutoScroll(sessionId: string, messageCount: number, streamedChars: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const lastSessionId = useRef(sessionId)
  const lastCount = useRef(messageCount)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const switched = lastSessionId.current !== sessionId
    const appended = !switched && messageCount !== lastCount.current
    lastSessionId.current = sessionId
    lastCount.current = messageCount

    // Opening a chat should START at the bottom, not travel there.
    if (switched) {
      nearBottom.current = true
      el.scrollTop = el.scrollHeight
      return
    }

    if (!nearBottom.current) return

    // Smooth-scroll a newly appended bubble (its shift needs easing), but jump for
    // streamed chunks: a 300ms glide restarted every ~40ms would never reach bottom.
    if (appended && !window.matchMedia(REDUCED_MOTION).matches) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [sessionId, messageCount, streamedChars])

  return containerRef
}
