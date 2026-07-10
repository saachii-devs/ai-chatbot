import { env, type VoiceConfig } from '../env'
import type { VoiceService } from '../voiceService'
import { BrowserVoiceService } from './browser'
import { ElevenLabsVoiceService } from './elevenlabs'

// Voice provider registry: the one place an id becomes an implementation.
// Adapters are named for the protocol they speak. To add one: create
// src/services/voice/<name>.ts, add it to `registry`, set VITE_VOICE_PROVIDER.

export type VoiceProviderId = keyof typeof registry

const registry = {
  elevenlabs: (config: VoiceConfig) => new ElevenLabsVoiceService(config),
  browser: (config: VoiceConfig) => new BrowserVoiceService(config),
} satisfies Record<string, (config: VoiceConfig) => VoiceService>

export const voiceProviderIds = Object.keys(registry) as VoiceProviderId[]

function isProviderId(id: string): id is VoiceProviderId {
  return id in registry
}

// Resolve VITE_VOICE_PROVIDER to an id. Unset means auto: a key selects the
// hosted provider, no key falls back to the keyless browser one.
export function resolveVoiceProvider(config: VoiceConfig = env.voice): VoiceProviderId {
  const requested = config.provider.trim().toLowerCase()
  if (!requested) return config.apiKey ? 'elevenlabs' : 'browser'
  if (isProviderId(requested)) return requested

  // A typo must not white-screen the app on import; warn and fall back.
  console.error(
    `[voice] unknown VITE_VOICE_PROVIDER "${config.provider}". ` +
      `Known: ${voiceProviderIds.join(', ')}. Falling back to "browser".`,
  )
  return 'browser'
}

export function createVoiceService(config: VoiceConfig = env.voice): VoiceService {
  return registry[resolveVoiceProvider(config)](config)
}
