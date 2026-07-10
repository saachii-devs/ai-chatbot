import { useAutoScroll } from '../../hooks/useAutoScroll'
import { useChat } from '../../hooks/useChat'
import { useActiveSession } from '../../state/SessionsContext'
import MessageBubble from './MessageBubble'
import TypingIndicator from './TypingIndicator'

export default function MessageList() {
  // Scoped to the chat on screen: a reply streaming elsewhere must not put dots here.
  const { isLoading } = useChat()
  const session = useActiveSession()
  const messages = session?.messages ?? []

  // The streaming target is an empty assistant message; show dots until its first chunk.
  const last = messages[messages.length - 1]
  const showTyping = isLoading && last?.role === 'assistant' && last.content === ''
  const visible = messages.filter((m) => !(m.role === 'assistant' && m.content === ''))

  // Re-runs on every append and streamed chunk; the hook only scrolls if near the
  // bottom, and only eases the jump for an append — the one that shifts the list.
  const scrollRef = useAutoScroll(
    session?.id ?? '',
    messages.length,
    last?.content.length ?? 0,
  )

  // The composer floats over this list. A mask dissolves the messages underneath
  // instead of covering them (an opaque gradient div would hide the wave).
  const clearance = 'calc(var(--composer-h, 0px) + 3rem)'
  const fade = `linear-gradient(to top, transparent 0, #000 ${clearance})`

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-4 pt-4"
      style={{ paddingBottom: clearance, maskImage: fade, WebkitMaskImage: fade }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {visible.length === 0 && !showTyping && (
          <p className="py-10 text-center text-sm text-neutral-500">Ask me anything…</p>
        )}
        {visible.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {showTyping && <TypingIndicator />}
      </div>
    </div>
  )
}
