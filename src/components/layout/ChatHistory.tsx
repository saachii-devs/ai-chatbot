import { useState } from 'react'
import { abortSession } from '../../services/inFlight'
import { useSessions } from '../../state/SessionsContext'
import type { ChatSession } from '../../types'
import { formatRelativeTime } from '../../utils/formatRelativeTime'
import { ChevronDownIcon, XIcon } from '../icons'
import Button from '../ui/Button'

// How many chats show before "See more".
const COLLAPSED_COUNT = 5

interface Match {
  snippet: string | null
}

// Title match → null snippet; body match → a snippet showing why. null when no match.
function findMatch(session: ChatSession, query: string): Match | null {
  if (session.title.toLowerCase().includes(query)) return { snippet: null }

  for (const message of session.messages) {
    const at = message.content.toLowerCase().indexOf(query)
    if (at === -1) continue

    const start = Math.max(0, at - 24)
    const end = Math.min(message.content.length, at + query.length + 40)
    const body = message.content.slice(start, end).replace(/\s+/g, ' ').trim()
    const snippet = `${start > 0 ? '…' : ''}${body}${end < message.content.length ? '…' : ''}`
    return { snippet }
  }

  return null
}

function SessionRow({
  session,
  match,
  onSelectSession,
}: {
  session: ChatSession
  match: Match | null
  onSelectSession: () => void
}) {
  const { state, dispatch } = useSessions()
  const isActive = session.id === state.activeSessionId

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => {
          dispatch({ type: 'SESSION_SELECTED', sessionId: session.id })
          onSelectSession()
        }}
        // pr-12 clears the delete button beside it.
        className={`flex w-full flex-col rounded-2xl px-4 py-2.5 pr-12 text-left text-sm transition duration-150 ease-out active:scale-[0.98] ${
          isActive
            ? 'bg-blue-500/15 text-blue-200'
            : 'text-neutral-300 hover:bg-neutral-800'
        }`}
      >
        <span className="truncate">{session.title}</span>
        {match?.snippet ? (
          <span className="truncate text-xs text-neutral-500">{match.snippet}</span>
        ) : (
          <span className={`text-xs ${isActive ? 'text-blue-300/70' : 'text-neutral-500'}`}>
            {formatRelativeTime(session.updatedAt)}
          </span>
        )}
      </button>
      {/* No shared 44px hit area: this floats over the row, and an invisible target wider
          than the button would turn "tap beside the title" into "delete". pointer-coarse
          reveals it on touch. Position lives on this span, not the Button: Button already
          sets `relative` and cn is a plain join, so an absolute via className would lose. */}
      <span className="absolute right-2 top-1/2 -translate-y-1/2">
        <Button
          variant="subtle"
          size="icon"
          hitArea={false}
          onClick={(e) => {
            e.stopPropagation() // don't ALSO select the session
            // A reply may still be streaming into this chat; deleting the state it
            // streams into does not stop the request — this does.
            abortSession(session.id)
            dispatch({ type: 'SESSION_DELETED', sessionId: session.id })
          }}
          aria-label={`Delete chat: ${session.title}`}
          className="scale-90 opacity-0 focus-visible:scale-100 focus-visible:opacity-100 group-hover:scale-100 group-hover:opacity-100 pointer-coarse:scale-100 pointer-coarse:opacity-100"
        >
          <XIcon className="size-3.5" />
        </Button>
      </span>
    </li>
  )
}

export default function ChatHistory({
  query,
  onSelectSession,
}: {
  query: string
  onSelectSession: () => void
}) {
  const { state } = useSessions()
  const [expanded, setExpanded] = useState(false)

  const needle = query.trim().toLowerCase()
  const searching = needle.length > 0

  // Derived at render time — copy before sorting (.sort() mutates!).
  const results = [...state.sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({ session, match: searching ? findMatch(session, needle) : null }))
    .filter(({ match }) => !searching || match !== null)

  // Searching shows every hit; browsing shows 5, keeping the rest mounted-but-clipped
  // so expanding can animate its height.
  const head = searching ? results : results.slice(0, COLLAPSED_COUNT)
  const tail = searching ? [] : results.slice(COLLAPSED_COUNT)

  if (state.sessions.length === 0) {
    return <p className="px-6 py-3 text-sm text-neutral-600">No conversations yet</p>
  }

  if (searching && results.length === 0) {
    return (
      <p className="animate-fade-in px-6 py-3 text-sm text-neutral-500">
        No chats match "<span className="text-neutral-400">{query.trim()}</span>"
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-col">
      <h2 className="px-6 pb-1.5 pt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
        {searching ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'Recent'}
      </h2>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3">
        <ul className="flex flex-col gap-1">
          {head.map(({ session, match }) => (
            <SessionRow
              key={session.id}
              session={session}
              match={match}
              onSelectSession={onSelectSession}
            />
          ))}
        </ul>

        {/* 0fr → 1fr is the one height transition that works on auto content: the grid row
            measures the list and the browser interpolates. Clipping lives on the inner element. */}
        {tail.length > 0 && (
          <div
            className={`grid transition-[grid-template-rows] duration-300 ease-out ${
              expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            }`}
          >
            {/* inert (not aria-hidden): collapsed rows are still in the DOM, so they
                must drop out of the tab order too. */}
            <ul
              inert={!expanded}
              className={`flex flex-col gap-1 overflow-hidden pt-1 transition-opacity duration-300 ${
                expanded ? 'opacity-100' : 'opacity-0'
              }`}
            >
              {tail.map(({ session, match }) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  match={match}
                  onSelectSession={onSelectSession}
                />
              ))}
            </ul>
          </div>
        )}
      </nav>

      {tail.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mx-3 mt-1.5 flex items-center gap-2 rounded-full px-4 py-2 text-sm text-neutral-400 transition duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-200 active:scale-[0.98]"
        >
          <ChevronDownIcon
            className={`size-4 transition-transform duration-300 ease-out ${
              expanded ? 'rotate-180' : ''
            }`}
          />
          {expanded ? 'Show less' : `See more (${tail.length})`}
        </button>
      )}
    </div>
  )
}
