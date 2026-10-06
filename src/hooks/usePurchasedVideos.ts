"use client";

// =============================================================================
// GENHUB - Which scenes this viewer already paid for (client read)
//
// A grid of covers cannot show the one thing a buyer looks for: which of these
// they already own. A price badge keeps asking a question that, for a scene they
// bought, has already been answered — so this hook feeds the answer, and the
// card swaps the price for a PAID label.
//
// ONE READ PER PAGE LOAD. A grid renders dozens of VideoCards, and each asking
// for itself would be dozens of requests for one small list; the value is held in
// a module-level cache and shared. A short TTL makes a scene bought on another
// page show up when the viewer comes back, and refreshPurchasedVideoIds() lets
// the purchase flow update it the moment a payment settles, without waiting.
//
// UNKNOWN IS NOT "PAID". If the read fails the last answer stands, and a viewer
// who has never had one sees prices — the safe direction. Quoting a price to
// someone who already owns a scene is a nuisance; marking a scene paid that they
// never bought, and so hiding its price, is a sale nobody can make.
//
// Signed out is simply an empty set: nothing is marked, and every price stays.
// =============================================================================

import { useEffect, useState } from "react";

/** How long a cached answer is trusted before a remount asks again. */
const CACHE_TTL_MS = 15_000;

/** One stable empty set, so every "nothing known yet" render shares a value. */
const EMPTY: ReadonlySet<string> = new Set();

let cached: ReadonlySet<string> | undefined;
let cachedAt = 0;
let inflight: Promise<void> | null = null;

const listeners = new Set<(value: ReadonlySet<string>) => void>();

function publish(value: ReadonlySet<string>): void {
  cached = value;
  cachedAt = Date.now();
  for (const listener of listeners) listener(value);
}

function load(): Promise<void> {
  if (inflight) return inflight;

  inflight = fetch("/api/videos/purchased")
    .then((res) => res.json())
    .then((body) => {
      const ids: unknown =
        body?.success && Array.isArray(body.data?.videoIds) ? body.data.videoIds : [];
      publish(new Set((ids as string[]).filter((id) => typeof id === "string")));
    })
    .catch(() => {
      // Offline or the server blinked. Keep whatever we knew — see the header.
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Ask again, right now — for the purchase flow, where the viewer has just paid
 * and the answer we hold is known to be out of date. Skipping the TTL is the
 * whole point, so it is a separate entry point rather than a flag on the hook.
 */
export function refreshPurchasedVideoIds(): Promise<void> {
  cachedAt = 0;
  return load();
}

/** Test seam: drop the shared cache between cases. */
export function resetPurchasedVideoIds(): void {
  cached = undefined;
  cachedAt = 0;
  inflight = null;
  listeners.clear();
}

/**
 * The scene ids this viewer has paid for — empty until the first answer arrives,
 * and empty for a signed-out visitor.
 */
export function usePurchasedVideoIds(): ReadonlySet<string> {
  const [value, setValue] = useState<ReadonlySet<string>>(cached ?? EMPTY);

  useEffect(() => {
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
      setValue(cached);
      return;
    }

    const listener = (next: ReadonlySet<string>) => setValue(next);
    listeners.add(listener);
    void load();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return value;
}
