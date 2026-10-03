"use client";

// =============================================================================
// GENHUB - The operator's "everything is free right now" switch (client read)
//
// While PlatformSetting `videos.all_free` is on, every paid scene plays for
// everyone, so NO PRICE may appear anywhere a viewer looks: a TZS amount on a
// card nobody is being asked to pay for is a lie the customer can see. This hook
// is how the viewer-facing screens (video cards, the search shelf, watch history,
// the "more scenes" strip) learn about the switch and drop the price.
//
// ONE READ PER PAGE LOAD. A grid renders dozens of VideoCards, and each one
// asking for itself would be dozens of requests for one boolean; the value is
// held in a module-level cache, shared, and only refetched after a short TTL so
// an admin who flips the switch is seen within seconds without a redeploy.
//
// THE THREE STATES, and why they are not just `true`/`false`:
//   undefined  the switch has not answered yet — hide the price. A price that
//              blinks onto a free card is exactly what this is meant to prevent,
//              and a price that appears a moment late on a paid card is harmless.
//   true       free — replace the price with a "FREE" label.
//   false      paid — show the price as usual. A failed read lands here, so a
//              broken status endpoint can never hide every price on the site.
// =============================================================================

import { useEffect, useState } from "react";

/** How long a cached answer is trusted before a remount asks again. */
const CACHE_TTL_MS = 15_000;

let cached: boolean | undefined;
let cachedAt = 0;
let inflight: Promise<void> | null = null;

const listeners = new Set<(value: boolean) => void>();

function publish(value: boolean): void {
  cached = value;
  cachedAt = Date.now();
  for (const listener of listeners) listener(value);
}

function load(): Promise<void> {
  if (inflight) return inflight;

  inflight = fetch("/api/site/status")
    .then((res) => res.json())
    .then((body) => {
      // A malformed or unsuccessful answer resolves to "paid": prices stay up,
      // which is the safe direction — see the file header.
      publish(body?.success ? body.data?.allVideosFree === true : false);
    })
    .catch(() => {
      publish(false);
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * `true` while every video is free to watch, `false` when prices apply, and
 * `undefined` until the first answer arrives.
 *
 * Callers that show a price must treat `undefined` as "do not show it yet" and
 * show the price only when the value is definitively `false`.
 */
export function useAllVideosFree(): boolean | undefined {
  const [value, setValue] = useState<boolean | undefined>(cached);

  useEffect(() => {
    const fresh = cached !== undefined && Date.now() - cachedAt < CACHE_TTL_MS;
    if (fresh) {
      setValue(cached);
      return;
    }

    const listener = (next: boolean) => setValue(next);
    listeners.add(listener);
    void load();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return value;
}
