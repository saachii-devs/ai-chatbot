import { useState } from 'react'
import { useChat } from '../../hooks/useChat'
import type { Message } from '../../types'
import { cn } from '../../utils/cn'
import { ChevronRightIcon, PhoneIcon } from '../icons'
import AssistantRow from './AssistantRow'
import { ASSISTANT_BUBBLE, USER_BUBBLE } from './bubbleStyles'
import Markdown from './Markdown'

// A voice call collapses to one line in the chat; click to unfold the transcript,
// which rides on the marker itself so it survives a reload with the session.
function CallMarker({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const turns = message.turns ?? []
  // Nothing to show for calls that failed before anyone spoke, or old markers with no turns.
  const expandable = turns.length > 0

  return (
    <div className="animate-rise-in flex flex-col gap-3 py-1">
      {/* Only the pill is centred; the transcript below it is not. */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          className="group flex items-center gap-2 rounded-full bg-neutral-800 px-4 py-1.5 text-xs font-medium text-neutral-400 transition duration-150 ease-out enabled:hover:bg-neutral-700 enabled:hover:text-neutral-200 enabled:active:scale-95 disabled:cursor-default"
        >
          <PhoneIcon className="size-3.5" />
          {message.content}

          {/* Hover hint. 0fr → 1fr is the only width transition that works on
              text of unknown length: the grid column measures it and the browser
              interpolates. aria-hidden since aria-expanded already conveys this.
              `-ml-2` cancels the flex gap-2 so the collapsed pill keeps its
              width; inner `pl-2` hands the spacing back as it opens. */}
          {expandable && (
            <span
              aria-hidden="true"
              className="-ml-2 grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]"
            >
              <span className="overflow-hidden">
                <span className="whitespace-nowrap pl-2 text-neutral-500">
                  {open ? 'Click to hide transcription' : 'Click to see transcription'}
                </span>
              </span>
            </span>
          )}

          {expandable && (
            <ChevronRightIcon
              className={`size-3.5 transition-transform duration-200 ease-out ${
                open ? 'rotate-90' : ''
              }`}
            />
          )}
        </button>
      </div>

      {open && (
        <div className="animate-rise-in flex w-full flex-col gap-3">
          {turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="flex flex-col items-end">
                <p className={cn(USER_BUBBLE, 'max-w-[75%] whitespace-pre-wrap')}>{turn.text}</p>
              </div>
            ) : (
              // AssistantRow owns the mark offset and 75% column so a spoken reply
              // can't drift out of step with a typed one.
              <AssistantRow key={turn.id}>
                <p className={cn(ASSISTANT_BUBBLE, 'w-full whitespace-pre-wrap')}>{turn.text}</p>
              </AssistantRow>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export default function MessageBubble({ message }: { message: Message }) {
  const { retry } = useChat()

  if (message.kind === 'call') return <CallMarker message={message} />

  if (message.role === 'assistant') {
    return (
      <AssistantRow className="animate-rise-in">
        {/* whitespace-pre-wrap lives on each paragraph Markdown emits; a code
            block sets its own whitespace rules. */}
        <div className={cn(ASSISTANT_BUBBLE, 'w-full')}>
          <Markdown text={message.content} />
        </div>
        {/* Flag a cut-off reply in place, quietly, rather than in a red banner. */}
        {message.truncated && (
          <span className="animate-fade-in px-2 text-xs text-neutral-500">
            Reply cut off
          </span>
        )}
      </AssistantRow>
    )
  }

  return (
    <div className="animate-rise-in flex flex-col items-end">
      <div
        className={cn(
          USER_BUBBLE,
          'max-w-[75%] whitespace-pre-wrap transition-opacity duration-200',
          message.status === 'failed' && 'opacity-60',
        )}
      >
        {message.content}
      </div>
      {message.status === 'failed' && (
        <div className="animate-fade-in mt-1 flex items-center gap-2 text-xs text-red-400">
          <span>Failed to send</span>
          <button
            type="button"
            onClick={retry}
            className="rounded font-medium underline transition duration-150 ease-out hover:text-red-300 active:scale-95"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}
