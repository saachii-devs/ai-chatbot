// The contract for voice: what a voice service can do, without saying how.
// Callback-based because a call is many events arriving unpredictably.

export interface VoiceEventHandlers {
  onOpen: () => void
  // A live interim guess — may still change as you keep talking.
  onInterim: (text: string) => void
  // A finished utterance — becomes a chat message.
  onFinal: (text: string) => void
  // User started talking over the reply. Fires once, within ~200ms of the first
  // syllable, before transcription; the caller should cut the reply off here.
  onBargeIn: () => void
  // The mic went away mid-session: unplugged, or seized by another app (a phone
  // call, another tab). Distinct from onError — nothing is broken, the input is
  // simply gone, and the session cannot continue without it.
  onMicLost: () => void
  onError: (err: VoiceServiceError) => void
  onClose: () => void
  // Transport dropped and is being re-established; the mic stays open. Optional:
  // a provider that cannot drop mid-call never fires it.
  onReconnecting?: () => void
}

export interface VoiceService {
  // Does this browser have what this provider needs? Checked before offering
  // voice at all, so an unsupported browser shows a disabled button rather than
  // a session that dies on start.
  isSupported(): boolean
  // Ask for the mic, open the connection. Rejects on mic denial / missing key.
  startListening(handlers: VoiceEventHandlers): Promise<void>
  // Close the connection, stop the recorder, release the mic — always all three.
  stopListening(): void
  // Speak the text aloud; resolves when playback ends (or is aborted).
  //
  // `onProgress` reports where in `text` the VOICE currently IS. It is what lets
  // the caption keep time with the speech instead of racing ahead of it: the
  // reply text exists in full long before it is said aloud, so anything driven
  // off the text alone would show the words before they were spoken.
  speak(text: string, signal?: AbortSignal, onProgress?: SpeechProgress): Promise<void>
  // Live analyser of what the MIC hears, never the reply. Null when no call runs.
  getAnalyser(): AnalyserNode | null
}

// The index of the character being spoken RIGHT NOW — not a count of characters
// finished.
//
// The difference is the whole game. Reporting "characters completed" means a
// word can only light once the voice has left it, which reads as a permanent
// one-word lag. Reporting where the voice IS lets the caption light the word as
// it is said. It also frees us from SpeechSynthesisEvent.charLength, which most
// engines leave at 0 — deriving a word's end from it silently reintroduces the lag.
export type SpeechProgress = (charIndex: number) => void

export type VoiceErrorKind =
  | 'missing_key'
  | 'mic_denied'
  | 'connection'
  | 'tts_failed'
  // Browser refused to play the reply (autoplay policy).
  | 'autoplay_blocked'
  // This browser has no implementation for the selected provider.
  | 'unsupported'
  // The mic was taken away mid-session (unplugged, or claimed by another app).
  | 'mic_lost'
  // The model took longer than we are willing to hold the mic open for.
  | 'reply_timeout'
  // The mic was open but nothing was ever said.
  | 'no_speech'

// Every provider needs a mic and an audio graph; what differs is what it does
// with them. Shared so both implementations answer isSupported() the same way
// about the parts they have in common.
export function hasMicAndAudio(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window !== 'undefined' &&
    typeof (window.AudioContext ??
      (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) !==
      'undefined'
  )
}

export class VoiceServiceError extends Error {
  readonly kind: VoiceErrorKind

  constructor(kind: VoiceErrorKind) {
    super(`voice service error: ${kind}`)
    this.name = 'VoiceServiceError'
    this.kind = kind
  }
}
