"use client";

// =============================================================================
// GENHUB - What an operator has set, read once per page load
//
// Two things the viewer-facing interface has to know and neither of which is
// worth asking about twice:
//
//   the "everything is free right now" switch — while PlatformSetting
//   `videos.all_free` is on, every paid scene plays for everyone, so NO PRICE
//   may appear anywhere a viewer looks: a TZS amount on a card nobody is being
//   asked to pay for is a lie the customer can see.
//
//   the background clip — the layer at the very back of every page.
//
// BOTH READ THE SAME ENDPOINT. They used to be able to end up as two requests
// for one JSON body, because each held its own cache of its own field; they
// now hold the whole answer and publish the fields separately, so a page that
// shows prices and paints the backdrop still makes ONE call.
//
// ONE READ PER PAGE LOAD. A grid renders dozens of VideoCards, and each one
// asking for itself would be dozens of requests for one boolean; the value is
// held in a module-level cache, shared, and only refetched after a short TTL so
// an admin who flips the switch is seen within seconds without a redeploy.
//
// `refreshSiteStatus` is the other half of that, and it exists for one action:
// the admin replacing the background clip. A TTL is a deadline, and "up to
// fifteen seconds" is not what an operator who just watched a progress bar
// reach 100% is owed — they asked for it to change NOW, and a page that keeps
// playing the old footage until it is reloaded reads as a failed upload.
//
// THE THREE STATES of the switch, and why they are not just `true`/`false`:
//   undefined  the switch has not answered yet — hide the price. A price that
//              blinks onto a free card is exactly what this is meant to prevent,
//              and a price that appears a moment late on a paid card is harmless.
//   true       free — replace the price with a "FREE" label.
//   false      paid — show the price as usual. A failed read lands here, so a
//              broken status endpoint can never hide every price on the site.
// =============================================================================

import { useEffect, useState } from "react";
import { NO_BACKGROUND_VIDEO, type BackgroundVideo } from "@/lib/background-video";

/** How long a cached answer is trusted before a remount asks again. */
const CACHE_TTL_MS = 15_000;

interface SiteStatus {
  allVideosFree: boolean;
  backgroundVideo: BackgroundVideo;
}

let cached: SiteStatus | undefined;
let cachedAt = 0;
let inflight: Promise<void> | null = null;

const freeListeners = new Set<(value: boolean) => void>();
const videoListeners = new Set<(value: BackgroundVideo) => void>();

/** Both fields are answered from one body, or from the same safe default. */
function publish(status: SiteStatus): void {
  cached = status;
  cachedAt = Date.now();
  for (const listener of freeListeners) listener(status.allVideosFree);
  for (const listener of videoListeners) listener(status.backgroundVideo);
}

function load(): Promise<void> {
  if (inflight) return inflight;

  inflight = fetch("/api/site/status")
    .then((res) => res.json())
    .then((body) => {
      // A malformed or unsuccessful answer resolves to "paid, no backdrop":
      // prices stay up, which is the safe direction — see the file header.
      if (!body?.success) {
        publish({ allVideosFree: false, backgroundVideo: NO_BACKGROUND_VIDEO });
        return;
      }
      publish({
        allVideosFree: body.data?.allVideosFree === true,
        backgroundVideo: body.data?.backgroundVideo ?? NO_BACKGROUND_VIDEO,
      });
    })
    .catch(() => {
      publish({ allVideosFree: false, backgroundVideo: NO_BACKGROUND_VIDEO });
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function isFresh(): boolean {
  return cached !== undefined && Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * Forget what we hold, ask again, and tell every mounted component.
 *
 * Called after an admin replaces or removes the clip, so the backdrop behind
 * the page they are looking at follows the upload instead of waiting out the
 * TTL or a reload. Resolves once the new answer has been published (or the read
 * has failed, which publishes the safe default — see `load`). Never throws: the
 * caller is a success path in an upload flow, and a failed re-read must not
 * turn a saved clip into an error toast.
 */
export async function refreshSiteStatus(): Promise<void> {
  cached = undefined;
  cachedAt = 0;

  // Wait out any read already on the wire. It was started before whatever the
  // caller just changed, so its answer is the one being replaced — letting it
  // land last would put the old value back.
  if (inflight) {
    try {
      await inflight;
    } catch {
      // `load` swallows its own failures; this is only here so one rejection
      // cannot skip the fresh read below.
    }
  }

  try {
    await load();
  } catch {
    // Already handled inside `load`.
  }
}

/**
 * `true` while every video is free to watch, `false` when prices apply, and
 * `undefined` until the first answer arrives.
 *
 * Callers that show a price must treat `undefined` as "do not show it yet" and
 * show the price only when the value is definitively `false`.
 */
export function useAllVideosFree(): boolean | undefined {
  const [value, setValue] = useState<boolean | undefined>(cached?.allVideosFree);

  useEffect(() => {
    // SUBSCRIBE FIRST, THEN DECIDE WHETHER TO FETCH.
    //
    // The order matters more than it looks. This used to return early on a warm
    // cache — before joining the listener set — so a component that mounted
    // within the TTL was left permanently deaf: it kept the value it read at
    // mount, and the later answer (an operator flipping the switch, a clip
    // being replaced) had nobody to reach. A full reload was the only way out.
    const listener = (next: boolean) => setValue(next);
    freeListeners.add(listener);

    if (isFresh() && cached) {
      setValue(cached.allVideosFree);
    } else {
      void load();
    }

    return () => {
      freeListeners.delete(listener);
    };
  }, []);

  return value;
}

/**
 * The clip behind every page, or `null` when there is none.
 *
 * `null` is a real answer and is also what a failed read gives, so the layer
 * simply does not mount — the page falls back to the aurora, which is what it
 * looked like before an operator ever uploaded anything.
 */
export function useBackgroundVideo(): BackgroundVideo {
  const [value, setValue] = useState<BackgroundVideo>(cached?.backgroundVideo ?? NO_BACKGROUND_VIDEO);

  useEffect(() => {
    // Subscribe before the freshness check — see `useAllVideosFree`. This hook
    // is the one that made the fault visible: the admin uploads a clip, the
    // server stores it, and the layer behind the page goes on playing the old
    // one because it was never listening for the new answer.
    const listener = (next: BackgroundVideo) => setValue(next);
    videoListeners.add(listener);

    if (isFresh() && cached) {
      setValue(cached.backgroundVideo);
    } else {
      void load();
    }

    return () => {
      videoListeners.delete(listener);
    };
  }, []);

  return value;
}
