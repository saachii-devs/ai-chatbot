import { useEffect, useState } from 'react'

// Reactive `matchMedia`: re-renders when the viewport crosses the boundary.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    // Re-read on subscribe: viewport may have changed since the lazy initializer.
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
