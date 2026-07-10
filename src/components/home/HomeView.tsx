// The greeting (the composer itself lives in <Composer/>, above both views).
// Anchored to the composer: its bottom sits one gap above the composer's home-position
// top edge, so neither element needs the other's height at build time.
// --kb-inset matches the composer's own lift (see Composer's FLOOR) so the two rise
// together when the mobile keyboard opens, instead of the box sliding over the text.
const POSITION = {
  bottom: 'calc(50% + 0.5rem + var(--composer-h, 0px) / 2 + var(--kb-inset, 0px))',
  opacity: 'var(--settle-inv)',
}

export default function HomeView() {
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10 px-4" style={POSITION}>
      <h1 className="font-display text-center text-4xl text-neutral-200 md:text-5xl">
        <span className="font-sans">How can I assist you today?</span>, Buddy?
       </h1>
    </div>
  )
}
