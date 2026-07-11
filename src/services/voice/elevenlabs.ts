import { env, type VoiceConfig } from '../env'
import {
  hasMicAndAudio,
  VoiceServiceError,
  type SpeechProgress,
  type VoiceEventHandlers,
  type VoiceService,
} from '../voiceService'
import { createBargeInDetector, type BargeInDetector } from './bargeIn'
import { watchMicTrack } from './micTrack'

// ElevenLabs VoiceService: STT over the Scribe realtime WebSocket (raw PCM as
// base64 JSON, authed with a single-use REST token — socket rejects raw keys);
// TTS via one REST call returning MP3 played through <audio>. Barge-in via the
// shared mic detector, which is the only thing that can hear the user while the
// reply is playing — the socket cannot, by design (see `speaking` below).

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

// How long the mic stays gated after the reply stops playing. Covers the audio
// already in flight up the socket plus the room's reverb — both of which are the
// assistant, arriving late.
const MIC_REOPEN_DELAY_MS = 400

// An interruption is only RECOGNISED once it has been going for a few hundred
// milliseconds — that is what tells a voice apart from a dropped pen. But by then
// the user is already a word into their sentence, and every buffer we spent
// deciding went up the socket as silence. So while the gate is shut, keep the real
// audio too: on a barge-in it is replayed, and Scribe hears the sentence from its
// first syllable instead of joining it halfway through.
//
// Bounded ABOVE as well as below, and that is the subtle half. This is sized to
// cover the detection delay and no more. Reach back any further and the audio being
// flushed is from a time when only the ASSISTANT was talking — so we would be
// handing Scribe a clean recording of the assistant's own voice and inviting it to
// transcribe it as something the user said. That is the phantom-utterance bug the
// mute gate exists to prevent, coming back in through a side door.
const BARGE_PREROLL_SECONDS = 0.5

export class ElevenLabsVoiceService implements VoiceService {
  private readonly config: VoiceConfig
  private readonly tokenUrl: string
  private readonly sttUrl: string
  private readonly ttsUrl: string

  // Held as a field, not just closed over in startListening, because the barge-in
  // detector fires from a timer that has no other way back to the caller.
  private handlers: VoiceEventHandlers | null = null
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
  private unwatchMic: (() => void) | null = null

  // True while the reply is coming out of the speakers. The mic is still open and
  // still hears it — echo cancellation reduces that, it does not remove it — so
  // without this the transcriber commits the ASSISTANT'S OWN WORDS as if the user
  // had said them, and the app answers itself. browser.ts has always gated on this
  // (see its onresult); this provider never did.
  private speaking = false
  // The tail after playback stops: audio already in flight up the socket, and the
  // room's own reverb, still arrive for a moment. Keep the gate shut across it, or
  // the last few words come back as a phantom utterance.
  private muteUntilMs = 0

  // The user took the floor back mid-reply. Latched for the rest of the turn: it
  // is what tells speak()'s unwind that the mic must NOT be gated on the way out
  // (see the reopen delay there), and it stops a second detection landing while
  // the first is still tearing the reply down.
  private bargedIn = false
  private detector: BargeInDetector | null = null
  // What the mic heard while the gate was shut, kept in case it turns out to have
  // been someone interrupting. See BARGE_PREROLL_SECONDS.
  private bargePreroll: Int16Array[] = []
  private bargePrerollLimit = 0

  private micIsMuted(): boolean {
    return this.speaking || Date.now() < this.muteUntilMs
  }


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

  // Streams raw PCM up a WebSocket via a ScriptProcessor, so it needs the audio
  // graph and a socket, but no speech APIs — this one works in Firefox/Safari.
  isSupported(): boolean {
    return (
      hasMicAndAudio() &&
      typeof WebSocket !== 'undefined' &&
      typeof AudioContext.prototype.createScriptProcessor === 'function'
    )
  }

  async startListening(handlers: VoiceEventHandlers): Promise<void> {
    if (!this.isSupported()) throw new VoiceServiceError('unsupported')
    const apiKey = this.config.apiKey
    if (!apiKey) throw new VoiceServiceError('missing_key')
    this.handlers = handlers
    this.closing = false
    this.reconnectAttempts = 0
    this.bargedIn = false

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

    // The mic can be taken back at any moment; the session cannot outlive it.
    this.unwatchMic = watchMicTrack(this.mediaStream, () => handlers.onMicLost())

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
          // While the assistant is audible, anything the transcriber returns is
          // the assistant — the mic is hearing the speakers. Passing it on makes
          // the app interrupt its own reply and then answer itself, which is what
          // the phantom utterances were. Drop it: nothing said over the top of the
          // assistant on THIS provider is usable, because it has no way to tell
          // the two voices apart.
          case 'partial_transcript': // interim — may still change
            if (msg.text && !this.micIsMuted()) handlers.onInterim(msg.text)
            break
          case 'committed_transcript': // final — one finished utterance
            if (msg.text?.trim() && !this.micIsMuted()) handlers.onFinal(msg.text.trim())
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
    this.bargePrerollLimit = Math.max(1, Math.ceil(BARGE_PREROLL_SECONDS / bufferSeconds))

    // Taps the mic source directly — the ONE path into this service that is still
    // open while the reply is playing, since everything the socket would have
    // carried is being replaced with silence below.
    this.detector = createBargeInDetector(this.source, this.config, () =>
      this.onBargeInDetected(),
    )

    this.processor = ctx.createScriptProcessor(BUFFER_FRAMES, 1, 1)
    this.processor.onaudioprocess = (e) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      const floats = e.inputBuffer.getChannelData(0)

      // The assistant is audible: send silence, not what the mic hears. Dropping
      // the messages alone is not enough — the server's VAD would still be
      // building an utterance out of the assistant's voice, and would commit it
      // the moment the gate reopened. Silence keeps the VAD's picture honest.
      //
      // But KEEP what we are not sending. The detector needs a few hundred ms of
      // someone talking before it will believe them, and those are the buffers
      // holding the front of their sentence.
      if (this.micIsMuted()) {
        this.resetNoiseGate()
        this.rememberBargePreroll(toPcm(floats))
        this.send(new Int16Array(floats.length))
        return
      }

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

  // Someone is talking over the reply, and the detector is satisfied they are a
  // someone. Take the floor off the assistant and give it back to them.
  private onBargeInDetected(): void {
    if (this.bargedIn || !this.speaking) return
    this.bargedIn = true
    this.detector?.disarm()

    // Silence the assistant BEFORE opening the mic, not after. onBargeIn runs the
    // caller's interrupt synchronously — abort the TTS signal, pause the <audio> —
    // so by the time the flags below drop, there is nothing left coming out of the
    // speakers for the transcriber to mistake for the user.
    this.handlers?.onBargeIn()

    // Now let the mic through. Not via muteUntilMs's usual tail: that delay exists
    // to swallow the assistant's last moments, and here it would swallow the user's
    // first ones instead.
    this.speaking = false
    this.muteUntilMs = 0

    // And hand over what they said while we were still making up our mind.
    for (const buffered of this.bargePreroll) this.send(buffered)
    this.bargePreroll.length = 0
  }

  // The last BARGE_PREROLL_SECONDS of what the mic heard while the gate was shut.
  private rememberBargePreroll(pcm: Int16Array): void {
    this.bargePreroll.push(pcm)
    if (this.bargePreroll.length > this.bargePrerollLimit) this.bargePreroll.shift()
  }

  stopListening(): void {
    // Set BEFORE closing the socket, or onclose reads the hang-up as a drop
    // and reconnects the call the user just ended.
    this.closing = true
    this.speaking = false
    this.muteUntilMs = 0
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectAttempts = 0

    // Its interval and its analyser would otherwise outlive the mic they are
    // attached to.
    this.detector?.dispose()
    this.detector = null
    this.bargedIn = false
    this.bargePreroll.length = 0

    // Before the tracks are stopped below: stopping one fires 'ended', which
    // would report our own hang-up as the mic being snatched away.
    this.unwatchMic?.()
    this.unwatchMic = null

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
    this.handlers = null
  }

  async speak(
    text: string,
    signal?: AbortSignal,
    onProgress?: SpeechProgress,
  ): Promise<void> {
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

    // The body read can fail on its own (the connection drops mid-download), and it
    // has to happen INSIDE the try: out here its raw DOMException would escape as
    // something other than a VoiceServiceError, and the blob URL minted on the next
    // line would never reach the revoke in `finally`.
    // Held outside the try so `finally` can tear the graph down on any exit — and
    // so both survive a throw from the body read itself.
    let url = ''
    let element: HTMLAudioElement | null = null
    let disconnectAnalyser: (() => void) | null = null
    let progressRaf = 0
    try {
      const blob = await response.blob()
      url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      element = audio

      // Hang-up can land in any await above; bail before making a sound.
      if (signal?.aborted) return

      this.audio = audio
      disconnectAnalyser = this.analyseTts(audio)

      // Shut the mic's path to the transcriber for as long as we are audible.
      // Set BEFORE play(), or the first syllable is already on its way up the
      // socket by the time the flag lands.
      this.speaking = true
      // The mic is shut to the SOCKET, not to us: the analyser still hears the
      // room, and the detector is what listens for the user through the reply.
      this.bargedIn = false
      this.bargePreroll.length = 0
      this.detector?.arm()

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

        // An MP3 carries no word boundaries, so where the voice IS gets
        // interpolated from how far into the audio we are.
        //
        // Sampled per FRAME, not from 'timeupdate': that event fires only ~4×
        // a second, so the highlight advanced in visible jumps. requestAnimation-
        // Frame reads the same playback clock 60× a second, which is what makes
        // the sweep smooth. It is tied to the audio clock either way, so it can
        // never run ahead of the voice.
        //
        // Weighted by characters, so long words are dwelt on and short ones
        // passed over — closer to how speech actually paces than counting words
        // evenly would be.
        const tick = () => {
          const { currentTime, duration } = audio
          // A streamed blob reports Infinity until its metadata lands.
          if (Number.isFinite(duration) && duration > 0) {
            onProgress?.(Math.round((currentTime / duration) * text.length))
          }
          progressRaf = requestAnimationFrame(tick)
        }
        progressRaf = requestAnimationFrame(tick)

        audio.onended = () => {
          onProgress?.(text.length)
          resolve()
        }
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
      this.detector?.disarm()
      this.speaking = false
      // Reopen the mic, but not instantly: audio captured while it was still
      // talking is already in flight up the socket, and the room's reverb lags
      // the speaker. Reopening on the same tick lets that tail come back as a
      // phantom utterance — the very thing this gate exists to stop.
      //
      // Unless we were interrupted. Then the mic is ALREADY open (onBargeInDetected
      // opened it, and has been feeding the socket for a moment) and the user is
      // mid-sentence — so re-shutting it for 400ms here would cut a hole in the
      // middle of the very utterance we stopped talking in order to hear.
      this.muteUntilMs = this.bargedIn ? 0 : Date.now() + MIC_REOPEN_DELAY_MS

      // The frame loop outlives the promise on every exit path — abort, error,
      // end — and would otherwise run for the life of the tab, driving a caption
      // that is no longer on screen.
      cancelAnimationFrame(progressRaf)
      disconnectAnalyser?.()
      // Only if we still own the element: an interruption starts the next turn
      // before this unwinds, and clobbering its audio would mute that reply.
      if (element && this.audio === element) {
        this.audio = null
      }
      if (url) URL.revokeObjectURL(url) // blob URLs leak until revoked
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
      // Finer than the mic's, because this context runs at the device rate
      // (~48kHz) rather than the 16kHz capture rate. At fftSize 256 a bin is
      // ~190Hz wide, so barely 20 bins cover the whole speech band and 56 bars
      // would fight over them. 1024 gives ~47Hz bins — plenty below 4kHz.
      analyser.fftSize = 1024
      // Damped above the 0.8 default, but only the REPLY's analyser — the mic is
      // a meter and must stay live. TTS holds a near-constant level, so averaging
      // its bins over a few more frames costs no expressiveness and takes the
      // shiver out before the visualizer ever sees it.
      analyser.smoothingTimeConstant = 0.9
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
