// =============================================================================
// GENHUB - Asking the creator's OWN device what it can reach
//
// Every upload failure this application has recorded says the same sentence —
// "The connection dropped during upload." — because a browser refuses to tell a
// page WHY a cross-origin request failed. `xhr.onerror` fires with `status: 0`
// for a DNS failure, a refused preflight, a TLS reset and a CORS policy refusal
// alike, and the four need completely different answers. Measured on 2026-09-29:
// a phone that completed a 192 MB multipart upload at 15:08 saw every later part
// PUT die in under a second with ZERO bytes acknowledged, and nothing anywhere in
// the system could say which of the four it was.
//
// So the device is asked directly, with two requests whose OUTCOMES differ:
//
//   * REACHABILITY, with `mode: "no-cors"`. A no-cors request is sent with no
//     preflight and its response is opaque, which is exactly the property needed:
//     the page learns nothing about the answer, but a network that cannot reach
//     the host at all — DNS, no route, a carrier that filters the domain — is the
//     ONLY thing that makes this reject. If it resolves, the host is reachable
//     and the browser had some other reason to refuse the real request.
//
//   * A REAL WRITE, with the same method and the same `Content-Type` the upload
//     uses. This is the only honest way to test a CORS preflight: the
//     `Access-Control-Request-*` headers a preflight carries are on the
//     forbidden-header list, so a page CANNOT craft one — the browser builds it
//     itself, and only a request that would trigger one gets an answer. A signed
//     URL is required for that, which is why the server hands these out
//     (/api/videos/upload-check).
//
// Between them, the four failures separate:
//
//   reachability refused                     → the device's network cannot reach it
//   reachability ok, the real write refused  → refused before it was sent (CORS),
//                                              or answered without CORS headers
//   both ok                                  → the path works, and whatever failed
//                                              was about THAT request specifically
//
// Nothing here throws and nothing here is a gate: it reports, and the creator
// reads one sentence. A probe that is itself broken must never be the reason an
// upload is refused.
// =============================================================================

/** A request that was refused by the device's own network, or was not. */
export interface ReachabilityProbe {
  ok: boolean;
  ms: number;
  /** The browser's own error name — `TypeError` is all a CORS or DNS failure
   *  gets, so the name is recorded rather than interpreted. */
  error?: string;
}

/** A real write, with the method and headers an upload uses. */
export interface WriteProbe {
  ok: boolean;
  status: number | null;
  /** Unix ms it took, measured from the moment the request was made. */
  ms: number;
  /** The object's ETag, when the bucket exposed one. It is the one value that
   *  proves the WRITE happened rather than the request merely being answered. */
  etag?: string | null;
  error?: string;
}

const PROBE_TIMEOUT_MS = 20_000;

/**
 * A deadline that a state machine can be sure of, hand-rolled for the same reason
 * the upload uses one: `AbortSignal.timeout` is Chrome 103 and `AbortSignal.any`
 * is Chrome 116, and the devices this whole path exists for are older than that —
 * on them either call is a TypeError that would make the probe itself the failure.
 */
function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();

  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Can this device reach that host AT ALL?
 *
 * `HEAD` in `no-cors` mode, and `no-store` so a cached answer cannot be mistaken
 * for a live one. The response is opaque and unreadable, which is the point: the
 * only outcome this reports is whether a request to the host completed or threw.
 */
export async function probeReachability(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ReachabilityProbe> {
  const startedAt = Date.now();
  const limit = deadline(timeoutMs);

  try {
    await fetch(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: limit.signal,
    });
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.name : "UnknownError",
    };
  } finally {
    limit.release();
  }
}

/**
 * Put a few bytes where the server just signed for them, exactly as the upload
 * would.
 *
 * The body is deliberately tiny: what is being tested is the handshake and the
 * permission, not the size of anything — and this runs on a metered phone
 * connection, possibly the one that is failing.
 */
export async function probeWrite(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<WriteProbe> {
  const startedAt = Date.now();
  const limit = deadline(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "PUT",
      // The same header the upload sends, which is what makes the browser run a
      // real preflight for this request — see the note at the top of the file.
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(1_024),
      cache: "no-store",
      signal: limit.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - startedAt,
      etag: response.headers.get("ETag"),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.name : "UnknownError",
    };
  } finally {
    limit.release();
  }
}

/** The host of a URL, for a probe that must hit the same server the upload does. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return null;
  }
}

/**
 * What the two probes mean together, in one sentence a creator can act on.
 *
 * Order matters: an unreachable host explains the write probe's failure, so the
 * network is reported first and the write refusal is not offered as a second,
 * contradictory cause.
 */
export function describeProbePair(
  reach: ReachabilityProbe | null,
  write: WriteProbe | null,
  what: string
): string {
  if (reach && !reach.ok) {
    return `This device's network could not reach the ${what} at all (${reach.error ?? "no answer"} after ${reach.ms} ms), so nothing was learned about the file or the permission. Move to another connection — Wi-Fi, or mobile data if you are on Wi-Fi — and try again.`;
  }

  if (!write) {
    // Reachability alone. Saying "it accepts a write" here would be a claim the
    // probe did not test — and this sentence lands in a failure record, where a
    // wrong one costs somebody an afternoon.
    //
    // AND IT USED TO NOMINATE A CAUSE ANYWAY: "most likely the bucket's CORS
    // policy, which has to name this exact page address". Seen live on
    // 2026-09-29, in a failure record whose page origin the bucket DOES allow —
    // read back from the bucket itself, and confirmed with a real signed PUT —
    // which means the sentence sent the reader to change a policy that was
    // already correct while the real cause was still one of three. What this
    // probe observed is a name resolving and a socket opening; a GET to the
    // host's root and a PUT to an object key are not the same permission, and a
    // carrier that allows the first and kills the second looks exactly like this.
    return `The ${what} is reachable from this device, so the browser did not fail at the network. That is all a reachability check can say — the bucket's CORS policy, a phone or carrier that allows a read and refuses a write, and a signature the bucket rejects all look identical from here — so run the network check on this phone (/creator/upload-check): it makes the same signed write from the device and says which one it is.`;
  }

  if (!write.ok) {
    if (write.status === null) {
      return `The ${what} was reachable, and the request was refused before it was sent (${write.error ?? "TypeError"} after ${write.ms} ms) — the bucket's CORS policy does not name this page's address, or it answered without the headers the browser needs.`;
    }
    return `The ${what} answered HTTP ${write.status} for a request signed for this page, so the upload was refused by the storage service and not by the connection.`;
  }

  return `The ${what} is reachable and accepts a signed write from this browser.`;
}

/** The same pair, folded into a failure record's own field, so /admin says which
 *  of the four failures it was without anybody reproducing it on a phone. */
export async function describeUploadReachability(partUrl: string): Promise<string> {
  const host = hostOf(partUrl);
  if (!host) return "could not read the storage host from the signed URL";

  const reach = await probeReachability(host);
  return describeProbePair(reach, null, "storage host");
}
