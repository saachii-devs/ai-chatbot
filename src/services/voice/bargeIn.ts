import type { VoiceConfig } from '../env'

// Decides whether the sound arriving over the top of a reply is a PERSON taking
// the floor back, or just the room. Shared by both providers, because both have
// the same three things to reject and no reason to disagree about them.
//
// Each of the three defeats a different test on its own, so all three run:
//
//   a dropped pen      is LOUD          — level alone lets it through
//   a keyboard, a desk are SUSTAINED    — time alone lets them through
//   the assistant's
//   own voice echoing  is SPEECH        — the spectrum alone lets it through
//
// and only a human clears all three at once.
//
// The echo is the hard one, and it is worth being explicit about why: it is
// sustained, and it is speech, in the voice band. Neither the hold nor the
// spectral test can see any difference between the assistant and a human. LEVEL
// is the only axis left — which is why the level bar is not a constant but is
// measured, per reply, against what the mic is actually hearing from the speakers.

const TICK_MS = 50

// The speech band, and BOTH tests are confined to it — the level one as much as the
// spectral one. That is the point, and it is worth being precise about why.
//
// Loudness used to be the RMS of the raw waveform, and RMS is dominated by
// low-frequency energy. A deep voice puts a great deal of power near its
// fundamental; a higher-pitched one spreads less power, higher up. So two people
// speaking at the same apparent loudness produced very different numbers, and the
// bar that one of them cleared by talking, the other could only clear by SHOUTING.
// The detector was not measuring how loud someone was. It was measuring how much
// low end they had.
//
// Measuring the level inside the band instead makes it pitch-neutral: it asks how
// much SPEECH energy is present, which is the question we actually meant. It also
// makes the level test do work it could not do before — a knock on the desk arrives
// through the desk almost entirely below 200Hz, so band-limited it barely registers
// as loud at all, and now fails on level rather than relying on the sustain filter
// to catch it later.
//
// 200–5000Hz, not the 300–3400Hz telephone band this started as. That band was
// drawn around male speech intelligibility on a phone line: it clips a higher
// voice's fundamental at the bottom and its upper formants and sibilance at the
// top, which is exactly the energy that was being thrown away.
const VOICE_LOW_HZ = 200
const VOICE_HIGH_HZ = 5000
// Butterworth: flat in the passband. The default Q of 1 puts a resonant bump right
// at the corner, which would add gain at 200Hz — the very rumble we are excluding.
const FILTER_Q = 0.707
// The denominator's ceiling, in Hz — NOT "up to Nyquist". The two providers run
// at different sample rates (16kHz hosted, ~48kHz browser), so a denominator that
// ran to Nyquist would sum to 8kHz on one and 24kHz on the other. The same speech
// would then score differently on each, and one configured ratio could not mean
// the same thing in both. Fixing the band in Hz is what makes the constant portable.
const BAND_HIGH_HZ = 8000

// Our own analyser, not the provider's. Theirs is shared with the visualizer,
// which sizes its buffers against a specific fftSize and smooths its spectrum over
// time (smoothingTimeConstant 0.8) to stop the bars shivering. Both are right for
// drawing and wrong for deciding: the smoothing is a low-pass over the very
// transients we are trying to recognise, and this detector does its own integration
// over time and must be handed each frame raw.
const FFT_SIZE = 1024

// The assistant's voice comes back into the mic through the speakers. Echo
// cancellation reduces it; nothing removes it, and how much survives depends on the
// speakers, the volume, the room, and — worst — whether the browser can even see
// the output device (route the audio to an HDMI monitor and the canceller has no
// reference at all, so essentially none of it is removed). No fixed threshold
// survives that spread. So measure it instead.
//
// The window at the top of a reply is safe to treat as "assistant only": it opens
// when playback starts, a beat after the user finished asking. Its only cost is
// that the first quarter-second of a reply cannot be interrupted, which nobody will
// ever notice.
const ECHO_CALIBRATION_MS = 250

// After that window the floor may FALL, but it may never RISE. That asymmetry is
// not a tuning choice, it is the fix for a trap this detector fell into:
//
// The floor used to chase the level it heard, in both directions, whenever no
// evidence had accumulated. But "no evidence has accumulated" is precisely the
// state you are in while someone is talking and FAILING to clear the bar — so
// their voice trained the floor upward, which raised the bar to three times their
// voice, which guaranteed they failed again. The bar ran away from them as fast as
// they chased it, and speaking louder only fed it. Once the seed came in high (a
// louder speaker, a canceller that lost its reference) the user was locked out of
// interrupting for the rest of the call, in a way no amount of shouting could fix.
//
// A floor that can only fall cannot do that. The assistant's echo is what seeds it,
// and the margin below is what carries a swell in the assistant's voice.
const FLOOR_FALL = 0.02

// Evidence, not ticks. `+1` for a tick that looks like a voice, `-2` for one that
// does not, so a sound has to be voice-like more than two-thirds of the time to
// grow. That asymmetry is doing real work: a symmetric counter random-walks upward
// over a thirty-second reply, and would eventually fire on nothing in particular.
// It also survives the dip between two syllables — the closure before a plosive is
// a real silence, not a figure of speech — which a hard reset to zero would not.
const SCORE_ATTACK = 1
const SCORE_DECAY = 2

export interface BargeInDetector {
  // The assistant has the floor. Begin judging — after measuring the echo.
  arm(): void
  // It no longer does (it finished, was cut off, or the call ended).
  disarm(): void
  // Session teardown: the timer and the analyser must not outlive the mic.
  dispose(): void
}

// Takes the mic SOURCE node, and builds its own analyser off it (see FFT_SIZE).
// It must be the mic's: a provider's getAnalyser() hands out the TTS analyser while
// speaking, and feeding the assistant's own output to this would make it interrupt
// itself instantly, every time.
export function createBargeInDetector(
  source: AudioNode,
  config: VoiceConfig,
  onBargeIn: () => void,
): BargeInDetector {
  const ctx = source.context

  // TWO taps off the mic, because the two tests want different signals.
  //
  // The LEVEL tap is band-limited first, so its RMS is the loudness of the speech
  // band alone and says nothing about how deep the speaker's voice is. Filtering in
  // the time domain rather than summing FFT bins is deliberate: the RMS that comes
  // out is a true RMS on the same honest 0..1 scale the thresholds are written in,
  // instead of a number reconstructed from windowed bin magnitudes whose scaling
  // would have to be reverse-engineered from the spec and would drift with fftSize.
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = VOICE_LOW_HZ
  highpass.Q.value = FILTER_Q

  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = VOICE_HIGH_HZ
  lowpass.Q.value = FILTER_Q

  const levelAnalyser = ctx.createAnalyser()
  levelAnalyser.fftSize = FFT_SIZE
  levelAnalyser.smoothingTimeConstant = 0
  source.connect(highpass).connect(lowpass).connect(levelAnalyser)

  // The SPECTRAL tap is deliberately NOT filtered. Its whole job is to ask what
  // fraction of the sound lives in the speech band — and you cannot ask that of a
  // signal from which everything outside the speech band has already been removed.
  // The thump and the click have to still be there to count against the ratio.
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0
  source.connect(analyser)

  const timeData = new Float32Array(levelAnalyser.fftSize)
  const freqData = new Float32Array(analyser.frequencyBinCount)

  // Bin geometry, derived rather than assumed: the two providers disagree about
  // the sample rate, so the bin a given frequency lands in differs between them.
  const binHz = source.context.sampleRate / analyser.fftSize
  const lastBin = analyser.frequencyBinCount - 1
  const binOf = (hz: number) => Math.min(lastBin, Math.round(hz / binHz))
  // From bin 1, never bin 0: bin 0 is DC, and a mic with any DC offset would park
  // a large constant in the denominator and hold the ratio down for the whole call.
  const bandLowBin = 1
  const bandHighBin = binOf(BAND_HIGH_HZ)
  const voiceLowBin = binOf(VOICE_LOW_HZ)
  const voiceHighBin = binOf(VOICE_HIGH_HZ)

  const cutScore = Math.max(1, Math.ceil(config.bargeInHoldMs / TICK_MS))
  const calibrationTicks = Math.max(1, Math.ceil(ECHO_CALIBRATION_MS / TICK_MS))

  let timer: number | undefined
  let armedTicks = 0
  let score = 0
  let echoFloor = 0
  let lastTickAt = 0
  // Fires once per arm(); the provider re-arms for the next reply.
  let fired = false

  function tick(): void {
    if (fired) return

    // Wall clock, not tick count. A starved event loop — a background tab throttled
    // to one callback a second, a long render blocking the thread — delivers ticks
    // late, and counting them as if they were 50ms apart would let six of them add
    // up to "sustained for 300ms" when six seconds had actually passed, over stale
    // analyser data. A gap that big is not evidence of anything; throw it away.
    const now = performance.now()
    const elapsed = now - lastTickAt
    lastTickAt = now
    if (elapsed > TICK_MS * 3) {
      score = 0
      return
    }

    // Band-limited: the loudness of the speech in the room, not the loudness of the
    // speaker's low end. See VOICE_LOW_HZ.
    levelAnalyser.getFloatTimeDomainData(timeData)
    const rms = rmsOf(timeData)

    // Still hearing the assistant alone: learn how loud it comes back, judge nothing.
    if (armedTicks < calibrationTicks) {
      armedTicks++
      echoFloor = Math.max(echoFloor, rms)
      return
    }

    // The configured floor is the lower bound (on headphones there is no echo, and
    // it is all that stands between a desk fan and an interruption); the measured
    // echo raises it (in a room with loud speakers, the echo is what you actually
    // have to beat).
    //
    // And bargeInMaxRms caps the result, which is the part that must not be dropped.
    // Without a ceiling, a badly-cancelled echo can push this bar above anything a
    // human throat can produce — and an unreachable bar does not look like a bad
    // threshold, it looks like the feature is broken. Better to risk the assistant
    // clipping itself occasionally than to silently take away the user's ability to
    // interrupt at all, which they cannot diagnose and cannot work around.
    const threshold = Math.min(
      Math.max(config.bargeInRms, echoFloor * config.bargeInFloorMultiplier),
      Math.max(config.bargeInRms, config.bargeInMaxRms),
    )

    // The spectral test is only asked about sounds that were loud enough to matter —
    // the "shape" of near-silence is noise about noise, and the FFT is the expensive
    // half of this tick.
    const loud = rms > threshold
    // -1 means "never asked", so the log below cannot imply a silent sound was
    // judged unvoicelike.
    const ratio = loud
      ? voiceRatio(analyser, freqData, { bandLowBin, bandHighBin, voiceLowBin, voiceHighBin })
      : -1
    const hot = loud && ratio >= config.bargeInVoiceRatio

    score = Math.min(cutScore, Math.max(0, score + (hot ? SCORE_ATTACK : -SCORE_DECAY)))

    // Downward only — see FLOOR_FALL. A rising floor is how the user's own voice
    // used to lock them out.
    if (rms < echoFloor) echoFloor += (rms - echoFloor) * FLOOR_FALL

    // Every number above is measured from the user's own microphone and room, so
    // when this misjudges them there is nothing in the source to read that would
    // explain why. Print the numbers instead.
    debugTick({
      rms,
      echoFloor,
      threshold,
      ratio,
      score,
      needed: cutScore,
      // Usually the entire diagnosis. 'quiet' with a threshold far above bargeInRms
      // means the echo has raised the bar; 'quiet' with the threshold sitting AT
      // bargeInRms means the mic itself is too quiet; 'not-voice-shaped' means the
      // level was fine and the spectral test is the thing rejecting you.
      blocked: hot ? null : loud ? 'not-voice-shaped' : 'quiet',
    })

    if (score < cutScore) return
    fired = true
    onBargeIn()
  }

  return {
    arm(): void {
      // Barge-in switched off in .env: never start the timer at all.
      if (config.bargeInRms <= 0) return
      armedTicks = 0
      score = 0
      echoFloor = 0
      fired = false
      lastTickAt = performance.now()
      window.clearInterval(timer)
      timer = window.setInterval(tick, TICK_MS)
    },
    disarm(): void {
      window.clearInterval(timer)
      timer = undefined
    },
    dispose(): void {
      window.clearInterval(timer)
      timer = undefined
      fired = true
      // Both taps, and every node in the filtered one — a biquad left hanging off
      // the mic source outlives the call that made it.
      analyser.disconnect()
      highpass.disconnect()
      lowpass.disconnect()
      levelAnalyser.disconnect()
    },
  }
}

// One line per tick, in dev only, while a reply is playing. Twenty a second is a
// lot to read but the interesting ones are the ones where `blocked` changes, and a
// console filter on that is how you find them.
//
// This exists because every threshold in this file is compared against a number
// that comes out of the user's own microphone, and no amount of reading the source
// tells you what THEIR room produces. Set VITE_VOICE_BARGE_IN_DEBUG=1 to see it.
function debugTick(state: Record<string, unknown>): void {
  if (!import.meta.env.DEV || !import.meta.env.VITE_VOICE_BARGE_IN_DEBUG) return
  console.debug('[barge-in]', state)
}

// Loudness of the buffer, 0..1.
//
// Float, not the byte time-domain data the old meter used: bytes quantise to
// 1/128 ≈ 0.008, which is a third of the threshold they were being compared
// against. There is no headroom to measure a quiet voice in.
function rmsOf(samples: Float32Array): number {
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i]
  return Math.sqrt(sumSquares / samples.length)
}

// How much of the sound's power sits in the speech band, 0..1.
//
// Float, not byte, frequency data — and this is a correctness point, not a
// precision one. getByteFrequencyData returns the DECIBEL scale squashed into
// 0..255, so summing those bytes and dividing sums logarithms: the result is a
// ratio of decibels, which is not a ratio of energies and is not the quantity this
// function is named for. The float version is dBFS, which converts back to linear
// power exactly.
function voiceRatio(
  analyser: AnalyserNode,
  freqData: Float32Array<ArrayBuffer>,
  bins: {
    bandLowBin: number
    bandHighBin: number
    voiceLowBin: number
    voiceHighBin: number
  },
): number {
  analyser.getFloatFrequencyData(freqData)

  let voicePower = 0
  let totalPower = 0
  for (let i = bins.bandLowBin; i <= bins.bandHighBin; i++) {
    // Silence reads as -Infinity, which powers to a clean 0.
    const power = 10 ** (freqData[i] / 10)
    totalPower += power
    if (i >= bins.voiceLowBin && i <= bins.voiceHighBin) voicePower += power
  }

  if (totalPower <= 0) return 0
  return voicePower / totalPower
}
