// =============================================================================
// GENHUB - Home page shelves, without the repeats
// =============================================================================
// The home page renders five curated rows — New Releases, Most Popular, Top
// Rated, Free to Watch, Trending Now — and each is its own query over the same
// catalogue. Nothing in the API guarantees they differ, so on a young site they
// do not: with one published video the page showed that video FIVE times, under
// five headings, each with a "See all" that led to the same grid. A visitor does
// not read that as "new platform" — they read it as a broken page, because five
// shelves holding the same object is what a template looks like before it is
// filled in.
//
// The rule here: a row keeps only the videos not already shown ABOVE it, and a
// row left with nothing is dropped instead of rendered empty. Order matters and
// is the caller's: the first row to show a video is the one that keeps it.
//
// The trade-off is deliberate and worth naming: a curated row that happens to be
// a strict subset of what is already on screen disappears, so "Free to Watch"
// can fold away when every one of its videos is also in "New Releases". That is
// the right way round. The heading exists to help someone find something they
// have not seen; a shelf of titles already on the page tells them nothing, while
// the full list stays one tap away under "See all" — and as a catalogue grows,
// the queries diverge and the rows come back on their own.
//
// Pure, so src/tests/home-rows.test.ts pins the ordering and the drop rule
// without a database.
// =============================================================================

export interface Identified {
  id: string;
}

/**
 * @param rows ordered shelves, e.g. `{ new: [...], popular: [...] }`
 * @returns the same keys, each holding only videos not present in an earlier row
 */
export function pickFreshRows<T extends Identified, K extends string>(
  rows: Record<K, T[]>
): Record<K, T[]> {
  const seen = new Set<string>();
  const result = {} as Record<K, T[]>;

  for (const key of Object.keys(rows) as K[]) {
    const fresh: T[] = [];
    for (const video of rows[key] || []) {
      // A row can contain the same video twice on its own (a query change, a
      // duplicated join) — that is a repeat too, so the check goes through the
      // same set rather than a per-row one.
      if (seen.has(video.id)) continue;
      seen.add(video.id);
      fresh.push(video);
    }
    result[key] = fresh;
  }

  return result;
}
