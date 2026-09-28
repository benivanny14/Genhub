"use client";

// =============================================================================
// GENHUB - Watching a processing video become playable, without a reload
//
// Instant publication means a post can be on screen before it can be played
// (see lib/video-status.ts). This hook is what closes that gap in the UI: while
// anything on the page is PROCESSING, one shared timer asks the server which of
// those videos are ready, and the answer is pushed into the components that
// care — the feed card swaps its "Inachakatwa..." badge for a live preview, the
// watch page swaps the placeholder for the player.
//
// ONE TIMER FOR THE PAGE, one request per tick. The naive version (an interval
// per card) is a request per card every eight seconds: twenty videos being
// uploaded at once is twenty requests a tick, on a phone, for information that
// fits in one row each. So the registry below is module-level and shared, and
// the hook is only a subscription to it.
//
// It gives up on purpose. Polling stops for a video once it is no longer
// PROCESSING, stops entirely when every watched video has settled, stops when
// the tab is hidden (a background tab asking every eight seconds for hours is
// someone else's bandwidth bill), and stops after PROCESSING_POLL_MAX_MS even
// if the host never finishes — a page left open all night must not keep asking
// for a video that is stuck. Reloading the page is always the fallback, and it
// is what a viewer would do anyway.
// =============================================================================

import { useEffect, useState } from "react";
import {
  PROCESSING_POLL_MS,
  PROCESSING_POLL_MAX_MS,
  type VideoStatus,
} from "@/lib/video-status";

export interface VideoStatusUpdate {
  status: VideoStatus;
  progress: number;
}

type Listener = (update: VideoStatusUpdate) => void;

/** id -> everyone on this page who is showing that video. */
const listeners = new Map<string, Set<Listener>>();
/** id -> when this page started watching it, for PROCESSING_POLL_MAX_MS. */
const watchingSince = new Map<string, number>();
/** The last answer for each id, so a late subscriber is not left blank. */
const latest = new Map<string, VideoStatusUpdate>();

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/**
 * Is this video worth another question?
 *
 * Unknown counts as worth asking (the page has not heard yet), PROCESSING
 * obviously does, and anything settled does not — which is what makes the
 * whole poller stop on its own the moment the last upload finishes.
 */
export function shouldKeepPolling(
  id: string,
  update: VideoStatusUpdate | undefined,
  seenAt: number | undefined,
  now: number = Date.now()
): boolean {
  if (seenAt !== undefined && now - seenAt > PROCESSING_POLL_MAX_MS) return false;
  if (!update) return true;
  return update.status === "PROCESSING";
}

function watchedIds(): string[] {
  const now = Date.now();
  return [...listeners.keys()].filter((id) =>
    shouldKeepPolling(id, latest.get(id), watchingSince.get(id), now)
  );
}

function notify(id: string, update: VideoStatusUpdate) {
  const current = latest.get(id);
  if (current && current.status === update.status && current.progress === update.progress) {
    return; // nothing moved — do not re-render half a feed for it
  }
  latest.set(id, update);
  for (const listener of listeners.get(id) ?? []) listener(update);
}

async function tick() {
  timer = null;
  if (typeof document !== "undefined" && document.hidden) {
    schedule(); // somebody is not looking; ask again when they are
    return;
  }
  const ids = watchedIds();
  if (ids.length === 0) return;

  inFlight = true;
  try {
    const res = await fetch("/api/videos/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json().catch(() => null);
    const statuses = (data?.data?.statuses ?? {}) as Record<string, VideoStatusUpdate>;
    for (const [id, update] of Object.entries(statuses)) notify(id, update);
  } catch {
    // Offline, or the server blinked. Nothing to report and nothing to fix
    // here: the next tick tries again, and the page keeps showing whatever it
    // was showing, which is exactly the state it is in.
  } finally {
    inFlight = false;
    schedule();
  }
}

function schedule() {
  if (timer || inFlight) return;
  if (typeof window === "undefined") return;
  if (typeof document !== "undefined" && document.hidden) return;
  if (watchedIds().length === 0) return;
  timer = setTimeout(tick, PROCESSING_POLL_MS);
}

let visibilityBound = false;

/** Poll straight away when the viewer comes back, instead of up to 8s later. */
function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!inFlight) void tick();
  });
}

/**
 * Watch one or more videos until they settle.
 *
 * Returns an unsubscribe function. Subscribing to a video that has already been
 * answered delivers the last answer immediately, so a card that mounts late is
 * never stuck on the placeholder for a whole tick.
 */
export function watchVideoStatuses(
  ids: string[],
  onUpdate: (id: string, update: VideoStatusUpdate) => void
): () => void {
  if (typeof window === "undefined" || ids.length === 0) return () => {};

  // Each subscription owns its own wrapper, so unsubscribing one card cannot
  // silence another that happens to be showing the same video (a grid and a
  // sidebar, a watch page and its related list).
  const added: { id: string; listener: Listener }[] = [];
  for (const id of ids) {
    let set = listeners.get(id);
    if (!set) {
      set = new Set();
      listeners.set(id, set);
      // The give-up clock starts when this page first asks about the video, not
      // when it was uploaded: a fresh page deserves a full window to watch it
      // finish.
      watchingSince.set(id, Date.now());
    }
    const listener: Listener = (update) => onUpdate(id, update);
    set.add(listener);
    added.push({ id, listener });

    const known = latest.get(id);
    if (known) onUpdate(id, known);
  }

  bindVisibility();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void tick(); // ask now; the first question must not wait a tick

  return () => {
    for (const { id, listener } of added) {
      const set = listeners.get(id);
      if (!set) continue;
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(id);
        watchingSince.delete(id);
      }
    }
  };
}

/** Test seam: drop all shared state between cases. */
export function resetVideoStatusPolling() {
  listeners.clear();
  watchingSince.clear();
  latest.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = false;
}

/**
 * Live publication status for the videos a component is showing.
 *
 * The returned map is empty until the first answer arrives, so callers should
 * treat a missing entry as "what the server told us when the page loaded" —
 * which is the `status` field every feed response already carries.
 */
export function useVideoStatuses(ids: string[]): Record<string, VideoStatusUpdate> {
  // The array identity changes on every render; the ids inside it are what the
  // subscription actually depends on.
  const key = ids.join("|");
  const [updates, setUpdates] = useState<Record<string, VideoStatusUpdate>>({});

  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (list.length === 0) return;

    return watchVideoStatuses(list, (id, update) => {
      setUpdates((prev) => {
        const current = prev[id];
        if (current && current.status === update.status && current.progress === update.progress) {
          return prev;
        }
        return { ...prev, [id]: update };
      });
    });
  }, [key]);

  return updates;
}
