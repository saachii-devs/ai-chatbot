import MessageList from './MessageList'

// The transcript, cross-fading in as the fluid sinks. Composer and error banner
// live in <Composer/> so they persist across the home↔chat switch.
export default function ChatView() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col pt-16"
      style={{ opacity: 'var(--settle)' }}
    >
      <MessageList />
    </div>
  )
}
