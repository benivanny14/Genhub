// =============================================================================
// GENHUB - Bounded request bodies
// =============================================================================
// `await request.json()` buffers the ENTIRE request body into memory before it
// looks at a single byte of it. A route handler has no built-in size limit in
// the App Router, so a 500 MB POST to any endpoint that parses JSON is a
// one-request way to exhaust the function's memory. The endpoints that accept a
// JSON body are exactly the ones a stranger can reach.
//
// This helper is the limit those routes were missing. Its shape is deliberately
// the same as the call it replaces — it returns the parsed body, or the fallback
// the caller already wrote — so switching a route over does not change how that
// route treats a well-formed request. What it adds is the ceiling:
//
//   1. `Content-Length`, when the client sends it, is checked FIRST. It is a
//      header, not a read, so a declared oversized upload is refused before the
//      first chunk is pulled off the socket.
//   2. When there is no length (a chunked upload), the stream is read with a
//      running total and abandoned the moment it passes the cap, so at most one
//      chunk past the limit is ever held.
//
// A body over the limit reads, to the route, exactly like a body it could not
// parse — the fallback — which every caller already handles. The important part
// is that the bytes are never buffered.
// =============================================================================

/** The default ceiling for a JSON API body. Generous; JSON APIs are small. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/** A slightly larger ceiling for the payment webhook, whose envelope can grow. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Read and parse a JSON request body, refusing anything larger than `maxBytes`.
 *
 * Never throws: a body that is too large, malformed, or unreadable yields the
 * `fallback`, which is the same value the `.catch(() => …)` it replaces produced.
 *
 * The return type is deliberately `any`, exactly like `request.json()`: this is
 * a drop-in for that call, and a route that used to reach into the parsed body
 * without a cast must keep doing so. The contract it tightens is the SIZE, not
 * the typing.
 *
 * @param request  The inbound request.
 * @param fallback What to return when the body is absent, malformed or oversized.
 * @param maxBytes The ceiling, in bytes. Defaults to MAX_JSON_BODY_BYTES.
 */
export async function readJsonBody(
  request: Request,
  fallback: unknown = null,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<any> {
  // Cheap path: a declared length over the cap is refused without reading.
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fallback;
  }

  let text: string;
  try {
    text = await readTextCapped(request, maxBytes);
  } catch {
    return fallback;
  }

  if (!text.trim()) return fallback;

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Read a request body as text, giving up once it passes `maxBytes`.
 *
 * When there is no readable stream (a body already consumed, or a runtime that
 * does not expose one), it falls back to `text()` — which cannot enforce the cap
 * itself, but the Content-Length check above has usually already done so.
 */
async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) {
    return await request.text();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > maxBytes) {
      // Stop pulling bytes the moment the cap is passed. There is nothing here
      // worth returning, and draining the rest is the exact cost we are avoiding.
      try {
        await reader.cancel();
      } catch {
        // A cancel that fails is not worth surfacing — we are already refusing.
      }
      throw new Error("request body exceeds the configured limit");
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();

  return out;
}
