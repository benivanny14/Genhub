// =============================================================================
// GENHUB - The app's default loading state
//
// A `loading.tsx` at the root covers every page that does not define its own, so
// this one file is what turns "nothing happened for two seconds" into "the page
// is arriving". See components/PageLoading.tsx for why it exists at all and why
// it deliberately fetches nothing.
// =============================================================================

import PageLoading from "@/components/PageLoading";

export default function Loading() {
  return <PageLoading label="Loading Genhub" />;
}
