// =============================================================================
// GENHUB - Reading a failed upload's report
//
// A failure record says how far the transfer got and how many attempts it took;
// the two together say what kind of fault it was. Turning those numbers into a
// sentence has to be a shared, pure function rather than logic inlined in the
// panel, because the first version of it was wrong in a way the panel could not
// notice:
//
//   a live 5.5 MB failure recorded eight attempts of 225, 35, 45, 258, 226, 233,
//   270 and 475 ms with `bytesSent: 0`, and the panel printed "no upload progress
//   was ever reported" and "bytes were moving, so the transfer is being cut"
//   immediately below each other. Two sentences, one row, and they cannot both
//   be true.
//
// The lesson is the order the two facts are read in. `bytesSent` is a statement
// about what left the browser; the durations only say how long each attempt
// stayed alive while failing. So the BYTES decide the sentence and the timings
// add detail to it — never the other way round.
//
// No imports, deliberately: the admin panel is a client component and the log
// line runs on the server, and a module both can use must not drag a Redis
// client, a Prisma client or a browser API into either bundle.
// =============================================================================

/** The fields this reading needs, as both callers have them. */
export interface UploadFailureShape {
  /** What left the browser, or null when it was never reported. Zero means no
   *  byte was ever acknowledged — which is not the same claim as "nothing was
   *  sent", only as "nothing was ever confirmed sent". */
  bytesSent: number | null;
  /** How long each attempt lasted, in milliseconds, oldest first. */
  attemptMs: number[] | null;
}

/**
 * An attempt shorter than this cannot have completed a network round trip.
 *
 * A live measurement taken alongside this read found a 150 ms RTT from the same
 * browser, so a failure inside 500 ms is with high confidence a request that
 * never left the device. It is a floor for a floor: anything under it is almost
 * certainly local, and anything over it merely might have reached the network.
 */
const NO_ROUND_TRIP_MS = 500;

/** `12 ms`, `1.4 s` — read by a person during an incident, not by a machine. */
export function formatUploadMs(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** `780 KB`, `145.3 MB` — the unit a creator would say the file is. */
export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One sentence explaining what the attempts mean, or null when there is nothing
 * to explain — an entry written before the timings existed, or a report that
 * carried none.
 */
export function describeUploadFailureAttempts(failure: UploadFailureShape): string | null {
  const attempts = failure.attemptMs;
  if (!attempts || attempts.length === 0) return null;

  const shape = `${attempts.length} attempt(s) lasting ${attempts
    .map(formatUploadMs)
    .join(", ")}`;
  const sent = failure.bytesSent;

  // Nothing acknowledged AND no attempt lived long enough to leave the device:
  // this is not a slow link, it is a request that never got onto the network.
  if ((sent === null || sent === 0) && attempts.every((ms) => ms < NO_ROUND_TRIP_MS)) {
    return `${shape} — nothing was ever acknowledged and no attempt lasted long enough to leave the device.`;
  }
  if (sent === 0) {
    return `${shape} — no byte was ever acknowledged, so the transfer kept being cut before it started.`;
  }
  if (sent === null) {
    return `${shape} — the byte position was not reported, so only the timings are known.`;
  }
  return `${shape} — the transfer was already moving (${formatUploadBytes(sent)} acknowledged) when it died.`;
}
