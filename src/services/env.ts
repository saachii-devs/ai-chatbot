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
    // Synthetic's catalogue, measured on an identical 300-token completion.
    // All are always-on, so none pays a cold start; pick on speed vs. ability.
    //   hf:openai/gpt-oss-120b                  ~89 tok/s  131K  text
    //   hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4  ~72 tok/s  262K  text
    //   hf:Qwen/Qwen3.6-27B                     ~63 tok/s  262K  vision — fastest with images
    //   hf:zai-org/GLM-4.7-Flash                ~54 tok/s  196K  text
    //   hf:MiniMaxAI/MiniMax-M3                 ~16 tok/s  262K  vision
    //   hf:moonshotai/Kimi-K2.7-Code                        262K  vision — 504'd under load
    //   hf:zai-org/GLM-5.2                                  524K  text   — 504'd under load
    // The last four reason before answering, so the wait is longer than tok/s alone
    // implies — the thinking tokens are billed and timed but never shown.
    model: str(import.meta.env.VITE_CHAT_MODEL, 'hf:openai/gpt-oss-120b'),
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
    //
    // Deliberately low: a soft or distant voice must still get through, and the
    // cost of setting this too HIGH is that such a speaker is never heard at all
    // — a failure they cannot diagnose. Too low merely sends some room tone,
    // which the transcriber discards. Err on the side of hearing.
    noiseGateRms: level(import.meta.env.VITE_VOICE_NOISE_GATE_RMS, 0.012),

    // --- Barge-in: taking the floor back while the assistant is still talking.
    //
    // Three tests have to agree before a reply is cut off, because the three
    // things that must NOT cut it off each defeat a different one on its own:
    // a desk tap is loud (defeats level), the assistant's own echo is speech
    // (defeats the spectrum), and a cough is both (defeats everything but time).

    // Note the bias here runs OPPOSITE to noiseGateRms above, deliberately. That
    // gate errs on the side of hearing, because a soft speaker who is never
    // transcribed cannot work out why. These err on the side of NOT firing,
    // because cutting a reply off for a dropped pen is just as undiagnosable —
    // and unlike a missed word, the user cannot fix it by repeating themselves.

    // How loud you must be — measured in the 200-5000Hz SPEECH BAND, not across the
    // whole waveform, so the number means the same thing for a deep voice and a
    // high one. (It did not always: broadband RMS is dominated by low frequencies,
    // so the same bar that one person cleared by talking, another could only clear
    // by shouting. See VOICE_LOW_HZ in voice/bargeIn.ts.) Band-limited levels run
    // lower than broadband ones, which is why this sits below where it started.
    //
    // A FLOOR, not the whole bar: the detector measures the assistant's own echo at
    // the top of every reply and stands the bar above that, so this only has to
    // clear a quiet room. 0 turns barge-in off entirely and restores the old
    // wait-your-turn behaviour.
    bargeInRms: level(import.meta.env.VITE_VOICE_BARGE_IN_RMS, 0.015),
    // ...and this many times louder than the echo it measured. The ONLY defence
    // against the assistant interrupting itself: its voice coming back through the
    // speakers is sustained, and it is speech in the voice band, so neither the
    // hold nor the ratio below can tell it from a human — only its level can.
    // Raise this if the assistant cuts itself off (loud speakers, or an output
    // device the browser's echo canceller cannot see, like an HDMI monitor).
    bargeInFloorMultiplier: num(import.meta.env.VITE_VOICE_BARGE_IN_FLOOR_MULT, 3),
    // ...but never demand more than this, however bad the echo is. A ceiling, and
    // the reason it exists is a failure we actually hit: with a badly-cancelled
    // echo the bar above climbs past anything a human throat can produce, and the
    // user is simply locked out of interrupting — which does not present as a
    // threshold that needs tuning, it presents as a broken feature, and no amount
    // of speaking louder fixes it. If the echo really is as loud as a voice then
    // the two cannot be told apart, and it is better to occasionally clip the
    // assistant than to silently take interruption away altogether.
    bargeInMaxRms: level(import.meta.env.VITE_VOICE_BARGE_IN_MAX_RMS, 0.05),
    // ...for this long, sustained. THE filter against impulses: a tap, a click, a
    // dropped pen are all over in 20-80ms, so no threshold separates them from a
    // voice by loudness — only by lasting. ~300ms is about one syllable. It is
    // also the latency budget: the reply goes quiet this long after you start.
    bargeInHoldMs: num(import.meta.env.VITE_VOICE_BARGE_IN_HOLD_MS, 300),
    // ...and shaped like a voice: this much of the sound's power must fall in the
    // speech band (300-3400Hz). This is what catches the noise that IS sustained —
    // a desk knock carries through the desk as a low thump, typing is a train of
    // high clicks, and neither puts its energy where a voice puts it.
    bargeInVoiceRatio: level(import.meta.env.VITE_VOICE_BARGE_IN_VOICE_RATIO, 0.55),
  },
} as const

export type ChatConfig = typeof env.chat
export type VoiceConfig = typeof env.voice
