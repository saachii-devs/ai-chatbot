import { Fragment } from 'react'
import { parseBlocks, parseInline } from '../../utils/markdown'

// Renders the markdown subset as React elements. No dangerouslySetInnerHTML:
// model output is never parsed as HTML, so injected tags render as literal text.

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((node, i) => {
        switch (node.type) {
          case 'code':
            return (
              <code
                key={i}
                className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-neutral-100"
              >
                {node.text}
              </code>
            )
          case 'bold':
            return (
              <strong key={i} className="font-semibold text-neutral-100">
                {node.text}
              </strong>
            )
          case 'italic':
            return (
              <em key={i} className="italic">
                {node.text}
              </em>
            )
          case 'link':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                // Both spelled out: without them the opened page gets a handle on this window.
                rel="noopener noreferrer"
                className="text-blue-400 underline underline-offset-2 transition hover:text-blue-300"
              >
                {node.text || node.href}
              </a>
            )
          case 'text':
            return <Fragment key={i}>{node.text}</Fragment>
        }
      })}
    </>
  )
}

export default function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)

  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          // Code scrolls inside its own box so the bubble never widens to fit a long line.
          <pre
            key={i}
            className="my-2 max-w-full overflow-x-auto rounded-xl bg-neutral-950 p-3 first:mt-0 last:mb-0"
          >
            <code className="font-mono text-xs leading-relaxed text-neutral-200">
              {block.code}
            </code>
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words">
            <InlineText text={block.text} />
          </p>
        ),
      )}
    </>
  )
}
