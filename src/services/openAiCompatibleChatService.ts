import type { Message } from '../types'
import { ChatServiceError, type ChatService, type ReplyOutcome } from './chatService'
import { env, type ChatConfig } from './env'

// One implementation for any provider that speaks the OpenAI chat-completions
// dialect (POST + Bearer + SSE). Base URL, model, key, prompt all come from
// config, so switching providers is a .env edit.

// How long the provider may take to send the FIRST token.
const FIRST_TOKEN_TIMEOUT_MS = 30_000
// How long it may then go quiet BETWEEN tokens before we call it dead.
const STALL_TIMEOUT_MS = 20_000

export class OpenAiCompatibleChatService implements ChatService {
  private readonly config: ChatConfig

  constructor(config: ChatConfig = env.chat) {
    this.config = config
  }

  async *sendMessage(
    messages: Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<string, ReplyOutcome> {
    const { apiKey, baseUrl, model, systemPrompt, contextTokenBudget } = this.config
    if (!apiKey) {
      throw new ChatServiceError('missing_key')
    }

    // A stop and a stall both abort the same fetch; told apart by its `reason`.
    const controller = new AbortController()
    const abort = (kind: 'canceled' | 'timeout') => {
      if (!controller.signal.aborted) controller.abort(new ChatServiceError(kind))
    }

    const onCallerAbort = () => abort('canceled')
    if (signal?.aborted) abort('canceled')
    signal?.addEventListener('abort', onCallerAbort, { once: true })

    // Re-armed on every token: a producing stream never times out, a stall does.
    let timer: ReturnType<typeof setTimeout> | undefined
    const armTimeout = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => abort('timeout'), ms)
    }

    // Held outside the try so `finally` can close it on an early `break`.
    let stream: AsyncGenerator<string, ReplyOutcome> | undefined

    try {
      armTimeout(FIRST_TOKEN_TIMEOUT_MS)

      let response: Response
      try {
        // Tolerate a base URL written with or without a trailing slash.
        response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [
              { role: 'system', content: systemPrompt },
              // Our Message has extra fields (id, status…) the API doesn't want.
              ...trimToBudget(messages, contextTokenBudget, systemPrompt).map((m) => ({
                role: m.role,
                content: m.content,
              })),
            ],
          }),
        })
      } catch (err) {
        // fetch throws only on a dead network or an abort we caused (its reason).
        throw asChatError(err, controller.signal)
      }

      // fetch does NOT throw on 4xx/5xx — branch on the status ourselves.
      if (!response.ok) throw await errorFromResponse(response)
      if (!response.body) throw new ChatServiceError('server_error')

      stream = stripLeakedThinkTags(parseSseStream(response.body))
      let sawText = false

      try {
        // Iterated by hand not `yield*`: re-arm the stall timer per token, and
        // notice an empty reply.
        while (true) {
          const next = await stream.next()
          if (next.done) {
            if (!sawText) throw new ChatServiceError('empty_reply')
            return next.value
          }
          armTimeout(STALL_TIMEOUT_MS)
          if (next.value) sawText = true
          yield next.value
        }
      } catch (err) {
        // A stop or stall surfaces here as a DOMException — translate it back.
        throw asChatError(err, controller.signal)
      }
    } finally {
      // Also runs on an early `break`, so the timer and body reader don't leak.
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
      await stream?.return({ truncated: false })
    }
  }
}

// An abort we caused carries its ChatServiceError as the signal's reason;
// anything else escaping fetch or the body stream is a dead network.
function asChatError(err: unknown, signal: AbortSignal): ChatServiceError {
  if (err instanceof ChatServiceError) return err
  if (signal.aborted && signal.reason instanceof ChatServiceError) return signal.reason
  return new ChatServiceError('network')
}

// A context-overflow 400 is indistinguishable from a bad model name unless we
// read the body — and only one is fixable by dropping old turns.
async function errorFromResponse(response: Response): Promise<ChatServiceError> {
  const detail = await readErrorDetail(response)

  if (response.status === 401 || response.status === 403) {
    return new ChatServiceError('bad_key', { detail })
  }
  if (response.status === 429) {
    return new ChatServiceError('rate_limited', {
      detail,
      retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
    })
  }
  if (response.status >= 500) {
    return new ChatServiceError('server_error', { detail })
  }
  // Every other 4xx is the request's own fault; the body says which kind.
  return new ChatServiceError(isContextOverflow(detail) ? 'context_too_long' : 'bad_request', {
    detail,
  })
}

// Providers bury their message in `{error:{message}}`, `{error:"…"}`, or text.
async function readErrorDetail(response: Response): Promise<string | undefined> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    return undefined
  }
  // `||` not `??`: an empty body reads as "no detail", not a detail of "".
  return detailFromPayload(safeJsonParse(raw)) ?? (raw.trim().slice(0, 300) || undefined)
}

function detailFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// No status code distinguishes these, so the provider's prose has to.
function isContextOverflow(detail: string | undefined): boolean {
  if (!detail) return false
  return /context length|context window|too many tokens|maximum.*tokens|reduce the length|prompt is too long/i.test(
    detail,
  )
}

// Retry-After is either delta-seconds or an HTTP date. Both are legal.
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

// Crude token count — ~4 chars/token. Only roughly right: being wrong costs a
// dropped turn, not a failed request.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Keep the newest turns that fit the budget. The final (just-typed) message is
// kept unconditionally — a too-big prompt is the provider's error to report.
export function trimToBudget(
  messages: Message[],
  budgetTokens: number,
  systemPrompt = '',
): Message[] {
  if (messages.length === 0) return messages

  let used = estimateTokens(systemPrompt)
  const kept: Message[] = []

  // Walk backwards from the newest until the budget runs out.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const cost = estimateTokens(message.content)
    const isNewest = i === messages.length - 1
    if (!isNewest && used + cost > budgetTokens) break
    used += cost
    kept.push(message)
  }

  return kept.reverse()
}

// MiniMax sometimes leaks reasoning markup into the reply — a stray
// "</mm:think>" or a whole "<mm:think>…</mm:think>" block. Hold back the first
// chars until we can tell, then strip it. Harmless when no tag appears.
async function* stripLeakedThinkTags(
  chunks: AsyncGenerator<string, ReplyOutcome>,
): AsyncGenerator<string, ReplyOutcome> {
  const OPEN = '<mm:think>'
  const CLOSE = '</mm:think>'
  let buffer = ''
  let mode: 'checking' | 'inThink' | 'pass' = 'checking'

  while (true) {
    const next = await chunks.next()
    if (next.done) {
      // Stream ended while still unsure — it was a real (tiny) reply.
      if (mode === 'checking' && buffer) yield buffer
      return next.value
    }
    const chunk = next.value

    if (mode === 'pass') {
      yield chunk
      continue
    }
    buffer += chunk

    if (mode === 'checking') {
      const lead = buffer.trimStart()
      if (!lead) continue
      if (lead.startsWith(CLOSE)) {
        // orphan closing tag — drop it, pass the rest through
        mode = 'pass'
        const rest = lead.slice(CLOSE.length).trimStart()
        if (rest) yield rest
        buffer = ''
        continue
      }
      if (lead.startsWith(OPEN)) {
        mode = 'inThink' // full reasoning block — skip until it closes
      } else if (OPEN.startsWith(lead) || CLOSE.startsWith(lead)) {
        continue // could still become a tag — keep buffering
      } else {
        mode = 'pass' // normal reply, release everything held back
        yield buffer
        buffer = ''
        continue
      }
    }

    if (mode === 'inThink') {
      const end = buffer.indexOf(CLOSE)
      if (end === -1) continue
      mode = 'pass'
      const rest = buffer.slice(end + CLOSE.length).trimStart()
      if (rest) yield rest
      buffer = ''
    }
  }
}

// Turns the raw SSE byte stream into clean text chunks.
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, ReplyOutcome> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let truncated = false
  let lines: string[]

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // The body may end without a trailing newline; flush the buffered tail
        // (usually the `data: [DONE]` sentinel) as a whole line.
        lines = buffer ? [buffer] : []
        buffer = ''
      } else {
        buffer += decoder.decode(value, { stream: true })

        lines = buffer.split('\n')
        // A chunk can end mid-line; keep the incomplete tail for the next read.
        buffer = lines.pop() ?? ''
      }

      for (const line of lines) {
        const payload = readDataField(line)
        if (payload === undefined) continue
        // The provider said its piece: the reply is complete by definition.
        if (payload === '[DONE]') return { truncated }

        const event = safeJsonParse(payload)
        if (event === undefined) continue // a malformed line shouldn't kill the reply

        // Some providers answer 200 OK, then put the error in the stream body.
        const inBand = detailFromPayload(event)
        if (inBand !== undefined) throw errorFromInBandPayload(inBand)

        const choice = (event as {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
        }).choices?.[0]

        // 'length' means the model hit the token ceiling mid-thought; the text
        // is real, just not the whole answer.
        if (choice?.finish_reason === 'length') truncated = true

        const chunk = choice?.delta?.content
        if (chunk) yield chunk
      }

      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  // The body ended without a [DONE]: a dropped connection. Returning here would
  // present the half-sentence as a finished answer.
  throw new ChatServiceError('truncated')
}

// `data:foo` and `data: foo` are both legal SSE — the space after the colon is
// optional. Returns undefined for comments, other fields, and blank lines.
function readDataField(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  const value = line.slice('data:'.length)
  // Exactly one leading space is part of the framing; the rest is content.
  return (value.startsWith(' ') ? value.slice(1) : value).trim()
}

// An error inside a 200 stream carries no status code to lean on.
function errorFromInBandPayload(detail: string): ChatServiceError {
  if (isContextOverflow(detail)) return new ChatServiceError('context_too_long', { detail })
  if (/rate limit|too many requests/i.test(detail)) {
    return new ChatServiceError('rate_limited', { detail })
  }
  if (/api key|unauthorized|authentication/i.test(detail)) {
    return new ChatServiceError('bad_key', { detail })
  }
  return new ChatServiceError('server_error', { detail })
}
