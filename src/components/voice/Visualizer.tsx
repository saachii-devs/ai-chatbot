import { useEffect, useRef } from 'react'

// Gradient-blue bars over water, driven by whichever AnalyserNode holds the floor
// (mic while listening, reply audio while speaking); flat and calm when nobody does.
// Raw FFT is jittery at 60fps: each bar eases toward its target, fast up (a consonant
// snaps) and slow down (decays like a meter). The water rides the mean of the eased levels.
const BARS = 56
const ATTACK = 0.45
const RELEASE = 0.10
const MIN_HEIGHT = 3

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

export default function Visualizer({
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
  const listeningRef = useRef(listening)
  listeningRef.current = listening
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking
  const onSpeakingChangeRef = useRef(onSpeakingChange)
  onSpeakingChangeRef.current = onSpeakingChange

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const data = new Uint8Array(128) // fftSize 256 -> 128 frequency bins
    const levels = new Float32Array(BARS)
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

      // Sample only while someone holds the floor; else every bar targets zero and eases down.
      const hasFloor = listeningRef.current || speakingRef.current
      const analyser = hasFloor ? getAnalyser() : null
      if (analyser) analyser.getByteFrequencyData(data)

      // Ease every bar before painting: the swell is a function of the mean, so it can't be
      // computed inside the drawing loop without lagging the bars a frame.
      let sum = 0
      for (let i = 0; i < BARS; i++) {
        // Voice energy lives in the lower half of the spectrum.
        const target = analyser ? data[Math.floor((i / BARS) * (data.length / 2))] / 255 : 0
        const ease = target > levels[i] ? ATTACK : RELEASE
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
  }, [getAnalyser])

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
