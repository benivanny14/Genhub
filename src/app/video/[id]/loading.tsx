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

      <div className="skeleton aspect-video w-full rounded-2xl" />

      <div className="skeleton mt-6 h-7 w-3/5" />

      <div className="mt-4 flex items-center gap-3">
        <div className="skeleton h-10 w-10 rounded-full" />
        <div className="skeleton h-4 w-40" />
      </div>

      <div className="mt-6 space-y-3">
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-11/12" />
        <div className="skeleton h-4 w-2/3" />
      </div>
    </div>
  );
}
