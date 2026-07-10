// Where the caret sits, in viewport pixels. A textarea exposes only a character
// index, so we mirror its text in an off-screen div and measure the split point.
// Text AFTER the caret must be included, or a mid-word caret's line would move.
const MIRRORED = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-indent',
  'text-transform',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'white-space',
  'overflow-wrap',
  'word-break',
  'tab-size',
  'direction',
] as const

export function caretPoint(el: HTMLTextAreaElement): { x: number; y: number } {
  const style = getComputedStyle(el)

  const mirror = document.createElement('div')
  for (const prop of MIRRORED) mirror.style.setProperty(prop, style.getPropertyValue(prop))
  // clientWidth is the width the textarea wraps against (padding box minus
  // scrollbar); with border-box it makes the mirror's box coincide with the real one.
  mirror.style.cssText += `position:absolute;top:0;left:-9999px;visibility:hidden;box-sizing:border-box;border:0;width:${el.clientWidth}px`
  // A textarea always keeps its own whitespace, whatever the class list says.
  mirror.style.whiteSpace = 'pre-wrap'

  const caret = el.selectionEnd ?? el.value.length
  const marker = document.createElement('span')
  marker.textContent = '​' // zero-width: occupies a glyph box, paints nothing
  mirror.append(
    document.createTextNode(el.value.slice(0, caret)),
    marker,
    document.createTextNode(el.value.slice(caret)),
  )
  document.body.appendChild(mirror)

  const mirrorBox = mirror.getBoundingClientRect()
  const markerBox = marker.getBoundingClientRect()
  const dx = markerBox.left - mirrorBox.left
  const dy = markerBox.top - mirrorBox.top + markerBox.height / 2 // glyph centre = caret centre
  mirror.remove()

  const box = el.getBoundingClientRect()
  return {
    x: box.left + dx - el.scrollLeft,
    // Long drafts scroll inside the textarea, and then the caret's line can sit
    // past either edge. Clamping keeps the glow pinned to the visible box.
    y: Math.min(Math.max(box.top + dy - el.scrollTop, box.top), box.bottom),
  }
}
