import { useCallback } from 'react'
import { chatService, voiceService } from '../services/providers'
import { playConnectTone, playDisconnectTone } from '../services/voice/tones'
import { VoiceServiceError } from '../services/voiceService'
import { useCall } from '../state/CallContext'
import { useSessions } from '../state/SessionsContext'
import type { CallTurn, ChatSession, Message } from '../types'
import { formatDuration } from '../utils/formatDuration'
import { toSpokenText } from '../utils/toSpokenText'
import { uuid } from '../utils/uuid'

// Drives the call state machine. The call's conversation is self-contained: turns
// stream into the overlay only; the chat session is untouched until hang-up, when
// a single "Voice call · 2m 34s" marker is logged.
// Flags live at module scope so PromptBar (start) and CallOverlay (end) — two
// separate hook instances — control the SAME call.
let callActive = false
let processingTurn = false
let chatAbort: AbortController | null = null
let ttsAbort: AbortController | null = null
let idleTimer: number | undefined
// Bumped when a turn is superseded or the call ends. A turn captures this at its
// start and compares before touching state, so an interrupted turn still unwinding
// out of a fetch or <audio> can't drag the UI back.
let generation = 0
// The in-call history sent to the AI (not the chat session's).
let callHistory: Message[] = []
let callStartedAtMs: number | null = null
// The transcriber's last committed utterance, kept to recognise it if it returns
// as a partial. See onInterim.
let lastFinalText = ''

// Take the floor from the turn in flight: stop the reply mid-fetch/mid-sentence.
// Its own `finally` sees a stale generation and quietly stands down.
function interrupt(): void {
  generation++
  processingTurn = false
  chatAbort?.abort()
  chatAbort = null
  ttsAbort?.abort()
  ttsAbort = null
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
        return 'Your browser blocked audio playback — click the page, then start the call again.'
      case 'unsupported':
        return 'This browser has no built-in speech support — use Chrome or Edge, or point VITE_VOICE_PROVIDER at a hosted provider in your .env file.'
    }
  }
  return 'Something went wrong with the call — try again.'
}

// Release every live resource: reply, TTS audio, socket, audio graph, mic.
function teardown(): void {
  callActive = false
  interrupt()
  voiceService.stopListening()
}

export function useVoiceCall() {
  const { setStatus, setLiveTranscript, setTurns, setStartedAt, setError } = useCall()
  const { state, dispatch } = useSessions()

  const getAnalyser = useCallback(() => voiceService.getAnalyser(), [])

  // The only trace a call leaves in the chat: one marker with its duration. A call
  // that died before connecting is logged into an existing chat, but not conjured a
  // new one from the home screen (the overlay's error suffices there).
  function logCallToChat({ failed = false }: { failed?: boolean } = {}): void {
    const neverConnected = callStartedAtMs === null
    if (neverConnected && !failed) return

    const hasSession =
      state.activeSessionId !== null &&
      state.sessions.some((s) => s.id === state.activeSessionId)
    if (neverConnected && !hasSession) return

    const durationMs = callStartedAtMs === null ? 0 : Date.now() - callStartedAtMs
    callStartedAtMs = null

    // Read from module-scope callHistory (cleared only by startCall), not `turns`
    // from context, which would be a stale closure when the call ends mid-render.
    const turns: CallTurn[] = callHistory.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.content,
    }))

    const marker: Message = {
      id: uuid(),
      role: 'assistant',
      kind: 'call',
      content: neverConnected
        ? 'Voice call failed to connect'
        : `Voice call · ${formatDuration(durationMs)}`,
      durationMs,
      turns,
      createdAt: Date.now(),
      status: 'sent',
    }

    let sessionId = state.activeSessionId
    if (!sessionId || !state.sessions.some((s) => s.id === sessionId)) {
      // Call started from the home screen — give the marker a home.
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
    dispatch({ type: 'CALL_LOGGED', sessionId, message: marker })
  }

  // User hung up: show "Disconnected" for a beat, then idle.
  function endCall(): void {
    // Read before logCallToChat, which clears it. A call that never connected
    // never played its rising tone, so it has no falling one to answer with.
    const wasConnected = callStartedAtMs !== null
    // Hang-up must be unconditional: if releasing a resource throws, the overlay
    // still closes.
    try {
      teardown()
      logCallToChat()
    } finally {
      if (wasConnected) playDisconnectTone()
      setLiveTranscript('')
      setError(null)
      setStatus('disconnected')
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => setStatus('idle'), 1200)
    }
  }

  // The call died on its own: keep the overlay open showing WHY until dismissed.
  function failCall(err: unknown): void {
    // Only a call still believed live can fail. A deliberate hang-up makes the
    // in-flight startListening() reject; resurrecting the dismissed overlay with an
    // error would look like "the call won't disconnect".
    if (!callActive) return
    const wasConnected = callStartedAtMs !== null
    teardown()
    logCallToChat({ failed: true })
    // A call that dropped gets the same falling tone as one the user hung up: to
    // the ear the same thing happened. One that never connected stays silent —
    // the overlay's error is the news there, not a beep.
    if (wasConnected) playDisconnectTone()
    setLiveTranscript('')
    setError(toFriendlyVoiceMessage(err))
    setStatus('disconnected')
  }

  // The user is talking: whatever the assistant was doing is over.
  function bargeIn(): void {
    if (!callActive || !processingTurn) return
    interrupt()
    setLiveTranscript('')
    setStatus('listening')
  }

  // One spoken turn: transcript → AI (streaming into the overlay) → spoken reply
  // → listen again. The chat session never hears about any of it.
  async function handleFinal(transcript: string): Promise<void> {
    if (!callActive) return
    // A finished utterance mid-turn means the user talked over the assistant;
    // backstop for speech too quiet to trip the service's energy detector.
    if (processingTurn) interrupt()
    lastFinalText = transcript

    const turn = ++generation
    // Still the turn that owns the floor? Everything below must ask first.
    const current = () => callActive && generation === turn

    processingTurn = true
    setLiveTranscript('')
    // Deliberately NOT 'speaking': the mic is open and nothing has sounded yet, so
    // stay 'listening' while it thinks. 'speaking' is claimed when TTS starts.
    setStatus('listening')

    setTurns((prev) => [...prev, { id: uuid(), role: 'user', text: transcript }])
    callHistory.push({
      id: uuid(),
      role: 'user',
      content: transcript,
      createdAt: Date.now(),
      status: 'sent',
    })

    const replyTurnId = uuid()
    setTurns((prev) => [...prev, { id: replyTurnId, role: 'assistant', text: '' }])

    // The reply joins history NOW, empty, filling in as it streams: an interruption
    // can land between chunks, and appending later would misorder the half-spoken reply.
    const replyMessage: Message = {
      id: replyTurnId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'sent',
    }
    callHistory.push(replyMessage)

    try {
      chatAbort = new AbortController()
      // Skip empty replies: this turn's own, and any interrupted turn's stub not
      // yet unwound.
      const prompt = callHistory.filter((m) => m.content)
      // Strip markup from the ACCUMULATED reply, never per chunk: a `**` can
      // straddle a chunk boundary and stripping halves separately leaves both behind.
      let raw = ''
      for await (const chunk of chatService.sendMessage(prompt, chatAbort.signal)) {
        // Hung up or talked over mid-stream: stop; skip TTS. (finally still runs.)
        if (!current()) return
        raw += chunk
        // Nothing downstream wants Markdown: overlay, TTS, or saved transcript.
        replyMessage.content = toSpokenText(raw)
        const text = replyMessage.content
        setTurns((prev) => prev.map((t) => (t.id === replyTurnId ? { ...t, text } : t)))
      }
      if (replyMessage.content && current()) {
        ttsAbort = new AbortController()
        setStatus('speaking') // the assistant now has the floor
        // Resolves early on barge-in: the service reopens the mic and aborts this signal.
        await voiceService.speak(replyMessage.content, ttsAbort.signal)
      }
    } catch (err) {
      // An interruption aborts the fetch, surfacing here as a network error it
      // isn't; the turn no longer owns the screen.
      if (!current()) return
      if (err instanceof VoiceServiceError) {
        // A muted assistant blocks every following turn the same way: end and say why.
        if (err.kind === 'autoplay_blocked') {
          failCall(err)
          return
        }
        // TTS failed — reply text is already in the transcript; call stays alive.
      } else {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === replyTurnId
              ? { ...t, text: "⚠ Couldn't get a response — try speaking again." }
              : t,
          ),
        )
      }
    } finally {
      // Interrupted before a word out: leave no empty turn in history.
      if (!replyMessage.content) {
        const at = callHistory.indexOf(replyMessage)
        if (at !== -1) callHistory.splice(at, 1)
      }
      if (current()) {
        chatAbort = null
        ttsAbort = null
        processingTurn = false
        setStatus('listening')
      }
    }
  }

  async function startCall(): Promise<void> {
    if (callActive) return
    callActive = true
    callHistory = []
    callStartedAtMs = null
    lastFinalText = ''
    window.clearTimeout(idleTimer)
    setTurns([])
    setStartedAt(null)
    setError(null)
    setLiveTranscript('')
    setStatus('connecting')
    try {
      await voiceService.startListening({
        onOpen: () => {
          if (!callActive) return
          // Fires again after reconnect; restamping the clock would shrink the duration.
          if (callStartedAtMs === null) {
            callStartedAtMs = Date.now()
            setStartedAt(callStartedAtMs)
            // Only the first open. A reconnect mid-call is not a new call, and
            // chiming for one would announce a drop the user never noticed.
            playConnectTone()
          }
          setStatus('connected')
          setStatus('listening')
        },
        onReconnecting: () => {
          if (!callActive) return
          // Only the transport is missing; mic still open. Say "connecting", don't hang up.
          setStatus('connecting')
        },
        onInterim: (text) => {
          if (!callActive) return
          const said = text.trim()
          // A transcriber may re-emit the just-committed utterance as a partial;
          // acting on it would abort every reply the moment it began.
          if (!said || said === lastFinalText) return
          // Words while a turn is in flight = user talking over the assistant. Not
          // its own voice: the mic is gated shut while it actually speaks.
          if (processingTurn) bargeIn()
          setLiveTranscript(text)
        },
        onFinal: (text) => {
          void handleFinal(text)
        },
        onBargeIn: () => {
          bargeIn()
        },
        onError: () => {
          if (callActive) failCall(new VoiceServiceError('connection'))
        },
        onClose: () => {},
      })
    } catch (err) {
      // Mic denied or key missing — never got off the ground. (failCall no-ops if
      // the user hung up while still connecting.)
      failCall(err)
    }
  }

  return { startCall, endCall, getAnalyser }
}
