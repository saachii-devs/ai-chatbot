import { useEffect, useRef, useState } from 'react'
import IconRail from './components/layout/IconRail'
import HomeView from './components/home/HomeView'
import ChatView from './components/chat/ChatView'
import Composer from './components/home/Composer'
import FluidCanvas from './components/fluid/FluidCanvas'
import { ChevronRightIcon } from './components/icons'
import Button from './components/ui/Button'
import Tooltip from './components/ui/Tooltip'
import { useKeyboardInset } from './hooks/useKeyboardInset'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useSessionRoute } from './hooks/useSessionRoute'
import { useVoiceGuards } from './hooks/useVoiceGuards'
import { useSessions } from './state/SessionsContext'
import { useCall } from './state/CallContext'
import { useFluid } from './state/FluidContext'
import { BELOW_MD, RAIL_COLLAPSED_WIDTH_MD, RAIL_WIDTH } from './utils/breakpoints'

function App() {
  const { state, dispatch } = useSessions()
  const { status: callStatus } = useCall()
  const { phase, setSettleTarget } = useFluid()
  const [railOpen, setRailOpen] = useState(false)
  // True from the moment the rail is toggled until its width lands. Only used to
  // clip the rail while it moves — see the shell below.
  const [railAnimating, setRailAnimating] = useState(false)

  const toggleRail = (open: boolean) => {
    setRailAnimating(true)
    setRailOpen(open)
  }

  // Below md the rail is a drawer; above, it is layout. Reactive read so
  // rotating a phone into landscape re-classifies the rail correctly.
  const isDrawer = useMediaQuery(BELOW_MD)

  // Mounted once at the root: the on-screen keyboard belongs to the window,
  // not to any one field.
  useKeyboardInset()

  // Same reason: the address bar is the window's, and one mirror of it is the
  // only way it stays consistent. Keeps ?chat=<id> in step with the open chat.
  useSessionRoute()

  // Mounted here, not in VoicePanel: these guards must outlive the panel they
  // guard, which unmounts the moment voice goes idle.
  useVoiceGuards()

  // The view is derived, never stored. Voice counts as being in a chat even
  // before one exists: starting it from the home screen shows the (empty)
  // transcript with the voice panel below it, and the first utterance creates
  // the session — so a run that never hears a word leaves no empty chat behind.
  const view = state.activeSessionId || callStatus !== 'idle' ? 'chat' : 'home'

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
      if (event.key === 'Escape') toggleRail(false)
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
    if (isDrawer) toggleRail(false)
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-neutral-950 text-neutral-200">
      {/* Floating opener — drawers only. A closed desktop rail collapses to icons
          and carries its own opener. Offset by the safe-area inset so it clears
          the notch in landscape. */}
      {!railOpen && isDrawer && (
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
              onClick={() => toggleRail(true)}
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
          onClick={() => toggleRail(false)}
          aria-hidden
        />
      )}

      {/* Collapsible rail. On desktop it narrows to an icon strip and PUSHES the
          chat; on phones it stays a slide-over drawer that leaves nothing behind
          (an icon strip would eat width the chat cannot spare).

          The clip is transient, not permanent: it exists so the wide content does
          not spill past the shell while the width animates. Once settled, a
          collapsed rail must let its tooltips out — at 4rem wide, everything it
          can say is wider than it is. */}
      <div
        // Every property on this shell shares one duration, so whichever lands
        // first, the move is over. Bubbled ends from the rail's own contents are
        // not — hence the target check.
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget) setRailAnimating(false)
        }}
        className={`z-20 shrink-0 border-neutral-800 bg-neutral-950 transition-all duration-300 ease-out max-md:fixed max-md:inset-y-0 max-md:left-0 md:border-r ${
          railAnimating ? 'overflow-hidden' : 'overflow-hidden md:overflow-visible'
        } ${
          railOpen
            ? `${RAIL_WIDTH} border-r max-md:translate-x-0`
            : `${RAIL_COLLAPSED_WIDTH_MD} ${RAIL_WIDTH} max-md:-translate-x-full`
        }`}
      >
        <IconRail
          collapsed={!railOpen && !isDrawer}
          onNewChat={startNewChat}
          onOpen={() => toggleRail(true)}
          onClose={() => toggleRail(false)}
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
    </div>
  )
}

export default App
