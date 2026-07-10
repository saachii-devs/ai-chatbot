import { useEffect, useState } from 'react'
import { useChat } from '../../hooks/useChat'
import Button from '../ui/Button'
import Notice from '../ui/Notice'

function remaining(retryAt: number | null): number {
  if (!retryAt) return 0
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
}

// Seconds until `retryAt`, ticking down; 0 once retrying is allowed again.
function useCountdown(retryAt: number | null): number {
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(retryAt))

  useEffect(() => {
    setSecondsLeft(remaining(retryAt))
    if (!retryAt) return
    const timer = setInterval(() => setSecondsLeft(remaining(retryAt)), 1000)
    return () => clearInterval(timer)
  }, [retryAt])

  return secondsLeft
}

export default function ErrorBanner() {
  const { error, retry, retryAt, dismissError } = useChat()
  // Called before the early return below — a hook may not run conditionally.
  const secondsLeft = useCountdown(retryAt)

  if (!error) return null

  // Retrying before the provider's retryAt just spends another 429, so wait.
  const waiting = secondsLeft > 0

  return (
    <Notice tone="error" message={error} onDismiss={dismissError} dismissLabel="Dismiss error">
      <Button
        variant="dangerOutline"
        size="compact"
        radius="md"
        onClick={retry}
        disabled={waiting}
        // The adjacent dismiss button's hit area already reaches this edge; a
        // second 44px box would overlap it.
        hitArea={false}
      >
        {waiting ? `Retry in ${secondsLeft}s` : 'Retry'}
      </Button>
    </Notice>
  )
}
