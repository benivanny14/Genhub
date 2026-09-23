// =============================================================================
// GENHUB - Demo data is development scaffolding, never production content
//
// Several screens fall back to `lib/demo-data` when a request fails, so the
// layout stays explorable without a database. Reasonable in development. On a
// launched site it is a lie: with zero published videos the homepage rendered
// 24 invented scenes with invented creators, prices, view counts and buy
// buttons, and nothing on the page said they were not real. A first visitor
// would be told the platform has content it does not have, and a link into one
// of those scenes leads nowhere.
//
// The mistake was not the fallback. It was that the fallback decided from an
// empty response instead of from the environment, and had no environment check
// of its own. "The database returned nothing" and "the database is unreachable"
// are different conditions (see the note in `hooks/useInfiniteVideos.ts`), and
// only the second one is a development problem — so the rule is now:
//
//   demo data appears only in development, and only when a request FAILED
//
// An empty result means empty. That is the honest thing to show a visitor, and
// the only thing that makes "0 videos" mean what it says. A developer who wants
// content to design against can run `POST /api/demo/seed` (dev-only) — against a
// scratch database, not the one real users are on.
//
// So every fallback is gated on this, in exactly one place:
//
//   demoDataEnabled() ? buildDemoFeed() : null
//
// `process.env.NODE_ENV` is inlined at build time, so in a production bundle
// this is the literal `false` and the branches below are dead code.
// =============================================================================

/** True only outside a production build — i.e. `npm run dev` and tests. */
export function demoDataEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
