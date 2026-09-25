// =============================================================================
// GENHUB - Search results
//
// There was no results page. Pressing Enter in the header sent you to `/?q=…`,
// where the home page filtered its own feed — so a search worked, but it arrived
// as the front page with a filter applied: the category row, the popular-creators
// strip and the other shelves all still rendered around it, nothing said how many
// results there were, and there was nowhere to see matching creators at all.
// Beyond that, autocomplete only ever showed five suggestions, so the rest of the
// matches were effectively unreachable.
//
// This is the page the search box should lead to: results only, videos and
// creators, with a count and an explicit empty state. The home page's `?q=`
// handling stays, because links to it exist and it is still a reasonable answer.
//
// It is a server component on purpose: it
// reads `?q=` from the URL, which keeps the client component free of
// `useSearchParams()` (that needs a Suspense boundary and turns a simple page
// into a build warning), and a shared link is rendered on the server like any
// other page rather than after a round trip.
//
// The search itself is the existing `/api/videos?q=` and `/api/creators?q=`
// endpoints — the same queries the autocomplete already used, so the two cannot
// disagree about what matches.
// =============================================================================

import type { Metadata } from "next";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import SearchResults from "./SearchResults";

interface SearchPageProps {
  searchParams?: { q?: string };
}

export function generateMetadata({ searchParams }: SearchPageProps): Metadata {
  const query = (searchParams?.q || "").trim();

  return {
    title: query ? `${query} — Search | Genhub` : "Search | Genhub",
    description: query
      ? `Videos and creators matching “${query}” on Genhub.`
      : "Search videos and creators on Genhub.",
    // A results page for an arbitrary string is not content worth indexing: the
    // same words are reachable through the category pages, and indexing this
    // fills the index with an unbounded set of thin pages.
    robots: { index: false, follow: true },
  };
}

export default function SearchPage({ searchParams }: SearchPageProps) {
  const query = (searchParams?.q || "").trim();

  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6">
        <SearchResults query={query} />
      </main>
      <BottomNav />
    </>
  );
}
