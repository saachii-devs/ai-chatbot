// The one definition of the layout breakpoint, shared with Tailwind's md:/max-md:.
// 767.98px, not 768px: max-md is (width < 48rem), so a 767.5px viewport
// (fractional zoom) lands on the same side of both.

// Matches when the rail is a slide-over drawer rather than part of the layout.
export const BELOW_MD = '(max-width: 767.98px)'

// Shared by the drawer shell and the rail so the two cannot drift. min() keeps
// it off the edge of a 320px phone, where a flat 18rem would leave chat visible.
export const RAIL_WIDTH = 'w-[min(18rem,85vw)]'
