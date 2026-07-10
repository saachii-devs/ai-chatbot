import { useEffect, useRef, useState } from 'react'

// Reveals `text` one character at a time, smoothing chunked transcript updates.
// The common case is a prefix extension (same sentence, a bit longer): keep our
// place. Only a non-continuation — a fresh turn — rewinds to the start.
export function useTypewriter(text: string, speedMs = 18): string {
  const [shown, setShown] = useState('')
  const shownRef = useRef('')
  const index = useRef(0)

  useEffect(() => {
    if (!text) {
      index.current = 0
      shownRef.current = ''
      setShown('')
      return
    }

    // Not a continuation: rewind.
    if (!text.startsWith(shownRef.current)) index.current = 0

    // Reduced motion: no reveal, just the text.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      index.current = text.length
      shownRef.current = text
      setShown(text)
      return
    }

    if (index.current >= text.length) return

    // One interval per text change, not one per character.
    const timer = setInterval(() => {
      index.current = Math.min(index.current + 1, text.length)
      shownRef.current = text.slice(0, index.current)
      setShown(shownRef.current)
      if (index.current >= text.length) clearInterval(timer)
    }, speedMs)

    return () => clearInterval(timer)
  }, [text, speedMs])

  return shown
}
