import { env, type VoiceConfig } from '../env'
import {
  VoiceServiceError,
  type VoiceEventHandlers,
  type VoiceService,
} from '../voiceService'

// ElevenLabs VoiceService: STT over the Scribe realtime WebSocket (raw PCM as
// base64 JSON, authed with a single-use REST token — socket rejects raw keys);
// TTS via one REST call returning MP3 played through <audio>. No barge-in here.

// Sample rates the realtime API accepts as pcm_<rate>:
const SUPPORTED_RATES = [8000, 16000, 22050, 24000, 44100, 48000]

// One ScriptProcessor buffer: 4096 frames ≈ 256ms at 16kHz, 85ms at 48kHz.
const BUFFER_FRAMES = 4096

// Gate closes at a fraction of the open level (hysteresis) so a voice that got
// in stays in through the dips between syllables.
const NOISE_GATE_CLOSE_RATIO = 0.6
// Hold the gate open this long after the level falls, so gaps within speech
// don't clip word tails.
const NOISE_GATE_HANGOVER_SECONDS = 0.3
// Buffers kept back while shut, replayed on open so the transcriber hears the
// consonant that opened the gate, not the vowel after it.
const NOISE_GATE_PREROLL_SECONDS = 0.2

// A mid-call socket drop is a transport hiccup; retry with backoff before
// giving up (mic and audio graph are still live).
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_BASE_MS = 500

export class ElevenLabsVoiceService implements VoiceService {
  private readonly config: VoiceConfig
  private readonly tokenUrl: string
  private readonly sttUrl: string
  private readonly ttsUrl: string

  private socket: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private audio: HTMLAudioElement | null = null

  // Reply audio, analysed for the visualizer. Own context, NOT the 16kHz
  // capture one, else 44.1kHz TTS resamples to an 8kHz Nyquist (telephone sound).
  private playbackContext: AudioContext | null = null
  private ttsAnalyser: AnalyserNode | null = null

  // Noise-gate state. Timings quantised to whole buffers in startPcmPump once
  // the actual sample rate is known.
  private noiseGateOpen = false
  private noiseGateJustOpened = false
  private quietBuffers = 0
  private hangoverBuffers = 1
  private prerollLimit = 0
  private preroll: Int16Array[] = []

  // `closing` separates a socket WE closed (hang-up) from one that dropped —
  // only the latter is worth reopening.
  private closing = false
  private reconnectAttempts = 0
  private reconnectTimer: number | undefined


  constructor(config: VoiceConfig = env.voice) {
    this.config = config
    const base = config.baseUrl.replace(/\/+$/, '')
    this.tokenUrl = `${base}/single-use-token/realtime_scribe`
    // Same path on the ws scheme.
    this.sttUrl = `${base.replace(/^http/, 'ws')}/speech-to-text/realtime`
    this.ttsUrl =
      `${base}/text-to-speech/${config.voiceId}` +
      `?output_format=${config.ttsOutputFormat}`
  }

  async startListening(handlers: VoiceEventHandlers): Promise<void> {
    const apiKey = this.config.apiKey
    if (!apiKey) throw new VoiceServiceError('missing_key')
    this.closing = false
    this.reconnectAttempts = 0

    // Mic first, so a denial opens nothing else. autoGainControl off: else a
    // quiet room's gain winds up until room tone reads as loud as a voice.
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      })
    } catch {
      throw new VoiceServiceError('mic_denied')
    }

    // Ask for 16kHz; browsers that ignore it (e.g. Safari) give 44.1/48kHz,
    // which the API also accepts — we declare whatever rate we got.
    this.audioContext = new AudioContext({ sampleRate: 16000 })
    const sampleRate = this.audioContext.sampleRate
    if (!SUPPORTED_RATES.includes(sampleRate)) {
      throw new VoiceServiceError('connection')
    }

    // Split out because a mid-call drop mints and reopens again.
    await this.openSocket(handlers, sampleRate)
  }

  // Mint the single-use browser token (valid ~15 min, one connection).
  private async mintToken(): Promise<string> {
    try {
      const res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'xi-api-key': this.config.apiKey },
      })
      if (res.status === 401 || res.status === 403) {
        throw new VoiceServiceError('missing_key')
      }
      if (!res.ok) throw new VoiceServiceError('connection')
      return ((await res.json()) as { token: string }).token
    } catch (err) {
      throw err instanceof VoiceServiceError ? err : new VoiceServiceError('connection')
    }
  }

  private async openSocket(
    handlers: VoiceEventHandlers,
    sampleRate: number,
  ): Promise<void> {
    const token = await this.mintToken()
    // Hung up while the token was in flight.
    if (this.closing) return

    // commit_strategy=vad → server detects the end-of-utterance pause and
    // finalizes for us.
    const socket = new WebSocket(
      `${this.sttUrl}?model_id=${this.config.sttModel}` +
        `&audio_format=pcm_${sampleRate}&commit_strategy=vad&token=${token}`,
    )
    this.socket = socket

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          message_type: string
          text?: string
          error?: string
        }
        switch (msg.message_type) {
          case 'session_started':
            // A live session proves the transport is healthy again.
            this.reconnectAttempts = 0
            handlers.onOpen()
            this.startPcmPump()
            break
          case 'partial_transcript': // interim — may still change
            if (msg.text) handlers.onInterim(msg.text)
            break
          case 'committed_transcript': // final — one finished utterance
            if (msg.text?.trim()) handlers.onFinal(msg.text.trim())
            break
          case 'auth_error':
          case 'quota_exceeded':
          case 'session_time_limit_exceeded':
            // Reopening would fail the same way — don't reconnect.
            this.closing = true
            handlers.onError(new VoiceServiceError('connection'))
            break
          case 'transcriber_error':
          case 'error':
            handlers.onError(new VoiceServiceError('connection'))
            break
          default:
            // rate_limited / commit_throttled / insufficient_audio_activity… transient.
            break
        }
      } catch {
        // a malformed message shouldn't kill the call
      }
    }

    // onerror precedes onclose and carries no actionable detail; let onclose
    // drive the reconnect.
    socket.onerror = () => {}

    socket.onclose = () => {
      // Only the socket we currently own may act; a reconnect may have replaced it.
      if (this.socket !== socket) return
      if (this.closing) {
        handlers.onClose()
        return
      }
      this.scheduleReconnect(handlers, sampleRate)
    }
  }

  // Transport dropped mid-call but mic and audio graph are still live; get it
  // back rather than dropping the call.
  private scheduleReconnect(handlers: VoiceEventHandlers, sampleRate: number): void {
    if (this.closing) return

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      handlers.onError(new VoiceServiceError('connection'))
      return
    }

    const attempt = ++this.reconnectAttempts
    handlers.onReconnecting?.()

    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(
      () => {
        if (this.closing) return
        void this.openSocket(handlers, sampleRate).catch(() => {
          // Token mint failed — one more failed attempt, not the end.
          this.scheduleReconnect(handlers, sampleRate)
        })
      },
      RECONNECT_BASE_MS * 2 ** (attempt - 1),
    )
  }

  // Pipe mic audio through the graph: each buffer → 16-bit PCM → base64 → one
  // JSON message up the socket. The source also feeds the mic analyser.
  private startPcmPump(): void {
    if (!this.audioContext || !this.mediaStream) return
    // A reconnect replays session_started; the graph survived, so a second one
    // would send every buffer twice.
    if (this.processor) return
    const ctx = this.audioContext
    this.source = ctx.createMediaStreamSource(this.mediaStream)
    this.micAnalyser = ctx.createAnalyser()
    this.micAnalyser.fftSize = 256
    this.source.connect(this.micAnalyser)

    // Gate timings in buffers, whatever rate we ended up at.
    const bufferSeconds = BUFFER_FRAMES / ctx.sampleRate
    this.hangoverBuffers = Math.ceil(NOISE_GATE_HANGOVER_SECONDS / bufferSeconds)
    this.prerollLimit = Math.ceil(NOISE_GATE_PREROLL_SECONDS / bufferSeconds)

    this.processor = ctx.createScriptProcessor(BUFFER_FRAMES, 1, 1)
    this.processor.onaudioprocess = (e) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      const floats = e.inputBuffer.getChannelData(0)
      const pcm = toPcm(floats)

      // Under the line: hold the buffer back (may be a word starting) and send
      // silence, not nothing — the silence gap tells the VAD an utterance ended.
      if (!this.passesNoiseGate(floats)) {
        this.rememberPreroll(pcm)
        this.send(new Int16Array(floats.length))
        return
      }
      if (this.noiseGateJustOpened) {
        for (const buffered of this.preroll) this.send(buffered)
        this.preroll.length = 0
      }

      this.send(pcm)
    }
    this.source.connect(this.processor)
    // ScriptProcessor only fires while connected to destination; its output
    // buffer stays silent, so nothing is echoed to the speakers.
    this.processor.connect(ctx.destination)
  }

  // One JSON frame up the socket. Server-side VAD commits for us.
  private send(pcm: Int16Array): void {
    const ctx = this.audioContext
    if (!ctx || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: int16ToBase64(pcm),
        sample_rate: ctx.sampleRate,
        commit: false, // VAD commits for us at end of utterance
      }),
    )
  }

  // Two thresholds plus a hangover so inter-syllable dips don't chop words. Sets
  // `noiseGateJustOpened` on the opening buffer — the cue to replay the preroll.
  private passesNoiseGate(floats: Float32Array): boolean {
    this.noiseGateJustOpened = false
    const openAt = this.config.noiseGateRms
    if (openAt <= 0) return true // threshold disabled: send everything

    const rms = rmsOf(floats)

    if (this.noiseGateOpen) {
      if (rms >= openAt * NOISE_GATE_CLOSE_RATIO) {
        this.quietBuffers = 0
        return true
      }
      // Quiet, but a pause within a sentence is quiet too — hold the floor.
      if (++this.quietBuffers <= this.hangoverBuffers) return true
      this.noiseGateOpen = false
      this.quietBuffers = 0
      return false
    }

    if (rms < openAt) return false
    this.noiseGateOpen = true
    this.noiseGateJustOpened = true
    this.quietBuffers = 0
    return true
  }

  // Hold back the last moments of "silence": a word may start inside them.
  private rememberPreroll(pcm: Int16Array): void {
    if (this.prerollLimit === 0) return
    this.preroll.push(pcm)
    if (this.preroll.length > this.prerollLimit) this.preroll.shift()
  }

  // Shut the gate and forget what it was holding.
  private resetNoiseGate(): void {
    this.noiseGateOpen = false
    this.noiseGateJustOpened = false
    this.quietBuffers = 0
    this.preroll.length = 0
  }

  stopListening(): void {
    // Set BEFORE closing the socket, or onclose reads the hang-up as a drop
    // and reconnects the call the user just ended.
    this.closing = true
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempts = 0

    // Tolerate any subset existing: hang-up can happen at any setup stage.
    this.audio?.pause() // stop a voice still talking after hang-up
    this.audio = null
    this.processor?.disconnect()
    this.source?.disconnect()
    this.processor = null
    this.source = null
    this.micAnalyser = null
    this.ttsAnalyser = null
    this.resetNoiseGate()
    void this.audioContext?.close().catch(() => {})
    this.audioContext = null
    // Browsers cap live AudioContexts per page; close or leak it for the tab's life.
    void this.playbackContext?.close().catch(() => {})
    this.playbackContext = null
    this.mediaStream?.getTracks().forEach((t) => t.stop()) // kills the recording dot
    this.mediaStream = null
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.socket.close()
    }
    this.socket = null
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const apiKey = this.config.apiKey
    if (!apiKey) throw new VoiceServiceError('missing_key')

    let response: Response
    try {
      response = await fetch(this.ttsUrl, {
        method: 'POST',
        signal,
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: this.config.ttsModel }),
      })
    } catch {
      throw new VoiceServiceError('tts_failed')
    }
    if (!response.ok) throw new VoiceServiceError('tts_failed')

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    // Held outside the try so `finally` can tear the graph down on any exit.
    let disconnectAnalyser: (() => void) | null = null
    try {
      // Hang-up can land in either await above; bail before making a sound.
      if (signal?.aborted) return

      this.audio = audio
      disconnectAnalyser = this.analyseTts(audio)

      // play() rejects either because we paused (hang-up/barge-in, expected) or
      // the browser refused a sound (autoplay); distinguished below, not swallowed.
      let playError: unknown = null

      await new Promise<void>((resolve) => {
        // Subscribe BEFORE play(): an already-fired abort never calls the
        // listener, so registering after would miss a hang-up during play().
        if (signal?.aborted) {
          audio.pause()
          resolve()
          return
        }
        signal?.addEventListener('abort', () => {
          // Hang-up or barge-in mid-sentence: pause, resolve anyway.
          audio.pause()
          resolve()
        }, { once: true })

        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        // play() rejects if paused before it resolves; the abort listener has
        // already settled us then.
        void audio.play().catch((err: unknown) => {
          playError = err
          resolve()
        })
      })

      // An abort explains the rejection and is not a failure; anything else is.
      if (playError && !signal?.aborted) {
        throw new VoiceServiceError(
          isAutoplayBlocked(playError) ? 'autoplay_blocked' : 'tts_failed',
        )
      }
    } catch (err) {
      throw err instanceof VoiceServiceError ? err : new VoiceServiceError('tts_failed')
    } finally {
      disconnectAnalyser?.()
      // Only if we still own the element: an interruption starts the next turn
      // before this unwinds, and clobbering its audio would mute that reply.
      if (this.audio === audio) {
        this.audio = null
      }
      URL.revokeObjectURL(url) // blob URLs leak until revoked
    }
  }

  // Route the reply through an analyser for the visualizer. createMediaElementSource
  // REROUTES the element, so on failure leave it untouched and playing (returns null).
  private analyseTts(audio: HTMLAudioElement): (() => void) | null {
    try {
      // Default sample rate (see playbackContext). One context per call; only
      // the source node is per-element.
      this.playbackContext ??= new AudioContext()
      const ctx = this.playbackContext

      // A suspended context swallows the reply while play() still resolves, so
      // nothing notices. Leave it uncaptured; request a resume for next turn.
      if (ctx.state !== 'running') {
        void ctx.resume().catch(() => {})
        return null
      }

      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256 // 128 bins, matching the mic analyser
      source.connect(analyser)
      analyser.connect(ctx.destination) // without this the reply is silent
      this.ttsAnalyser = analyser

      return () => {
        source.disconnect()
        analyser.disconnect()
        // A barge-in can start the next turn before this unwinds; don't clear
        // that turn's live analyser.
        if (this.ttsAnalyser === analyser) this.ttsAnalyser = null
      }
    } catch {
      return null
    }
  }

  getAnalyser(): AnalyserNode | null {
    // Whoever holds the floor: the TTS analyser while speaking, else the mic.
    return this.ttsAnalyser ?? this.micAnalyser
  }
}

// Autoplay refusal: all browsers reject play() with NotAllowedError (name is
// stable, message text is not) when the tab has no audio permission.
function isAutoplayBlocked(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError'
}

// Loudness of one buffer: RMS of its samples, in 0..1.
function rmsOf(floats: Float32Array): number {
  let sumSquares = 0
  for (let i = 0; i < floats.length; i++) sumSquares += floats[i] * floats[i]
  return Math.sqrt(sumSquares / floats.length)
}

// Float samples (-1..1) → 16-bit PCM, the only format the socket accepts.
function toPcm(floats: Float32Array): Int16Array {
  const pcm = new Int16Array(floats.length)
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
