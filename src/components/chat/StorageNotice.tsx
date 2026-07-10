import { useSessions } from '../../state/SessionsContext'
import Notice from '../ui/Notice'

// Not an error: the chat works but isn't being persisted. Amber, not red.
export default function StorageNotice() {
  const { state, dispatch } = useSessions()

  if (!state.storageWarning) return null

  return (
    <Notice
      tone="warn"
      message={state.storageWarning}
      onDismiss={() => dispatch({ type: 'STORAGE_WARNING_CLEARED' })}
      dismissLabel="Dismiss storage warning"
    />
  )
}
