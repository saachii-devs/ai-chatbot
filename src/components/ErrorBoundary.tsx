import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clearSessions } from '../services/storage'

// Catches throws during render. Reset clears sessions because the crashing state
// is already in localStorage, so a plain reload replays the same crash forever.
// Must be a class component: there is no hook equivalent of componentDidCatch.

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack)
  }

  private handleReset = (): void => {
    clearSessions()
    location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        className="flex min-h-dvh items-center justify-center bg-neutral-950 px-4"
      >
        <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-medium text-neutral-100">
              The app hit an unexpected error
            </h1>
            <p className="text-sm text-neutral-400">
              Reloading may be enough. If it crashes again, a saved chat is the
              likely cause — clearing them starts you fresh.
            </p>
          </div>

          <pre className="max-h-32 overflow-auto rounded-lg bg-neutral-950 p-3 text-xs text-red-300">
            {error.message}
          </pre>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => location.reload()}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition duration-150 ease-out hover:bg-white active:scale-95"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-lg border border-red-900 px-4 py-2 text-sm font-medium text-red-300 transition duration-150 ease-out hover:bg-red-950/60 active:scale-95"
            >
              Clear chats and reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
