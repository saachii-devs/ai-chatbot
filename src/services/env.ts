// The only file that touches import.meta.env — tests mock this module, since
// Jest can't parse import.meta. Every provider knob lives here, so switching
// providers is a .env edit, never a source change.
//
// Vite substitutes `import.meta.env.VITE_FOO` textually at build time, so keys
// must be read literally one-by-one — a computed key resolves to undefined.

// Treats a blank or whitespace-only .env line as unset, so it falls back.
function str(value: unknown, fallback = ''): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || fallback
}

// Same, for knobs that must be a positive number — a typo falls back, never NaN.
function num(value: unknown, fallback: number): number {
  const parsed = Number(str(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Audio level in 0..1. Unlike num(), zero is legal and means "off".
function level(value: unknown, fallback: number): number {
  const raw = str(value)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

export const env = {
  chat: {
    // Any OpenAI-compatible base URL — the service appends /chat/completions.
    baseUrl: str(import.meta.env.VITE_CHAT_BASE_URL, 'https://api.synthetic.new/v1'),
    model: str(import.meta.env.VITE_CHAT_MODEL, 'hf:MiniMaxAI/MiniMax-M3'),
    // VITE_SYNTHETIC_API_KEY is the pre-rename name, still honoured.
    apiKey:
      str(import.meta.env.VITE_CHAT_API_KEY) ||
      str(import.meta.env.VITE_SYNTHETIC_API_KEY),
    systemPrompt: str(
      import.meta.env.VITE_CHAT_SYSTEM_PROMPT,
      'You are a helpful assistant. Keep answers concise and conversational.',
    ),
    // Token ceiling on history sent each turn (REST is stateless). Without it a
    // long chat overflows the context window. Set below the model's real window.
    contextTokenBudget: num(import.meta.env.VITE_CHAT_CONTEXT_TOKENS, 12_000),
  },

  voice: {
    // Which VoiceService to build (ids in services/voice/index.ts). Empty means
    // "auto": hosted if a key was supplied, otherwise the keyless browser one.
    provider: str(import.meta.env.VITE_VOICE_PROVIDER),
    // VITE_ELEVENLABS_API_KEY is the pre-rename name, still honoured.
    apiKey:
      str(import.meta.env.VITE_VOICE_API_KEY) ||
      str(import.meta.env.VITE_ELEVENLABS_API_KEY),
    baseUrl: str(import.meta.env.VITE_VOICE_BASE_URL, 'https://api.elevenlabs.io/v1'),
    sttModel: str(import.meta.env.VITE_VOICE_STT_MODEL, 'scribe_v2_realtime'),
    ttsModel: str(import.meta.env.VITE_VOICE_TTS_MODEL, 'eleven_flash_v2_5'),
    // Hosted providers want an opaque id; the browser provider matches it
    // against installed OS voice names, e.g. "Google US English".
    voiceId: str(import.meta.env.VITE_VOICE_ID, '21m00Tcm4TlvDq8ikWAM'),
    ttsOutputFormat: str(import.meta.env.VITE_VOICE_TTS_FORMAT, 'mp3_44100_128'),
    // BCP-47 tag. Only the browser provider needs it told; hosted STT detects.
    lang: str(import.meta.env.VITE_VOICE_LANG, 'en-US'),
    // Mic RMS (0..1) below which audio is treated as room noise and dropped;
    // judges distance only. 0 disables the gate. Tune to the mic and room.
    noiseGateRms: level(import.meta.env.VITE_VOICE_NOISE_GATE_RMS, 0.03),
  },
} as const

export type ChatConfig = typeof env.chat
export type VoiceConfig = typeof env.voice
