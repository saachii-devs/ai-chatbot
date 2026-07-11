import { memo, useEffect, useRef } from 'react'

// Gradient-blue bars over water, driven by whichever AnalyserNode holds the floor
// (mic while listening, reply audio while speaking); flat and calm when nobody does.
// Raw FFT is jittery at 60fps: each bar eases toward its target, fast up (a consonant
// snaps) and slow down (decays like a meter). The water rides the mean of the eased levels.
const BARS = 56
const ATTACK = 0.45
const RELEASE = 0.10
const MIN_HEIGHT = 3

// ── While the ASSISTANT speaks, the bars are FAKED. ──
//
// Not laziness — the honest reading is the bad one. TTS is compressed to a
// near-constant loudness, so its spectrum holds no slow movement at all: it
// shivers at syllable rate around a fixed level. Every attempt to ease that into
// something calm just produced a slower shiver at the same height, because there
// is nothing slow in the signal to follow. Nothing is lost by not showing it —
// there was no information in it worth reading.
//
// So while it talks: one slow BREATH, with an occasional larger swell on top, and
// a barely-there ripple so the row is not a rigid shape being scaled. Everything
// below is a continuous function of time — no randomness, no per-frame decision,
// nothing sampled. There is nothing here that CAN jitter, even in principle.
//
// The MIC keeps its real per-bin meter (ATTACK/RELEASE above): there the audio is
// the user's own, answering them is the whole point, and it must be true.

// Resting height. The row never collapses — the assistant is present for as long
// as it is talking, and a row that drops to nothing between swells reads as a
// dropout rather than as breathing.
const FAKE_FLOOR = 0.3
// The steady breath, in and out.
const BREATH_PERIOD_S = 3.4
const BREATH_DEPTH = 0.17
// The occasional larger swell that implies a phrase. A slow sine raised to a high
// power sits near zero MOST of the time and blooms briefly — so swells arrive
// every several seconds rather than pulsing evenly, which is what separates
// "speaking" from "a metronome".
const PULSE_PERIOD_S = 5.1
const PULSE_SHARPNESS = 6
const PULSE_DEPTH = 0.34
// A long, shallow wave along the row. Deliberately small: enough that the bars are
// not one rigid silhouette, not so much that it becomes a ripple effect.
const RIPPLE_DEPTH = 0.12
const RIPPLE_WAVELENGTH = 0.22
const RIPPLE_PERIOD_S = 4.2
// Every change is eased, including the handover between the mic's real meter and
// this — so the row flows from one into the other instead of cutting. Raised
// alongside the quicker periods above: too slow an ease and the bars lag behind
// the curves they are meant to be tracing, flattening the swells back out.
const FAKE_EASE = 0.1
// The resting silhouette: tallest mid-row, never quite zero at the ends.
const FAKE_ARCH_FLOOR = 0.45
const FAKE_ARCH_EXPONENT = 0.9

const TWO_PI = Math.PI * 2

// Two thresholds (hysteresis) so the flag doesn't chatter around one edge; the hold keeps
// it up across silent gaps between words. Set high enough that room tone never raises it —
// these are a mean of normalised FFT bins, not RMS, so the numbers don't transfer.
const SPEECH_ON = 0.13
const SPEECH_OFF = 0.07
const SPEECH_HOLD_MS = 180

// Water behind the bars: three sine layers at coprime-ish frequencies (1.4/2.3/3.6) that
// never line up, so the surface reads as water rather than a looping animation.
// Blue taken from the composer so the overlay matches the screen it opened from:
//   LIT .composer-ring:focus-within · DEEP the fluid shader's halo · TIP LIT lifted 35% toward white
const BLUE_TIP = '#78a1f2'
const BLUE_LIT = '#2f6feb'
const BLUE_LIT_RGB = '47, 111, 235'
const BLUE_DEEP_RGB = '28, 43, 148'

// lift is where a layer's water line sits (fraction of swell); amp how far it rides.
// Alphas are low because `lighter` ADDS the layers: three at 0.30 would clip to a flat
// slab where they overlap. At these values the sum peaks at 0.28, so it never saturates.
const WAVES = [
  { lift: 1.0, amp: 0.42, freq: 1.4, speed: 0.00030, alpha: 0.18 },
  { lift: 0.76, amp: 0.3, freq: 2.3, speed: -0.00046, alpha: 0.13 },
  { lift: 0.56, amp: 0.2, freq: 3.6, speed: 0.00068, alpha: 0.09 },
]
/** Tallest the water gets, as a fraction of the canvas. */
const SWELL = 0.3
/** How much of the swell is always there, before any voice lifts it. */
const SWELL_FLOOR = 0.35
/** One point per this many pixels. 3 is smooth; the curve is a shallow sine. */
const WAVE_STEP = 3
/** How hard the crests are dissolved. Large enough that no layer has an edge. */
const WAVE_BLUR = 14

function Visualizer({
  getAnalyser,
  listening,
  speaking,
  onSpeakingChange,
}: {
  getAnalyser: () => AnalyserNode | null
  listening: boolean
  speaking: boolean
  onSpeakingChange?: (speaking: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Read inside the animation frame, so toggling them never restarts the loop.
  // EVERY prop goes through a ref, without exception — including the callbacks.
  // The loop owns `levels`, the eased bar heights, and that state only exists
  // between frames: restarting the effect zeroes it, and the bars can never climb
  // above one ease step off the floor. A single unmemoised prop is enough to do
  // that on every render, which is exactly what happened here.
  const listeningRef = useRef(listening)
  listeningRef.current = listening
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking
  const onSpeakingChangeRef = useRef(onSpeakingChange)
  onSpeakingChangeRef.current = onSpeakingChange
  const getAnalyserRef = useRef(getAnalyser)
  getAnalyserRef.current = getAnalyser

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const data = new Uint8Array(128) // fftSize 256 -> 128 frequency bins
    const levels = new Float32Array(BARS)

    // The faked row's resting silhouette, computed once.
    const fakeArch = new Float32Array(BARS)
    for (let i = 0; i < BARS; i++) {
      const arch = Math.pow(Math.sin((i / (BARS - 1)) * Math.PI), FAKE_ARCH_EXPONENT)
      fakeArch[i] = FAKE_ARCH_FLOOR + (1 - FAKE_ARCH_FLOOR) * arch
    }

    let raf = 0
    let userSpeaking = false
    let quietSince = 0
    // Frozen water rather than none for reduced motion. Read once — a media query isn't free per frame.
    const stillWater = matchMedia('(prefers-reduced-motion: reduce)').matches

    /** The water, behind the bars. `level` is the mean bar height, in 0..1. */
    const drawWaves = (now: number, level: number) => {
      const { width, height } = canvas
      // The swell never fully collapses, so silence still shows water — a flat line reads as broken.
      const swell = height * SWELL * (SWELL_FLOOR + (1 - SWELL_FLOOR) * Math.min(level * 2.2, 1))
      const phase = stillWater ? 0 : now

      ctx.save()
      // No layer may read as an outlined object. blur dissolves each crest into the one
      // behind; `lighter` ADDS the layers — source-over would darken overlaps, drawing the
      // very edge the blur removes.
      ctx.filter = `blur(${WAVE_BLUR}px)`
      ctx.globalCompositeOperation = 'lighter'

      for (const wave of WAVES) {
        const base = swell * wave.lift
        const amp = base * wave.amp

        ctx.beginPath()
        // Start/end beyond the edges: the blur samples outside the path, and a path stopping
        // at x=0 fades there into a dark notch.
        ctx.moveTo(-WAVE_BLUR * 2, height)
        for (let px = -WAVE_BLUR * 2; px <= width + WAVE_BLUR * 2; px += WAVE_STEP) {
          const u = px / width
          const y = height - base - amp * Math.sin(u * wave.freq * Math.PI * 2 + phase * wave.speed)
          ctx.lineTo(px, y)
        }
        ctx.lineTo(width + WAVE_BLUR * 2, height)
        ctx.closePath()

        // Lit at the crest, dissolving into the floor — the same ramp the bars use.
        const crest = height - base - amp
        const fill = ctx.createLinearGradient(0, crest, 0, height)
        fill.addColorStop(0, `rgba(${BLUE_LIT_RGB}, ${wave.alpha})`)
        fill.addColorStop(1, `rgba(${BLUE_DEEP_RGB}, ${wave.alpha * 0.12})`)
        ctx.fillStyle = fill
        ctx.fill()
      }

      ctx.restore() // filter and composite mode are canvas state, not fill state
    }

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)

      // The assistant is talking: don't read the audio at all, animate instead.
      const isSpeaking = speakingRef.current

      // Sample only while the MIC holds the floor; else every bar targets zero and eases down.
      const analyser =
        !isSpeaking && listeningRef.current ? getAnalyserRef.current() : null
      if (analyser) analyser.getByteFrequencyData(data)

      // The whole faked row rides ONE amplitude, so every bar rises and falls
      // together — that togetherness is what makes it read as breathing rather
      // than as 56 bars each doing their own thing. Computed once per frame, not
      // per bar.
      const seconds = stillWater ? 0 : now / 1000
      let breathAmplitude = 0
      if (isSpeaking) {
        // The steady breath: a plain slow sine, in 0..1.
        const breath = 0.5 + 0.5 * Math.sin((seconds / BREATH_PERIOD_S) * TWO_PI)
        // The occasional swell: near zero most of the time, blooming briefly. The
        // power is what makes it occasional — an unraised sine would just pulse.
        const swell = Math.pow(
          0.5 + 0.5 * Math.sin((seconds / PULSE_PERIOD_S) * TWO_PI),
          PULSE_SHARPNESS,
        )
        breathAmplitude = FAKE_FLOOR + BREATH_DEPTH * breath + PULSE_DEPTH * swell
      }

      // Ease every bar before painting: the swell is a function of the mean, so it can't be
      // computed inside the drawing loop without lagging the bars a frame.
      let sum = 0
      for (let i = 0; i < BARS; i++) {
        let target: number
        let ease: number

        if (isSpeaking) {
          // The shared amplitude, wearing the arch, with a long shallow wave
          // travelling through so the row is alive rather than a scaled shape.
          const ripple =
            1 +
            RIPPLE_DEPTH *
              Math.sin(i * RIPPLE_WAVELENGTH - (seconds / RIPPLE_PERIOD_S) * TWO_PI)
          target = Math.min(1, breathAmplitude * fakeArch[i] * ripple)
          ease = FAKE_EASE
        } else {
          // The user's voice, read for real. Voice energy lives in the lower half
          // of the spectrum.
          target = analyser ? data[Math.floor((i / BARS) * (data.length / 2))] / 255 : 0
          ease = target > levels[i] ? ATTACK : RELEASE
        }

        levels[i] += (target - levels[i]) * ease
        sum += levels[i]
      }
      const level = sum / BARS

      drawWaves(now, level) // behind the bars, so they stand in it

      const slot = width / BARS
      const barWidth = Math.max(2, slot * 0.22)
      const radius = barWidth / 2

      for (let i = 0; i < BARS; i++) {
        const barHeight = Math.max(MIN_HEIGHT, levels[i] * height * 0.95)
        const x = i * slot + (slot - barWidth) / 2
        const top = height - barHeight

        // A gradient per bar, spanning THAT bar, not the canvas: one canvas-wide gradient looks
        // identical until its bottom stop goes transparent, then a short bar samples only the
        // transparent end and vanishes. Per-bar, every bar is lit at its tip and melts at its foot.
        const bar = ctx.createLinearGradient(0, top, 0, height)
        bar.addColorStop(0, BLUE_TIP)
        bar.addColorStop(0.35, BLUE_LIT)
        bar.addColorStop(1, `rgba(${BLUE_DEEP_RGB}, 0.04)`)
        ctx.fillStyle = bar

        ctx.beginPath()
        ctx.roundRect(x, top, barWidth, barHeight, radius)
        ctx.fill()
      }

      // Same numbers the bars use, so the label can't disagree — but only while the analyser
      // is the mic. During the reply these levels are the assistant's voice, which would raise "Listening…".
      if (!listeningRef.current) {
        if (userSpeaking) {
          userSpeaking = false
          quietSince = 0
          onSpeakingChangeRef.current?.(false)
        }
        return
      }

      if (!userSpeaking && level > SPEECH_ON) {
        userSpeaking = true
        onSpeakingChangeRef.current?.(true)
      } else if (userSpeaking) {
        if (level > SPEECH_OFF) quietSince = 0
        else if (quietSince === 0) quietSince = now
        else if (now - quietSince > SPEECH_HOLD_MS) {
          userSpeaking = false
          quietSince = 0
          onSpeakingChangeRef.current?.(false)
        }
      }
    }

    // Scheduled, not called: draw takes the frame timestamp; calling it by hand passes undefined.
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
    // EMPTY, and it must stay empty. Everything this loop reads is behind a ref
    // above, precisely so nothing can list a dependency here — a re-run cancels
    // the loop and throws away the animation's accumulated state.
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={720}
      height={220}
      aria-hidden="true"
      className="h-32 w-full shrink-0 sm:h-40"
    />
  )
}

// The caption updates state ~60×/second while the assistant speaks, re-rendering
// VoicePanel every frame. None of that concerns the canvas — it paints itself from
// its own loop — so keep the re-renders from reaching it at all.
export default memo(Visualizer)
