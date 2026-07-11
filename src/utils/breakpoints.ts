// The one definition of the layout breakpoint, shared with Tailwind's md:/max-md:.
// 767.98px, not 768px: max-md is (width < 48rem), so a 767.5px viewport
// (fractional zoom) lands on the same side of both.

// Matches when the rail is a slide-over drawer rather than part of the layout.
export const BELOW_MD = '(max-width: 767.98px)'

// Shared by the drawer shell and the rail so the two cannot drift. min() keeps
// it off the edge of a 320px phone, where a flat 18rem would leave chat visible.
export const RAIL_WIDTH = 'w-[min(18rem,85vw)]'

// The rail collapsed to icons — desktop only, so no min() escape hatch needed.
// Wide enough to centre a 40px control with breathing room either side. Spelled
// out twice, base and md:, because Tailwind scans for literal class strings —
// building the md: variant from the base one at runtime emits no CSS.
export const RAIL_COLLAPSED_WIDTH = 'w-16'
export const RAIL_COLLAPSED_WIDTH_MD = 'md:w-16'
