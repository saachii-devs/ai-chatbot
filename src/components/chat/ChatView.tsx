import { useCall } from '../../state/CallContext'
import VoicePanel from '../voice/VoicePanel'
import MessageList from './MessageList'

// The transcript, cross-fading in as the fluid sinks. Composer and error banner
// live in <Composer/> so they persist across the home↔chat switch.
//
// Starting voice clears this screen: the transcript slides up out of the
// viewport and the voice interface takes its place. Nothing is layered over
// anything — the chat leaves, voice arrives. When the session ends the messages
// slide back, now including everything that was just said.
export default function ChatView() {
  const { status } = useCall()
  const voiceActive = status !== 'idle'

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col overflow-hidden pt-16"
      style={{ opacity: 'var(--settle)' }}
    >
      {/* inert, not just hidden: the messages are still in the DOM (so they can
          slide back without a re-mount), and off-screen content must drop out of
          the tab order and the accessibility tree too. */}
      <div
        inert={voiceActive}
        className={`flex min-h-0 flex-1 flex-col transition-all duration-500 ease-out ${
          voiceActive ? '-translate-y-full opacity-0' : 'translate-y-0 opacity-100'
        }`}
      >
        <MessageList />
      </div>

      {voiceActive && <VoicePanel />}
    </div>
  )
}
