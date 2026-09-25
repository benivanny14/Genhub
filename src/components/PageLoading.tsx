// =============================================================================
// GENHUB - What a page looks like while it is on the way
//
// The app had no `loading.tsx` anywhere — not one segment. Every page therefore
// rendered nothing at all until its own client-side fetch came back, so the
// first thing a visitor saw after clicking a link was the previous page, frozen,
// and on a slow connection it stayed that way. A spinner that only exists inside
// a component that has not mounted yet is not a loading state.
//
// This is App Router streaming: the shell arrives immediately with the header and
// footer already interactive, and the slow part fills in. The shape below matches
// the feed and grid pages so the swap is not a jump.
//
// Deliberately data-free and `aria-busy`: nothing here may fetch. A loading state
// that waits for a request is the problem it was meant to solve.
// =============================================================================

export default function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="min-h-[60vh] w-full px-4 py-8"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <span className="sr-only">{label}…</span>

      {/* Title bar */}
      <div className="mx-auto mb-8 h-7 w-48 animate-pulse rounded-lg bg-white/10" />

      {/* Card grid — the same rhythm the feed and browse pages use, so the real
          content lands where the placeholder already was. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="aspect-video w-full animate-pulse rounded-xl bg-white/10" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-white/10" />
            <div className="h-3 w-2/5 animate-pulse rounded bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
