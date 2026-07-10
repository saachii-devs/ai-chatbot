import type { Message } from '../types'

// How a reply ended. Carried as the generator's return value, not a chunk.
export interface ReplyOutcome {
  truncated: boolean
}

// Provider-agnostic contract the UI depends on, so providers are swappable.
export interface ChatService {
  sendMessage(messages: Message[], signal?: AbortSignal): AsyncGenerator<string, ReplyOutcome>
}

export type ChatErrorKind =
  | 'missing_key'
  | 'bad_key'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'timeout'
  // Caller aborted — a stop button, not a failure. The UI says nothing.
  | 'canceled'
  // Stream died before the provider said it was done. Partial text stands.
  | 'truncated'
  | 'empty_reply'
  | 'context_too_long'
  // Provider rejected the request itself — bad model name, filtered content.
  | 'bad_request'

interface ChatErrorOptions {
  detail?: string
  // From a 429's Retry-After header: how long until a retry can possibly work.
  retryAfterMs?: number
}

export class ChatServiceError extends Error {
  readonly kind: ChatErrorKind
  readonly detail?: string
  readonly retryAfterMs?: number

  constructor(kind: ChatErrorKind, options: ChatErrorOptions = {}) {
    super(`chat service error: ${kind}`)
    this.name = 'ChatServiceError'
    this.kind = kind
    this.detail = options.detail
    this.retryAfterMs = options.retryAfterMs
  }
}
