// =============================================================================
// GENHUB - Loading state for the video page
//
// Its own file because the shape is different from the card grid: this is the
// page somebody waits on longest (a manifest has to be signed and fetched), and
// a 16:9 block where the player will be reads as "the player is coming" rather
// than as a grid of things that are not this page.
// =============================================================================

export default function LoadingVideo() {
  return (
    <div
      className="mx-auto w-full max-w-5xl px-4 py-6"
      role="status"
      aria-busy="true"
      aria-label="Loading video"
    >
      <span className="sr-only">Loading video…</span>

      <div className="aspect-video w-full animate-pulse rounded-2xl bg-white/10" />

      <div className="mt-6 h-7 w-3/5 animate-pulse rounded-lg bg-white/10" />

      <div className="mt-4 flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-full bg-white/10" />
        <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
      </div>

      <div className="mt-6 space-y-3">
        <div className="h-4 w-full animate-pulse rounded bg-white/10" />
        <div className="h-4 w-11/12 animate-pulse rounded bg-white/10" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-white/10" />
      </div>
    </div>
  );
}
