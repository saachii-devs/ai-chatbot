import { useState, type ReactNode } from 'react'
import { RAIL_WIDTH } from '../../utils/breakpoints'
import { cn } from '../../utils/cn'
import { ChevronLeftIcon, PencilIcon, SearchIcon, SparkleLogo, XIcon } from '../icons'
import Button from '../ui/Button'
import Tooltip from '../ui/Tooltip'
import ChatHistory from './ChatHistory'

function RailButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick?: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-full px-4 py-2.5 text-sm text-neutral-300 transition duration-150 ease-out hover:bg-neutral-800 active:scale-[0.98] ${
        active ? 'bg-neutral-800 text-neutral-100' : ''
      }`}
    >
      <span className="flex size-5 items-center justify-center text-neutral-400">
        {children}
      </span>
      {label}
    </button>
  )
}

export default function IconRail({
  onNewChat,
  onClose,
  onNavigate,
}: {
  onNewChat: () => void
  onClose: () => void
  /** Fired whenever the rail takes you somewhere: a chat, or a new chat. */
  onNavigate: () => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Closing search must also clear the query, else history stays filtered by an unseen term.
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
  }

  const navigate = () => {
    closeSearch()
    onNavigate()
  }

  return (
    // Width shared with the drawer shell in App (one constant). Explicit width (not w-full)
    // so the rail keeps its shape while the shell animates to zero on desktop.
    <div className={cn('flex h-full shrink-0 flex-col gap-1 px-3 pb-3 pt-3', RAIL_WIDTH)}>
      <div className="mb-3 flex h-10 items-center justify-between pl-4 pr-0.5">
        <div className="flex items-center gap-3">
          <SparkleLogo />
          <span className="text-sm font-medium text-neutral-100">AI Assistant</span>
        </div>
        <Tooltip label="Close sidebar" align="end">
          <Button
            size="iconLg"
            onClick={onClose}
            aria-label="Close sidebar"
            aria-expanded={true}
          >
            <ChevronLeftIcon />
          </Button>
        </Tooltip>
      </div>

      <RailButton
        label="New chat"
        onClick={() => {
          navigate()
          onNewChat()
        }}
      >
        <PencilIcon />
      </RailButton>

      {searchOpen ? (
        <div className="animate-fade-in flex items-center gap-3 rounded-full bg-neutral-800 px-4 py-2.5 ring-1 ring-neutral-700">
          <SearchIcon className="size-5 shrink-0 text-neutral-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
            }}
            placeholder="Search chats"
            aria-label="Search chats"
            // outline-none removes the always-on ring; the keyboard-only one is given back by hand.
            className="min-w-0 flex-1 rounded bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          />
          <Button variant="bare" size="xs" onClick={closeSearch} aria-label="Close search">
            <XIcon className="size-4" />
          </Button>
        </div>
      ) : (
        <RailButton label="Search chats" onClick={() => setSearchOpen(true)}>
          <SearchIcon />
        </RailButton>
      )}

      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-neutral-800">
        <ChatHistory query={query} onSelectSession={navigate} />
      </div>
    </div>
  )
}
