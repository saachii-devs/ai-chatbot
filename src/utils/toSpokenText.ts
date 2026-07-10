// Strips markdown syntax and keeps the words, for TTS and the call overlay's
// one flowing line. NOT a real parser: it is fed a PARTIAL reply on every
// streamed chunk, so it must degrade sanely on half a marker (`**Music pit`).

// Fenced code, then inline code. Fences first, or their backticks pair wrongly.
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`([^`]*)`/g

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g

// Line-anchored, so they must run before newlines collapse to spaces. Each ends
// (?:[ \t]+|$) so a mid-stream marker without its trailing space still matches.
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm
const BLOCKQUOTE = /^[ \t]{0,3}>[ \t]?/gm
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm
const LIST_MARKER = /^[ \t]{0,3}(?:[-*+]|\d+[.)])(?:[ \t]+|$)/gm

const BOLD = /(\*\*|__)(.+?)\1/gs
// A single * or _ hugging its text, and not part of a word (snake_case).
const ITALIC = /(?<![\w*_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*_])/gs

// A bold marker whose partner never arrived — or has not been streamed yet.
const ORPHAN_PAIR = /\*\*|__/g
// A lone * hugging its word (`*Music`, `pitch*`); must touch a non-space, or
// `2 * 3` loses its sign. No _ twin: a lone underscore is snake_case.
const ORPHAN_STAR = /\*(?=\S)|(?<=\S)\*/g
// A trailing * is always an incomplete marker: this string is a PREFIX of a
// still-streaming reply, so its last star's word hasn't landed. (`2 * 3` is safe.)
const TRAILING_STAR = /\*+$/

export function toSpokenText(markdown: string): string {
  let text = markdown

  text = text.replace(FENCED_CODE, ' ')
  text = text.replace(INLINE_CODE, '$1')
  text = text.replace(IMAGE, ' ')
  text = text.replace(LINK, '$1')

  // While the lines are still lines.
  text = text.replace(RULE, '')
  text = text.replace(HEADING, '')
  text = text.replace(BLOCKQUOTE, '')
  text = text.replace(LIST_MARKER, '')

  text = text.replace(BOLD, '$2')
  text = text.replace(ITALIC, '$2')
  text = text.replace(ORPHAN_PAIR, '')
  text = text.replace(ORPHAN_STAR, '')
  text = text.replace(TRAILING_STAR, '')

  // Collapse all whitespace: paragraphs and bullets both render as one line anyway.
  return text.replace(/\s+/g, ' ').trim()
}
