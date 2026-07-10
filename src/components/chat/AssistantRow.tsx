import { type ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { SparkleLogo } from '../icons'

// The assistant's mark beside its bubble; shared so the mark offset and column
// width stay in step across streaming, typing dots, and finished messages.
export default function AssistantRow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      {/* mt aligns the mark with the first line's cap height, not the box top. */}
      <SparkleLogo className="mt-[9px] size-6 shrink-0" />
      {/* min-w-0 caps the flex item's min-content width so max-w-[75%] can bite;
          without it an unbroken long word overflows before break-words applies. */}
      <div className="flex min-w-0 max-w-[75%] flex-col items-start gap-1">{children}</div>
    </div>
  )
}
