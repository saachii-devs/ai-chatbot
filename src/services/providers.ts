import type { ChatService } from './chatService'
import { OpenAiCompatibleChatService } from './openAiCompatibleChatService'
import { createVoiceService } from './voice'
import type { VoiceService } from './voiceService'

// The one place that picks WHICH implementation backs each interface;
// everything else depends on the interface only. Both are configured from .env.

// Shared: the voice call reuses the same chat service for its in-call turns.
export const chatService: ChatService = new OpenAiCompatibleChatService()

// Chosen by VITE_VOICE_PROVIDER, or auto-detected from whether a key exists.
export const voiceService: VoiceService = createVoiceService()
