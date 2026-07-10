// A small markdown subset (fenced/inline code, bold, italic, links). No HTML is
// ever produced, so a model or prompt injection has nothing to inject: nodes
// become React elements and text stays text.

export type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'text'; text: string }

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'link'; text: string; href: string }

const FENCE = /^```([\w+-]*)\s*$/

// A fence that never closes is treated as code to the end — the common case
// while streaming; re-flowing it into prose for one frame would flicker.
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')

  let text: string[] = []
  let code: string[] | null = null
  let lang = ''

  const flushText = () => {
    if (text.length) blocks.push({ type: 'text', text: text.join('\n') })
    text = []
  }

  for (const line of lines) {
    const fence = FENCE.exec(line)

    if (code === null && fence) {
      flushText()
      code = []
      lang = fence[1]
      continue
    }
    if (code !== null && line.trimEnd() === '```') {
      blocks.push({ type: 'code', lang, code: code.join('\n') })
      code = null
      continue
    }
    if (code !== null) code.push(line)
    else text.push(line)
  }

  if (code !== null) blocks.push({ type: 'code', lang, code: code.join('\n') })
  else flushText()

  return blocks.filter((b) => b.type === 'code' || b.text.trim() !== '')
}

// Order matters: `code` wins over everything inside it, and ** must be tried
// before * or "**bold**" parses as an empty italic.
const INLINE =
  /`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]*)\]\(([^)\s]+)\)/g

// Tokenise one paragraph. Formatting does not nest — `**a *b* c**` is bold text
// with literal asterisks; chat replies don't lean on nesting.
export function parseInline(source: string): Inline[] {
  const nodes: Inline[] = []
  let lastIndex = 0

  INLINE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: source.slice(lastIndex, match.index) })
    }

    const [, code, bold, italic, linkText, linkHref] = match
    if (code !== undefined) nodes.push({ type: 'code', text: code })
    else if (bold !== undefined) nodes.push({ type: 'bold', text: bold })
    else if (italic !== undefined) nodes.push({ type: 'italic', text: italic })
    else {
      const href = safeHref(linkHref)
      // Unsafe scheme isn't dropped — shown as inert text, exactly as written.
      if (href) nodes.push({ type: 'link', text: linkText, href })
      else nodes.push({ type: 'text', text: match[0] })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < source.length) {
    nodes.push({ type: 'text', text: source.slice(lastIndex) })
  }
  return nodes
}

// Allowlist only inert schemes: javascript:, data: (HTML payload) and blob: are
// all unsafe, so a denylist can't stay correct.
export function safeHref(url: string): string | null {
  const trimmed = url.trim()
  // Protocol-relative and rooted paths carry no scheme, so nothing to abuse.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed

  try {
    const { protocol } = new URL(trimmed)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
      ? trimmed
      : null
  } catch {
    return null // not a URL at all
  }
}
