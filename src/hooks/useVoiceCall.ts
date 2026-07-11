import { useCallback, type Dispatch } from 'react'
import { abortSession } from '../services/inFlight'
import { voiceService } from '../services/providers'
import { playConnectTone, playDisconnectTone } from '../services/voice/tones'
import { VoiceServiceError } from '../services/voiceService'
import { useCall } from '../state/CallContext'
import type { SessionsAction } from '../state/sessionsReducer'
import { useSessions } from '../state/SessionsContext'
import type { ChatSession, Message } from '../types'
import { formatDuration } from '../utils/formatDuration'
import { toSpokenText } from '../utils/toSpokenText'
import { uuid } from '../utils/uuid'
import { useChat } from './useChat'

// Drives the voice state machine. Voice is not a separate conversation any more:
// a spoken turn goes through the SAME send path a typed one does (useChat's
// sendMessage), so the utterance and the reply land in the session as ordinary
// messages. This hook adds only what is genuinely voice — the mic, the spoken
// reply, and the rules for when to hang up.
//
// Flags live at module scope so PromptBar (start), VoicePanel (stop) and
// useVoiceGuards (terminate) — three separate hook instances — drive ONE session.

// Nothing was ever said: the mic is open to an empty room.
const NO_SPEECH_TIMEOUT_MS = 20_000
// A gap after a real exchange. Longer, because a pause to think is not an empty room.
const IDLE_SILENCE_TIMEOUT_MS = 30_000

// How long we wait for the model's FIRST token — not for the whole reply. It is
// disarmed the moment text starts arriving, so a long answer streams for as long
// as it needs to; only a model that never STARTS is a hung one.
//
// This used to wrap the entire send, which meant a perfectly healthy reply that
// took more than 20s to stream was guillotined mid-sentence: the call hung up and
// the half-finished text was left sitting in the chat, never spoken. That is the
// bug this constant's meaning change fixes.
//
// Deliberately ABOVE the chat service's own FIRST_TOKEN_TIMEOUT_MS (30s). Whoever
// fires first writes the error the user reads, and the service's is the better one
// — it knows why. This is only the backstop for a send that wedges without even
// reaching the network.
const FIRST_TOKEN_TIMEOUT_MS = 35_000

// A dead TTS key (or a bad voice id) silences EVERY turn identically. One failure
// is bad luck and the run goes on; a second in a row is a broken configuration, and
// letting the user keep talking into a void is worse than telling them.
const MAX_CONSECUTIVE_TTS_FAILURES = 2

// An interruption cannot be judged from transcripts at all, and that is what the
// providers' barge-in detectors are for. The transcriber only commits at
// end-of-utterance, and on the hosted provider the mic is gated shut the moment the
// reply becomes audible — so an interruption that waits for a commit arrives after
// the mute has already swallowed it, i.e. never. It has to be heard as SOUND, by a
// meter on the mic, while the user is still mid-sentence. See voice/bargeIn.ts.

let callActive = false
let processingTurn = false
let ttsAbort: AbortController | null = null
let idleTimer: number | undefined
let silenceTimer: number | undefined
let replyTimer: number | undefined

// Bumped when a turn is superseded or the session ends. A turn captures this at
// its start and compares before touching state, so an interrupted turn still
// unwinding out of a fetch or <audio> can't drag the UI back.
let generation = 0

// The session this voice run is bound to. Everything spoken lands here, and
// switching away from it ends the run.
let boundSessionId: string | null = null
// Voice started from the home screen has no session yet. The first utterance
// makes sendMessage create one — which looks exactly like the user navigating,
// so the switch guard would kill the run it just started. This flag says "the
// next session to appear is mine, adopt it, don't treat it as a switch".
let adoptNextSession = false

// The "Voice call · 2m 34s" header in the transcript. Written at the first
// utterance (not at connect — a session nobody speaks into leaves no trace and
// no empty chat), and stamped with its duration when the run ends. Everything
// said during the run appears BENEATH it as ordinary messages; it is a heading
// for them, not a container.
let markerId: string | null = null
let callStartedAtMs: number | null = null

// Has anything at all been said? Decides which silence timeout applies.
let hasSpoken = false
// Consecutive turns whose reply could not be spoken. Reset by any turn that is.
let ttsFailures = 0
// onOpen fires again after a transport reconnect. A reconnect is not a new call:
// re-chiming would announce a drop the user never noticed.
let connectedOnce = false
// The transcriber's last committed utterance, kept to recognise it if it returns
// as a partial. See onInterim.
let lastFinalText = ''

// Turns run one at a time. Barge-in aborts the previous turn, but sendMessage
// releases its slot in the inFlight map asynchronously — so without this chain
// the next utterance can arrive while the old one is still unwinding and be
// dropped by sendMessage's own "already sending" guard.
let queue: Promise<void> = Promise.resolve()

// Refreshed on every render of every instance. The handlers below are captured
// ONCE, at startCall, so anything they close over is frozen for the whole run —
// reading a render-old `state` would resend a stale history and create a second
// session on the next turn.
let latestSend:
  | ((
      text: string,
      opts?: { sessionId?: string; onChunk?: (chunk: string) => void },
    ) => Promise<string | null>)
  | null = null
let latestActiveSessionId: string | null = null
let latestDispatch: Dispatch<SessionsAction> | null = null

// The permission handle, held so the subscription can be dropped at teardown.
let micPermission: PermissionStatus | null = null

export function isVoiceActive(): boolean {
  return callActive
}

export function getBoundSessionId(): string | null {
  return boundSessionId
}

export function bindSession(sessionId: string): void {
  boundSessionId = sessionId
}

// True exactly once per pending adoption: the session about to appear is the one
// this run just created, not one the user navigated to.
export function consumeSessionAdoption(): boolean {
  if (!adoptNextSession) return false
  adoptNextSession = false
  return true
}

// The session a turn streams into. Bound as soon as one exists; before that
// (first utterance from home) fall back to whatever is active.
function voiceSessionId(): string | null {
  return boundSessionId ?? latestActiveSessionId
}

// Take the floor from the turn in flight: stop the reply mid-fetch/mid-sentence.
// The chat abort goes through the shared inFlight registry, so sendMessage's own
// catch dispatches REPLY_CANCELED — which keeps the partial text and marks it
// truncated. That is precisely what a barge-in is.
function interrupt(): void {
  generation++
  processingTurn = false
  const sessionId = voiceSessionId()
  if (sessionId) abortSession(sessionId)
  ttsAbort?.abort()
  ttsAbort = null
}

// The mic is open and nobody is saying anything. How long we tolerate that
// depends on whether this run has ever heard a word.
function armSilence(onSilent: () => void): void {
  window.clearTimeout(silenceTimer)
  silenceTimer = window.setTimeout(
    onSilent,
    hasSpoken ? IDLE_SILENCE_TIMEOUT_MS : NO_SPEECH_TIMEOUT_MS,
  )
}

function disarmSilence(): void {
  window.clearTimeout(silenceTimer)
  silenceTimer = undefined
}

// Lets a dispatch reach `latestSend`. Both are refreshed during render, so a
// send fired in the same tick as a SESSION_CREATED would still be holding the
// closure from before it — and would create a second session.
function afterRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Write the call's header, once, at the first utterance.
async function openMarker(): Promise<void> {
  const dispatch = latestDispatch
  if (!dispatch) return

  let sessionId = boundSessionId ?? latestActiveSessionId

  if (!sessionId) {
    // Voice started from the home screen. The header has to LEAD the
    // conversation, so the session must exist before the first utterance is
    // sent — which means creating it here rather than letting sendMessage do it
    // on the way past. The marker is itself a message, so a chat is still never
    // saved empty: a run nobody speaks into never reaches this line.
    const session: ChatSession = {
      id: uuid(),
      title: 'Voice call',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    dispatch({ type: 'SESSION_CREATED', session })
    sessionId = session.id
  }

  // Bind unconditionally. The create branch above used to be the only place this
  // was set, so a run that fell through to `latestActiveSessionId` picked a session
  // to write into and then stayed UNBOUND — leaving finalizeMarker with nowhere to
  // stamp the duration, and the turn's send with no id to be told. From here on,
  // "the session this call is in" has exactly one answer.
  boundSessionId = sessionId
  adoptNextSession = false

  const id = uuid()
  const marker: Message = {
    id,
    role: 'assistant',
    kind: 'call',
    content: 'Voice call',
    durationMs: 0,
    createdAt: Date.now(),
    status: 'sent',
  }
  dispatch({ type: 'CALL_STARTED', sessionId, message: marker })
  markerId = id

  await afterRender()
}

// Stamp the header with how long the call ran. Must happen while boundSessionId
// still points somewhere — teardown clears it moments later.
function finalizeMarker(): void {
  const dispatch = latestDispatch
  const sessionId = boundSessionId
  if (!dispatch || !markerId || !sessionId) {
    markerId = null
    return
  }
  const durationMs = callStartedAtMs === null ? 0 : Date.now() - callStartedAtMs
  dispatch({
    type: 'CALL_ENDED',
    sessionId,
    messageId: markerId,
    durationMs,
    content: `Voice call · ${formatDuration(durationMs)}`,
  })
  markerId = null
}

function toFriendlyVoiceMessage(err: unknown): string {
  if (err instanceof VoiceServiceError) {
    switch (err.kind) {
      case 'missing_key':
        return 'Voice needs a valid API key — set VITE_VOICE_API_KEY in your .env file and restart the dev server.'
      case 'mic_denied':
        return "Microphone access denied — enable it in your browser's site settings and try again."
      case 'connection':
        return "Couldn't connect to the voice service — check your connection."
      case 'tts_failed':
        return "Couldn't play the spoken reply."
      case 'autoplay_blocked':
        return 'Your browser blocked audio playback — click the page, then start voice again.'
      case 'unsupported':
        return 'This browser has no built-in speech support — use Chrome or Edge, or point VITE_VOICE_PROVIDER at a hosted provider in your .env file.'
      case 'mic_lost':
        return 'The microphone was disconnected or taken by another app — voice ended.'
      case 'reply_timeout':
        return 'The AI took too long to respond — voice ended.'
      case 'no_speech':
        return "Didn't hear anything — voice ended."
    }
  }
  return 'Something went wrong with voice — try again.'
}

// Release every live resource: reply, TTS audio, timers, socket, audio graph, mic.
// Module-scope and setter-free, so `pagehide` can call it with no React around.
export function teardown(): void {
  callActive = false
  interrupt()

  // Before boundSessionId is cleared below — the header needs to know where it
  // lives to be stamped with its duration.
  finalizeMarker()
  callStartedAtMs = null

  window.clearTimeout(silenceTimer)
  silenceTimer = undefined
  window.clearTimeout(replyTimer)
  replyTimer = undefined

  if (micPermission) micPermission.onchange = null
  micPermission = null

  boundSessionId = null
  adoptNextSession = false
  hasSpoken = false
  connectedOnce = false
  lastFinalText = ''
  ttsFailures = 0
  processingTurn = false
  queue = Promise.resolve()

  voiceService.stopListening()
}

export function useVoiceCall() {
  const {
    setStatus,
    setLiveTranscript,
    setSpokenText,
    setSpokenCharIndex,
    setStartedAt,
    setError,
  } = useCall()
  const { state, dispatch } = useSessions()
  const { sendMessage } = useChat()

  // See `latestSend` above: this is the whole reason a spoken turn can reuse the
  // typed send path without going stale after turn one.
  latestSend = sendMessage
  latestActiveSessionId = state.activeSessionId
  latestDispatch = dispatch

  // MUST be stable. The Visualizer owns an animation loop whose eased bar heights
  // live across frames; a fresh identity here re-runs its effect, which cancels
  // that loop and zeroes its state. Once the caption began reporting speech
  // progress every frame, this hook re-rendered ~60×/second — so the animation
  // was being wiped 60 times a second and could never build up any height.
  // `voiceService` is a module singleton, so there is nothing to capture.
  const getAnalyser = useCallback(() => voiceService.getAnalyser(), [])

  // The user hung up: show "Disconnected" for a beat, then idle.
  function endCall(): void {
    // Read before teardown, which clears it. A run that never connected never
    // played its rising tone, so it has no falling one to answer with.
    const wasConnected = connectedOnce
    // Unconditional: if releasing a resource throws, the panel still closes.
    try {
      teardown()
    } finally {
      if (wasConnected) playDisconnectTone()
      setLiveTranscript('')
      clearSpoken()
      setError(null)
      // Straight to idle: the chat slides back the instant Stop is pressed.
      //
      // This used to park on 'disconnected' for 1.2s first. That made sense when
      // voice was a modal — the beat was the dialog acknowledging the click before
      // it closed. Now the voice screen IS the chat screen, so that beat is just
      // the transcript being withheld from someone who already asked for it back.
      // Pressing Stop is not news; the user knows they pressed it.
      window.clearTimeout(idleTimer)
      idleTimer = undefined
      setStatus('idle')
    }
  }

  // The session died on its own: keep the panel open showing WHY until dismissed.
  function failCall(err: unknown): void {
    // Only a run still believed live can fail. A deliberate hang-up makes the
    // in-flight startListening() reject; resurrecting the dismissed panel with
    // an error would look like "voice won't turn off".
    if (!callActive) return
    const wasConnected = connectedOnce
    teardown()
    // A run that dropped gets the same falling tone as one the user ended: to
    // the ear the same thing happened. One that never connected stays silent —
    // the panel's error is the news there, not a beep.
    if (wasConnected) playDisconnectTone()
    setLiveTranscript('')
    clearSpoken()
    setError(toFriendlyVoiceMessage(err))
    setStatus('disconnected')
    // The panel has no dismiss button any more — there is nothing to press on a
    // screen with no chrome. So the reason shows for a beat and then the chat
    // slides back on its own. Longer than a clean hang-up: this one has to be read.
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
      setError(null)
      setStatus('idle')
    }, 4000)
  }

  // The user is talking: whatever the assistant was doing is over.
  function bargeIn(): void {
    if (!callActive || !processingTurn) return
    interrupt()
    setLiveTranscript('')
    clearSpoken() // the assistant was cut off mid-sentence; its caption goes too
    setStatus('listening')
    // runTurn disarmed the silence timer when it took the floor, and settleTurn —
    // which would normally re-arm it — is skipped for an interrupted turn, because
    // interrupt() just bumped the generation out from under it. So this call is the
    // only thing left to re-arm it.
    //
    // It matters because a barge-in can now be raised by a MICROPHONE rather than
    // by a finished sentence. A committed utterance always brings the next turn
    // with it; a meter can be fooled, and when it is, nothing arrives at all — and
    // a call whose idle timeouts were disarmed by the turn it just killed would sit
    // there listening to an empty room until the tab closed.
    armSilence(() => failCall(new VoiceServiceError('no_speech')))
  }

  // The floor is back with the mic: the assistant's caption goes with it.
  function clearSpoken(): void {
    setSpokenText('')
    setSpokenCharIndex(-1)
  }

  // The turn is over, one way or another: hand the floor back to the mic.
  function settleTurn(): void {
    ttsAbort = null
    processingTurn = false
    clearSpoken()
    setLiveTranscript('') // the utterance that started this turn is done with
    setStatus('listening')
    armSilence(() => failCall(new VoiceServiceError('no_speech')))
  }

  // One spoken turn. The transcript becomes a real user message and the reply a
  // real streaming assistant message — this is the SAME path Enter takes.
  async function runTurn(transcript: string): Promise<void> {
    if (!callActive || !transcript.trim()) return

    const turn = ++generation
    // Still the turn that owns the floor? Everything below must ask first.
    const current = () => callActive && generation === turn

    processingTurn = true
    hasSpoken = true
    // A previous turn's "couldn't speak that" has been read by now — and leaving it
    // under the caption of the thing they just said reads as a complaint about THIS
    // turn, which has not failed at anything yet.
    setError(null)
    // The AI has the floor; silence is expected until it hands it back.
    disarmSilence()
    // Keep what was just said ON SCREEN while the reply is being generated. It
    // is already a bubble in the transcript behind, but the transcript is off
    // screen during voice — blanking the caption here would make a slow reply
    // look like the utterance was never heard.
    setLiveTranscript(transcript)
    // Not 'speaking' — nothing has sounded yet — but not 'listening' either:
    // that reads as "still waiting for you" through the entire wait.
    setStatus('thinking')

    // The first utterance from the home screen creates the session. Claim it
    // before the send, so the switch guard adopts it instead of hanging up.
    if (boundSessionId === null) adoptNextSession = true

    // The call's header goes in before the first thing said, so the exchange
    // reads beneath it. Awaited: it may have created the session, and the send
    // below must be able to see it.
    if (markerId === null) {
      await openMarker()
      if (!current()) return
    }

    // Watches for the model STARTING, not finishing. Disarmed by the first token
    // below, so a long answer is free to take as long as it takes — the chat
    // service's own stall timer is what bounds it, exactly as for a typed message.
    const disarmFirstToken = () => {
      window.clearTimeout(replyTimer)
      replyTimer = undefined
    }
    window.clearTimeout(replyTimer)
    replyTimer = window.setTimeout(() => {
      if (current()) failCall(new VoiceServiceError('reply_timeout'))
    }, FIRST_TOKEN_TIMEOUT_MS)

    let reply: string | null = null
    try {
      // The bound session, passed explicitly. Left to its own render-old closure,
      // the send can miss the session openMarker just created and mint a SECOND
      // one — which flips the active chat, trips useVoiceGuards' switch rule, and
      // hangs up the call while the reply streams on into a chat the user is no
      // longer looking at. It is also what keeps interrupt()'s abortSession aimed
      // at the same id trackRequest registered.
      reply =
        (await latestSend?.(transcript, {
          sessionId: boundSessionId ?? undefined,
          onChunk: disarmFirstToken,
        })) ?? null
    } finally {
      disarmFirstToken()
    }

    // Interrupted, timed out, hung up, or the send failed (the error is already
    // in the chat's own ErrorBanner — voice doesn't duplicate it).
    if (!current()) return
    if (!reply) {
      settleTurn()
      return
    }

    try {
      ttsAbort = new AbortController()
      // The message keeps its Markdown — it is an ordinary chat bubble now.
      // Only what is SPOKEN gets stripped; reading "asterisk asterisk" aloud is
      // the bug this avoids. The caption shows this same stripped text, so what
      // is on screen is exactly what is in the ear.
      const spoken = toSpokenText(reply)

      // Publish the line and rewind the highlight BEFORE claiming 'speaking', so
      // the caption never appears with a stale word lit. -1, not 0: at 0 the
      // first word (which starts at index 0) would already be lit before a sound
      // came out.
      setSpokenText(spoken)
      setSpokenCharIndex(-1)
      setStatus('speaking') // the assistant now has the floor

      await voiceService.speak(spoken, ttsAbort.signal, (charIndex) => {
        // Late events from an interrupted turn must not drive the new caption.
        if (current()) setSpokenCharIndex(charIndex)
      })
      ttsFailures = 0 // it spoke; whatever went wrong before is not a pattern
    } catch (err) {
      if (!current()) return
      // A muted assistant blocks every following turn the same way: end and say why.
      if (err instanceof VoiceServiceError && err.kind === 'autoplay_blocked') {
        failCall(err)
        return
      }
      // The reply text is already in the chat, so the run CAN go on — but silently
      // is the wrong way to do it. A turn that answered in writing when the user
      // asked out loud has failed at the one thing they wanted, and saying nothing
      // leaves them staring at a mute assistant with no idea why.
      ttsFailures++
      if (ttsFailures >= MAX_CONSECUTIVE_TTS_FAILURES) {
        // Twice in a row is a broken key or voice id, not a blip. Every remaining
        // turn would be silent too; end the call rather than let them talk into it.
        failCall(err)
        return
      }
      setError(toFriendlyVoiceMessage(err))
    } finally {
      if (current()) settleTurn()
    }
  }

  // Serialised: a turn cannot start until the previous one has fully unwound.
  function enqueueTurn(transcript: string): void {
    queue = queue.then(() => runTurn(transcript)).catch(() => {})
  }

  // Revoked from the browser's site settings mid-session. Chrome fires this;
  // Firefox rejects the query name outright, hence the catch.
  async function watchMicPermission(): Promise<void> {
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })
      if (!callActive) return // hung up while the query was in flight
      micPermission = status
      status.onchange = () => {
        if (status.state !== 'granted') failCall(new VoiceServiceError('mic_denied'))
      }
    } catch {
      // No Permissions API for the mic here. The recogniser's own 'not-allowed'
      // error and getUserMedia's rejection still cover denial.
    }
  }

  async function startCall(): Promise<void> {
    if (callActive) return
    callActive = true
    generation++
    processingTurn = false
    hasSpoken = false
    connectedOnce = false
    markerId = null
    callStartedAtMs = null
    lastFinalText = ''
    ttsFailures = 0
    queue = Promise.resolve()
    // A chat is already open: bind now, so switching away from it ends voice.
    // Null (home screen) stays unbound until the first utterance creates one.
    boundSessionId = state.activeSessionId
    adoptNextSession = false

    window.clearTimeout(idleTimer)
    setStartedAt(null)
    setError(null)
    setLiveTranscript('')
    clearSpoken()
    setStatus('connecting')

    try {
      await voiceService.startListening({
        onOpen: () => {
          if (!callActive) return
          if (!connectedOnce) {
            connectedOnce = true
            // Restamping on reconnect would shrink the duration the header ends
            // up reporting.
            callStartedAtMs = Date.now()
            setStartedAt(callStartedAtMs)
            playConnectTone()
          }
          setStatus('connected')
          setStatus('listening')
          armSilence(() => failCall(new VoiceServiceError('no_speech')))
        },
        onReconnecting: () => {
          if (!callActive) return
          // Only the transport is missing; the mic is still open. Say
          // "connecting", don't hang up.
          setStatus('connecting')
        },
        onInterim: (text) => {
          if (!callActive) return
          const said = text.trim()
          if (!said || said === lastFinalText) return
          // A partial NEVER interrupts. It used to, and that was the bug: the mic
          // is wide open through the whole 'thinking' phase, so the cough, the
          // keystroke, the tail of the user's own sentence still coming up the
          // socket — every one of them arrived here as a partial and killed the
          // reply being generated. What made it silent rather than obviously
          // broken is that the reply text lands in the chat regardless, so it just
          // looked like the assistant had answered in writing.
          //
          // A partial is not evidence of speech. It is evidence of sound. Only a
          // COMMITTED utterance is evidence of speech, and that is onFinal's job.
          if (processingTurn) return

          // Someone is mid-sentence — a long question must not trip the silence
          // timer.
          armSilence(() => failCall(new VoiceServiceError('no_speech')))
          setLiveTranscript(text)
        },
        onFinal: (text) => {
          if (!callActive) return
          // An echo of the utterance that STARTED the turn now in flight is not a
          // new one — and since a final now interrupts, letting it through would
          // abort the very turn it asked for. Scoped to `processingTurn` on purpose:
          // once that turn is done, saying "yes" a second time is a real second
          // "yes", and must not be swallowed as a duplicate.
          if (processingTurn && text === lastFinalText) return
          lastFinalText = text
          // A finished utterance while a turn is in flight IS the barge-in — the
          // transcriber's VAD has confirmed a whole thing was said, which no amount
          // of room noise can fake. Interrupting HERE, rather than on a partial,
          // also means the interruption always comes with its replacement: the old
          // turn is never thrown away in the hope that a final follows it.
          if (processingTurn) bargeIn()
          // Unconditional. enqueueTurn chains on `queue`, so the aborted turn fully
          // unwinds — releasing its inFlight slot — before this one starts.
          enqueueTurn(text)
        },
        onBargeIn: () => bargeIn(),
        onMicLost: () => failCall(new VoiceServiceError('mic_lost')),
        onError: (err) => failCall(err),
        onClose: () => {},
      })
      void watchMicPermission()
    } catch (err) {
      // Mic denied, unsupported, or key missing — never got off the ground.
      // (failCall no-ops if the user hung up while it was still connecting.)
      failCall(err)
    }
  }

  return {
    startCall,
    endCall,
    getAnalyser,
    isSupported: () => voiceService.isSupported(),
  }
}
