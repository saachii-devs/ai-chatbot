import { env, type VoiceConfig } from '../env'
import {
  hasMicAndAudio,
  VoiceServiceError,
  type SpeechProgress,
  type VoiceEventHandlers,
  type VoiceService,
} from '../voiceService'
import { watchMicTrack } from './micTrack'

// Browser-native VoiceService: SpeechRecognition (STT) + speechSynthesis (TTS),
// Chrome/Edge only (else 'unsupported'). Barge-in via an RMS mic meter; drop
// transcripts while speaking, else Chrome transcribes the assistant's own voice.

// How loud you must be to take the floor back from the assistant. Low, so a
// quiet voice can still interrupt — the hold below is what keeps room tone from
// tripping it, rather than a high bar that only a raised voice clears.
const BARGE_IN_RMS = 0.015
// Sustained for this long, so a cough or a keyboard tap is not an interruption.
// Lengthened alongside the lower threshold: the two together are the filter.
const BARGE_IN_SECONDS = 0.3
const METER_INTERVAL_MS = 50

// Chrome silently pauses synthesis after ~15s; poke resume() on a timer.
const SYNTH_KEEPALIVE_MS = 10_000

// Minimal Web Speech API shapes, named to avoid colliding with lib.dom
// declarations (absent/differing across TS versions) so it compiles either way.
interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  isFinal: boolean
  0: RecognitionAlternative
}
interface RecognitionEvent {
  resultIndex: number
  results: { length: number } & Record<number, RecognitionResult>
}
interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onstart: (() => void) | null
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export class BrowserVoiceService implements VoiceService {
  private readonly config: VoiceConfig

  private handlers: VoiceEventHandlers | null = null
  private recognition: Recognition | null = null
  private listening = false
  private opened = false

  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private micAnalyser: AnalyserNode | null = null

  private speaking = false
  private bargedIn = false
  private hotTicks = 0
  private meterTimer: number | undefined
  private keepaliveTimer: number | undefined
  private unwatchMic: (() => void) | null = null

  constructor(config: VoiceConfig = env.voice) {
    this.config = config
  }

  // Speech recognition is Chrome/Edge only, and the RMS barge-in meter needs a
  // mic and an audio graph. Firefox and Safari have neither recogniser.
  isSupported(): boolean {
    return hasMicAndAudio() && recognitionCtor() !== null && 'speechSynthesis' in window
  }

  async startListening(handlers: VoiceEventHandlers): Promise<void> {
    // The button is gated on isSupported(); this is the backstop for anyone
    // calling in directly.
    if (!this.isSupported()) throw new VoiceServiceError('unsupported')
    const Ctor = recognitionCtor()
    if (!Ctor) throw new VoiceServiceError('unsupported')
    this.handlers = handlers
    this.listening = true
    this.opened = false

    // Mic first (analyser only; recognition opens its own) so denial surfaces early.
    // autoGainControl off: else quiet-room gain winds room tone past BARGE_IN_RMS.
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      })
    } catch {
      this.listening = false
      throw new VoiceServiceError('mic_denied')
    }

    // The mic can be taken back at any moment; the session cannot outlive it.
    this.unwatchMic = watchMicTrack(this.mediaStream, () => handlers.onMicLost())

    this.audioContext = new AudioContext()
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
    this.micAnalyser = this.audioContext.createAnalyser()
    // This context runs at the device rate (~48kHz), not the 16kHz the ElevenLabs
    // provider captures at — so a 256-point FFT would put barely 20 bins under
    // 4kHz for the visualizer's 56 bars. See the note on FREQ_MIN in Visualizer.
    this.micAnalyser.fftSize = 1024
    this.source.connect(this.micAnalyser)

    const recognition = new Ctor()
    this.recognition = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = this.config.lang

    recognition.onstart = () => {
      // Recognition restarts after every pause; the call opens once.
      if (this.opened) return
      this.opened = true
      handlers.onOpen()
    }

    recognition.onresult = (event) => {
      // Assistant speaking, no barge-in: this is our own voice echoing. Drop it.
      if (this.speaking && !this.bargedIn) return

      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0].transcript
        if (result.isFinal) {
          const final = text.trim()
          if (final) handlers.onFinal(final)
        } else {
          interim += text
        }
      }
      if (interim.trim()) handlers.onInterim(interim.trim())
    }

    recognition.onerror = (event) => {
      switch (event.error) {
        case 'no-speech':
        case 'aborted':
          return // routine: onend restarts us
        case 'not-allowed':
        case 'service-not-allowed':
          handlers.onError(new VoiceServiceError('mic_denied'))
          return
        default:
          handlers.onError(new VoiceServiceError('connection'))
      }
    }

    recognition.onend = () => {
      // continuous=true still ends on long silence; restart while the call is up.
      if (!this.listening) {
        handlers.onClose()
        return
      }
      try {
        recognition.start()
      } catch {
        // Already starting — a restart raced us. Harmless.
      }
    }

    recognition.start()
    this.startMeter()
  }

  // Watch the mic for a human talking over the assistant.
  private startMeter(): void {
    const analyser = this.micAnalyser
    if (!analyser) return
    const samples = new Uint8Array(analyser.fftSize)
    const ticksNeeded = Math.max(1, Math.ceil((BARGE_IN_SECONDS * 1000) / METER_INTERVAL_MS))

    this.meterTimer = window.setInterval(() => {
      if (!this.speaking || this.bargedIn) {
        this.hotTicks = 0
        return
      }
      analyser.getByteTimeDomainData(samples)
      let sumSquares = 0
      for (let i = 0; i < samples.length; i++) {
        const centred = (samples[i] - 128) / 128 // bytes centred on 128
        sumSquares += centred * centred
      }
      const rms = Math.sqrt(sumSquares / samples.length)
      this.hotTicks = rms > BARGE_IN_RMS ? this.hotTicks + 1 : 0

      if (this.hotTicks >= ticksNeeded) {
        this.bargedIn = true
        this.hotTicks = 0
        this.handlers?.onBargeIn()
      }
    }, METER_INTERVAL_MS)
  }

  stopListening(): void {
    this.listening = false
    this.speaking = false
    this.bargedIn = false
    this.hotTicks = 0

    window.clearInterval(this.meterTimer)
    this.meterTimer = undefined
    window.clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = undefined

    // Before the tracks are stopped: stopping one fires 'ended', which would
    // report our own hang-up as the mic being snatched away.
    this.unwatchMic?.()
    this.unwatchMic = null

    if ('speechSynthesis' in window) window.speechSynthesis.cancel()

    if (this.recognition) {
      // abort(), not stop(): stop() delivers one last result after hang-up.
      this.recognition.onend = null // and must not resurrect itself
      try {
        this.recognition.abort()
      } catch {
        // never started
      }
      this.recognition = null
    }

    this.source?.disconnect()
    this.source = null
    this.micAnalyser = null
    void this.audioContext?.close().catch(() => {})
    this.audioContext = null
    this.mediaStream?.getTracks().forEach((t) => t.stop()) // kills the recording dot
    this.mediaStream = null
    this.handlers = null
  }

  async speak(
    text: string,
    signal?: AbortSignal,
    onProgress?: SpeechProgress,
  ): Promise<void> {
    if (!('speechSynthesis' in window)) throw new VoiceServiceError('unsupported')
    if (signal?.aborted) return

    const synth = window.speechSynthesis
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = this.config.lang

    // The engine tells us which word it is saying, as it says it — exactly what
    // the caption needs, and as tight as this can get without audio analysis.
    //
    // charIndex ONLY. charLength is optional in the spec and most engines return
    // 0, so adding it to reach the word's end would, on those engines, resolve to
    // the word's start and light every word one behind the voice.
    utterance.onboundary = (event) => {
      onProgress?.(event.charIndex)
    }
    const voice = await this.resolveVoice()
    if (voice) utterance.voice = voice
    if (signal?.aborted) return // resolveVoice can await; hang-up may have landed

    this.speaking = true
    this.bargedIn = false
    this.hotTicks = 0
    // Chrome's >15s pause bug (see constant above).
    this.keepaliveTimer = window.setInterval(() => {
      if (synth.speaking) synth.resume()
    }, SYNTH_KEEPALIVE_MS)

    try {
      await new Promise<void>((resolve) => {
        // Subscribe BEFORE speak(): an already-fired abort never calls the
        // listener, hanging the promise forever.
        if (signal?.aborted) {
          resolve()
          return
        }
        signal?.addEventListener(
          'abort',
          () => {
            synth.cancel() // barge-in or hang-up: stop mid-sentence
            resolve()
          },
          { once: true },
        )

        utterance.onend = () => {
          onProgress?.(text.length) // the last word has no boundary after it
          resolve()
        }
        // A cancelled utterance fires onerror too; resolve either way.
        utterance.onerror = () => resolve()
        synth.speak(utterance)
      })
    } finally {
      window.clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
      this.speaking = false
      this.hotTicks = 0
      synth.cancel() // nothing may outlive this turn
    }
  }

  // getVoices() is empty until the OS list loads; wait once for voiceschanged,
  // but with a timeout — a default voice beats silence.
  private async resolveVoice(): Promise<SpeechSynthesisVoice | null> {
    const synth = window.speechSynthesis
    let voices = synth.getVoices()
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          synth.onvoiceschanged = null
          window.clearTimeout(timer)
          resolve()
        }
        const timer = window.setTimeout(done, 250)
        synth.onvoiceschanged = done
      })
      voices = synth.getVoices()
    }
    if (voices.length === 0) return null

    // VITE_VOICE_ID defaults to an ElevenLabs id that won't match a local
    // voice — fall through to language, then whatever exists.
    const wanted = this.config.voiceId.toLowerCase()
    return (
      voices.find((v) => v.name.toLowerCase() === wanted) ??
      voices.find((v) => v.voiceURI.toLowerCase() === wanted) ??
      voices.find((v) => v.lang === this.config.lang) ??
      voices.find((v) => v.lang.startsWith(this.config.lang.split('-')[0])) ??
      null
    )
  }

  getAnalyser(): AnalyserNode | null {
    return this.micAnalyser
  }
}
