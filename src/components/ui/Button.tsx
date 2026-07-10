import type { ButtonHTMLAttributes, Ref } from 'react'
import { cn } from '../../utils/cn'

// Every control funnels through here for one motion curve, focus ring, and 44px
// touch target. Colour and radius are props, not className overrides: competing
// `rounded-*` utilities resolve by stylesheet order, so an override is a coin flip.

export type ButtonVariant =
  | 'primary'
  | 'ghost'
  | 'pill'
  | 'bare'
  | 'subtle'
  | 'danger'
  | 'warn'
  | 'dangerOutline'

export type ButtonSize = 'xs' | 'sm' | 'md' | 'icon' | 'iconLg' | 'text' | 'compact'

const BASE =
  'relative inline-flex shrink-0 items-center justify-center ' +
  'transition duration-150 ease-out ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ' +
  'disabled:cursor-not-allowed disabled:active:scale-100'

// A 44px hit area via ::after so the visual size never changes. Exactly 44px, not
// larger: adjacent controls' hit areas meet without overlapping.
const HIT_AREA =
  'after:absolute after:left-1/2 after:top-1/2 after:size-11 ' +
  'after:-translate-x-1/2 after:-translate-y-1/2 after:content-[""]'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-500',
  ghost: 'bg-neutral-800 text-neutral-300 hover:bg-blue-600 hover:text-white',
  pill: 'bg-neutral-100 font-medium text-neutral-900 hover:bg-white',
  bare: 'text-neutral-300 hover:text-neutral-100',
  subtle: 'text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100',
  danger: 'text-red-300 hover:bg-red-900/50',
  warn: 'text-amber-300 hover:bg-amber-900/50',
  dangerOutline:
    'border border-red-800 font-medium text-red-300 enabled:hover:bg-red-900/50 disabled:opacity-50',
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'size-5',
  sm: 'size-6',
  md: 'size-7',
  icon: 'size-9',
  iconLg: 'size-10',
  text: 'h-9 gap-2 px-4 text-sm',
  compact: 'px-3 py-1 text-sm',
}

// Icon-sized controls press deeper — the travel reads as smaller on a small box.
const ICON_SIZES: ReadonlySet<ButtonSize> = new Set<ButtonSize>([
  'xs',
  'sm',
  'md',
  'icon',
  'iconLg',
])

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  radius?: 'full' | 'md' | 'lg'
  // Opt out of the 44px hit area for controls that sit on another control, where
  // an expanded target would eat the neighbour's clicks.
  hitArea?: boolean
  ref?: Ref<HTMLButtonElement>
}

const RADII = { full: 'rounded-full', md: 'rounded-md', lg: 'rounded-lg' } as const

export default function Button({
  variant = 'ghost',
  size = 'icon',
  radius = 'full',
  hitArea = true,
  className,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      className={cn(
        BASE,
        VARIANTS[variant],
        SIZES[size],
        RADII[radius],
        ICON_SIZES.has(size) ? 'active:scale-90' : 'active:scale-95',
        hitArea && HIT_AREA,
        className,
      )}
      {...rest}
    />
  )
}
