// =============================================================================
// GENHUB - What the VIDEO HOST says it holds
//
// The creator's browser reports its own progress, and on a bad mobile
// connection that number lies in the most expensive direction: it counts bytes
// handed to the socket, not bytes the host kept. A stalled transfer therefore
// looks exactly like a working one until the retry ladder gives up, minutes
// later, and the creator is left with a bar that will not move and no way to
// tell how far the file actually got.
//
// So the dashboard shows the HOST's own number next to that bar. Two facts from
// the live Bunny Stream API decide how it has to be read, both measured while
// this was written:
//
//   * A slot whose transfer never completed reports `status 0, storageSize 0` —
//     and so does a slot mid-transfer (half a 2.8 MB file PATCHed and
//     acknowledged at offset 1 424 104 by TUS `HEAD` returned *exactly the same
//     zeros*). No field on the object separates "arriving" from "never arrived".
//     The split only appears afterwards: the instant a transfer completes, the
//     status leaves 0 (it read 2 within a second), and a transfer that never
//     completed stays at 0 forever.
//   * `storageSize` is NOT a received-bytes counter. It stays 0 for the whole
//     upload AND the transcode, then reports the whole encoded footprint at
//     once — 37 MB for a 2.8 MB source, because it counts every rendition.
//
// Hence both numbers together, and no number alone: `0 B` beside a video still
// sitting at Queued is a transfer that has not finished, while `0 B` beside a
// finished one would be a contradiction and is not what Bunny reports.
// =============================================================================

/**
 * A byte count a person can read: `0 B`, `812 KB`, `1.4 GB`.
 *
 * 1024-based, matching every other size in the product (the upload form says
 * "Max 2GB" for 2 * 1024^3). `null` is a real answer here — it means Bunny has
 * not reported a size yet — so it gets its own word rather than being shown as
 * a zero that would accuse a working upload.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 (`1.4 GB`) and none above (`437 MB`): the extra digit
  // is noise once the number is in the hundreds, and this is read at a glance.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface HostStoredSummary {
  /** The line itself, e.g. `Host holds 437 MB of 812 MB`. */
  text: string;
  /**
   * True when the host holds nothing. Read together with the encoding state,
   * this is the stalled-transfer signal: a video still being processed with
   * `empty` set is a file that is not arriving.
   */
  empty: boolean;
  /** The longer explanation, for a `title`/tooltip. */
  detail: string;
}

/**
 * Describe what the host holds, or null when there is nothing worth saying.
 *
 * `sourceBytes` is the creator's own file size, recorded when they created the
 * video row. With it the line answers the only question worth asking about a
 * stuck upload — did the whole file arrive? — and without it (rows created
 * before that was recorded) it still answers "does the host hold anything".
 */
export function describeHostStoredBytes(params: {
  /** Omitted and null mean the same thing: the host has not said. */
  storedBytes?: number | null | undefined;
  sourceBytes?: number | null | undefined;
}): HostStoredSummary | null {
  const stored =
    typeof params.storedBytes === "number" && Number.isFinite(params.storedBytes)
      ? params.storedBytes
      : null;
  const source =
    typeof params.sourceBytes === "number" && params.sourceBytes > 0
      ? params.sourceBytes
      : null;

  if (stored === null && source === null) return null;

  if (stored === null) {
    return {
      text: "Host has not reported a size yet",
      empty: false,
      detail:
        "The video host has not answered with a size for this file yet, so nothing can be said about how much of it arrived. This clears on its own on the next check.",
    };
  }

  const of = source ? ` of ${formatBytes(source)}` : "";
  const text = `Host holds ${formatBytes(stored)}${of}`;

  if (stored === 0) {
    return {
      text,
      empty: true,
      detail:
        "The video host holds none of this file. While the video is still being prepared that means the transfer has not finished arriving — the bytes your browser reports are on the way to, or lost in, the connection, not stored. A video that stays here is one to upload again.",
    };
  }

  return {
    text,
    empty: false,
    detail:
      "Bytes the video host reports holding for this file. It reports the whole encoded set at once when processing finishes, so this stays at zero for the entire transfer and jumps to the final size — 0 B does not by itself mean a failure while the video is still being prepared.",
  };
}
