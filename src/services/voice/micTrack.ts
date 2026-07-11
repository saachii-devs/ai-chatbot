// Watches the mic track for the input going away underneath a live session:
// the device unplugged, or another app (a phone call, a meeting tab) seizing it.
// Neither service noticed this before — the session would sit there "listening"
// to a track that had stopped producing audio.

// 'mute' is not proof of loss. A Bluetooth headset switching audio profiles
// mutes for a moment and comes back, and killing the session for that would be
// worse than the problem. So 'mute' only *arms* the end; 'unmute' disarms it.
// 'ended' is terminal by spec — that one is acted on at once.
const MUTE_GRACE_MS = 1_000

// Call the returned function to unsubscribe. Named handlers, not inline
// closures: an anonymous listener cannot be removed, and leaving these attached
// to a stopped track leaks the session it closed over.
export function watchMicTrack(stream: MediaStream, onLost: () => void): () => void {
  const track = stream.getAudioTracks()[0]
  if (!track) return () => {}

  let graceTimer: number | undefined

  const clearGrace = () => {
    window.clearTimeout(graceTimer)
    graceTimer = undefined
  }

  const onEnded = () => {
    clearGrace()
    onLost()
  }

  const onMute = () => {
    if (graceTimer !== undefined) return
    graceTimer = window.setTimeout(() => {
      graceTimer = undefined
      onLost()
    }, MUTE_GRACE_MS)
  }

  // It came back — a routing blip, not a seizure.
  const onUnmute = () => clearGrace()

  track.addEventListener('ended', onEnded)
  track.addEventListener('mute', onMute)
  track.addEventListener('unmute', onUnmute)

  return () => {
    clearGrace()
    track.removeEventListener('ended', onEnded)
    track.removeEventListener('mute', onMute)
    track.removeEventListener('unmute', onUnmute)
  }
}
