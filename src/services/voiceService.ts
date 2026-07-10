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
  onError: (err: VoiceServiceError) => void
  onClose: () => void
  // Transport dropped and is being re-established; the mic stays open. Optional:
  // a provider that cannot drop mid-call never fires it.
  onReconnecting?: () => void
}

export interface VoiceService {
  // Ask for the mic, open the connection. Rejects on mic denial / missing key.
  startListening(handlers: VoiceEventHandlers): Promise<void>
  // Close the connection, stop the recorder, release the mic — always all three.
  stopListening(): void
  // Speak the text aloud; resolves when playback ends (or is aborted).
  speak(text: string, signal?: AbortSignal): Promise<void>
  // Live analyser of what the MIC hears, never the reply. Null when no call runs.
  getAnalyser(): AnalyserNode | null
}

export type VoiceErrorKind =
  | 'missing_key'
  | 'mic_denied'
  | 'connection'
  | 'tts_failed'
  // Browser refused to play the reply (autoplay policy).
  | 'autoplay_blocked'
  // This browser has no implementation for the selected provider.
  | 'unsupported'

export class VoiceServiceError extends Error {
  readonly kind: VoiceErrorKind

  constructor(kind: VoiceErrorKind) {
    super(`voice service error: ${kind}`)
    this.name = 'VoiceServiceError'
    this.kind = kind
  }
}
