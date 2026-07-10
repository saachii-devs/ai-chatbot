import { useEffect, useRef, useState } from 'react'
import IconRail from './components/layout/IconRail'
import HomeView from './components/home/HomeView'
import ChatView from './components/chat/ChatView'
import Composer from './components/home/Composer'
import FluidCanvas from './components/fluid/FluidCanvas'
import CallOverlay from './components/voice/CallOverlay'
import { ChevronRightIcon } from './components/icons'
import Button from './components/ui/Button'
import Tooltip from './components/ui/Tooltip'
import { useKeyboardInset } from './hooks/useKeyboardInset'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useSessions } from './state/SessionsContext'
import { useCall } from './state/CallContext'
import { useFluid } from './state/FluidContext'
import { BELOW_MD, RAIL_WIDTH } from './utils/breakpoints'

function App() {
  const { state, dispatch } = useSessions()
  const { status: callStatus } = useCall()
  const { phase, setSettleTarget } = useFluid()
  const [railOpen, setRailOpen] = useState(false)

  // Below md the rail is a drawer; above, it is layout. Reactive read so
  // rotating a phone into landscape re-classifies the rail correctly.
  const isDrawer = useMediaQuery(BELOW_MD)

  // Mounted once at the root: the on-screen keyboard belongs to the window,
  // not to any one field.
  useKeyboardInset()

  // The view is derived from which session is open, never stored separately.
  const view = state.activeSessionId ? 'chat' : 'home'

  // First paint snaps instead of animating — a restored session should not
  // play the sink.
  const firstPaint = useRef(true)
  useEffect(() => {
    setSettleTarget(view === 'chat' ? 1 : 0, firstPaint.current)
    firstPaint.current = false
  }, [view, setSettleTarget])

  // Dismissible via Escape / tap-scrim, but only while it IS a drawer — on
  // desktop the rail is layout and never modally opened.
  useEffect(() => {
    if (!railOpen || !isDrawer) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRailOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)

    // Scroll-lock the page beneath, or a swipe on the drawer scrolls the chat.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [railOpen, isDrawer])

  const startNewChat = () => {
    // Lazy session creation: the session is created when the first message is sent.
    dispatch({ type: 'SESSION_CLEARED' })
  }

  // Picking a chat in a drawer must dismiss it; on desktop the rail stays open.
  const dismissDrawerOnNavigate = () => {
    if (isDrawer) setRailOpen(false)
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-neutral-950 text-neutral-200">
      {/* Floating opener, only while the sidebar is closed. Offset by the
          safe-area inset so it clears the notch in landscape. */}
      {!railOpen && (
        <div
          className="animate-fade-in fixed z-30"
          style={{
            top: 'max(0.75rem, env(safe-area-inset-top, 0px))',
            left: 'max(0.75rem, env(safe-area-inset-left, 0px))',
          }}
        >
          <Tooltip label="Open sidebar">
            <Button
              size="iconLg"
              onClick={() => setRailOpen(true)}
              aria-label="Open sidebar"
              aria-expanded={false}
            >
              <ChevronRightIcon />
            </Button>
          </Tooltip>
        </div>
      )}

      {/* Scrim: dims and dismisses the drawer when tapped. Drawer-only. */}
      {railOpen && isDrawer && (
        <div
          className="animate-fade-in fixed inset-0 z-10 bg-black/60"
          onClick={() => setRailOpen(false)}
          aria-hidden
        />
      )}

      {/* Collapsible rail. On desktop opening it PUSHES the chat; on phones it
          stays a slide-over drawer (pushing would squeeze the chat to nothing). */}
      <div
        className={`z-20 shrink-0 overflow-hidden bg-neutral-950 transition-all duration-300 ease-out max-md:fixed max-md:inset-y-0 max-md:left-0 ${
          railOpen
            ? `${RAIL_WIDTH} border-r border-neutral-800 max-md:translate-x-0`
            : `md:w-0 ${RAIL_WIDTH} max-md:-translate-x-full`
        }`}
      >
        <IconRail
          onNewChat={startNewChat}
          onClose={() => setRailOpen(false)}
          onNavigate={dismissDrawerOnNavigate}
        />
      </div>

      {/* During 'settling' BOTH views stay mounted so they cross-fade; the
          composer never unmounts. `isolate` is load-bearing: without a stacking
          context here the composer's z-20 competes with the sidebar's at the root. */}
      <main className="relative isolate flex min-w-0 flex-1 flex-col">
        <FluidCanvas />
        {phase !== 'chat' && <HomeView />}
        {phase !== 'home' && <ChatView />}
        <Composer />
      </main>
      {callStatus !== 'idle' && <CallOverlay />}
    </div>
  )
}

export default App
