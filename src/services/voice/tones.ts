// The two sounds a call makes: a rising pair of blips when it connects, a
// falling pair when it ends. Synthesized rather than shipped as audio files —
// they are two sine waves and an envelope, so a file would cost a network
// request, a decode, and a binary asset to keep in sync with nothing.
//
// Rising means "you are on", falling means "you are off". That direction is the
// whole message: it is the one thing a listener reads without being taught, and
// it is why every phone in the world does it this way.

/** freq in Hz, at/dur in seconds from the start of the sequence. */
interface Blip {
  freq: number
  at: number
  dur: number
}

const CONNECT: readonly Blip[] = [
  { freq: 660, at: 0, dur: 0.09 },
  { freq: 880, at: 0.1, dur: 0.14 },
]

const DISCONNECT: readonly Blip[] = [
  { freq: 660, at: 0, dur: 0.09 },
  { freq: 440, at: 0.1, dur: 0.18 },
]

/**
 * Quiet on purpose. The connect tone plays with the mic already open, and a
 * loud one would come back through the transcriber as a word. At this level the
 * echo canceller and the noise gate both swallow it.
 */
const PEAK_GAIN = 0.07

/** Long enough that the note has a body, short enough that it never clicks. */
const ATTACK_SECONDS = 0.008

// One context for the life of the tab. Browsers cap live AudioContexts per page,
// and a call is not the only thing that opens one — the capture graph and the
// TTS playback graph each hold theirs for as long as the call runs.
let toneContext: AudioContext | null = null

function context(): AudioContext | null {
  try {
    toneContext ??= new AudioContext()
    // Created before a gesture, or suspended by a backgrounded tab. Ask for it
    // back and play anyway: if the resume lands late the tone is simply missed,
    // which is the correct outcome for a sound nobody is waiting on.
    if (toneContext.state !== 'running') void toneContext.resume().catch(() => {})
    return toneContext
  } catch {
    return null // no Web Audio here — a call without its tones is still a call
  }
}

function play(blips: readonly Blip[]): void {
  const ctx = context()
  if (!ctx) return

  // A hair in the future: scheduling at exactly currentTime races the audio
  // thread, and a note whose start has already passed begins mid-envelope.
  const start = ctx.currentTime + 0.01

  for (const blip of blips) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = blip.freq

    const at = start + blip.at
    const end = at + blip.dur

    // Ramp in, then decay exponentially — an oscillator switched on and off at
    // full amplitude clicks at both ends, because the waveform jumps to and from
    // zero on a discontinuity the speaker cone has to chase.
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + ATTACK_SECONDS)
    // exponentialRamp cannot reach zero, so it approaches it and the stop() cuts
    // the remainder — by which point it is 60dB down and inaudible.
    gain.gain.exponentialRampToValueAtTime(0.0001, end)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(at)
    osc.stop(end)
    // The nodes are garbage once they have played; releasing the graph edge lets
    // them go rather than leaving one per tone attached to the destination.
    osc.onended = () => gain.disconnect()
  }
}

/** Rising. The call is live and the mic is open. */
export function playConnectTone(): void {
  play(CONNECT)
}

/** Falling. The call is over — hung up, or dead. */
export function playDisconnectTone(): void {
  play(DISCONNECT)
}
