// =============================================================================
// GENHUB - Reading the attempts of a failed upload
//
// A failure record says how many attempts were spent; the timings say what kind
// of fault they were spent on. That reading is the whole reason the timings are
// recorded, and it has to be a function rather than a threshold inlined in the
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
// stayed alive while failing. So the bytes decide the sentence, and the timings
// add detail to it — never the other way round.
// =============================================================================

/** The two fields this reading needs, as the panel receives them. */
export interface AttemptShape {
  /**
   * What the browser last reported as sent, or null when it never reported.
   * Zero means no progress was ever acknowledged — which is not the same claim
   * as "nothing was sent", only as "nothing was ever confirmed sent".
   */
  bytesSent: number | null;
  /** How long each attempt at the failing chunk lasted, in milliseconds, oldest first. */
  attemptMs: number[] | null;
}

/**
 * An attempt shorter than this cannot have completed a network round trip.
 *
 * The live measurement above had a 150 ms RTT reported by the same browser, so a
 * failure inside 50 ms happened without leaving the device. It is a floor for a
 * floor: anything under it is certainly local, and anything over it merely might
 * have reached the network.
 */
const NO_ROUND_TRIP_MS = 50;

/** `12 ms`, `1.4 s` — read by a person during an incident, not by a machine. */
function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * One sentence explaining what the attempts mean, or null when there is nothing
 * to explain (an entry written before the timings existed, or a report that
 * carried none).
 */
export function describeAttemptShape({ bytesSent, attemptMs }: AttemptShape): string | null {
  if (!attemptMs || attemptMs.length === 0) return null;

  const head = `${attemptMs.length} attempt(s) on this chunk lasted ${attemptMs
    .map(formatMs)
    .join(", ")}`;

  // The bytes decide. Only the sentence about a transfer that was MOVING needs
  // acknowledged bytes to stand on.
  if (typeof bytesSent === "number" && bytesSent > 0) {
    return `${head} — bytes were moving, so the transfer is being cut rather than refused.`;
  }
  if (typeof bytesSent !== "number") {
    return `${head} — the browser never reported how far it got, so the durations are all there is to read.`;
  }
  if (attemptMs.every((ms) => ms < NO_ROUND_TRIP_MS)) {
    return `${head} — none of those lasted a round trip, so the request never reached the network at all.`;
  }
  return (
    `${head} — every one ended with nothing acknowledged, so no byte of the file was ever confirmed on the wire. ` +
    `A device that cannot read the file looks the same as a host that refuses it, and a smaller chunk will not help either way.`
  );
}
