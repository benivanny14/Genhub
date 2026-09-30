// =============================================================================
// GENHUB - API Response Helpers
// Standardized JSON responses for Next.js API routes
// =============================================================================
// Every response a client receives passes through this file, so this is where
// the "what is a user allowed to learn" rule lives rather than in ninety routes:
//
//   1. A 5xx never carries our internals. `api.internal()` and `api.upstream()`
//      answer with one plain sentence and a short correlation REFERENCE. The
//      real story — which provider refused, which variable is wrong, which host
//      answered what, the raw error object — goes to the server log on the same
//      line as that reference. A viewer can then read "Reference: 4KQ7Z2MP" off
//      their screen, and whoever runs the deployment can find the whole diagnosis
//      in the log without ever showing it to the public.
//   2. The reference is the only internal-looking thing a user sees, and it is
//      deliberately short and readable: no path, no hostname, no version, no
//      package name, no environment, no error code from a provider.
//
// What must NEVER be sent from here: stack traces, file paths, Prisma/SQL text,
// table or column names, Redis/SMTP/SMS messages, provider names, CDN hostnames,
// environment-variable names, deployment or build identifiers, raw upstream
// response bodies, or the message of an unexpected error. Those belong in logs.
//
// 4xx is different on purpose: a validation message is part of the product
// ("Your new password must be at least 8 characters"), and those callers pass
// their own text. What is pinned here is that 5xx text is ours, not theirs.
// =============================================================================

import { NextResponse } from "next/server";

interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  /** Short, safe, public handle that ties this answer to one server log line. */
  reference?: string;
}

/**
 * The alphabet a reference is written in, with I/L/O/U removed.
 *
 * A reference gets read aloud on a support call and copied off a screenshot, so
 * `1`/`I`/`l` and `0`/`O` must not be confusable and a reference must never look
 * like a word. 32 symbols exactly, which is what keeps the modulo below unbiased.
 */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The public message a 5xx answers with. Deliberately about the user, not us. */
export const GENERIC_SERVER_ERROR = "Something went wrong. Please try again.";

/**
 * A fresh correlation reference.
 *
 * `globalThis.crypto` rather than `node:crypto`: it exists in the Node runtime
 * AND the edge runtime, so a route can move between them without taking this
 * with it. Eight symbols is ~1.1e12 values — a collision inside one log window
 * is not a thing an operator will meet, and a shorter handle stays readable.
 */
export function newReference(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += REFERENCE_ALPHABET[bytes[i] % REFERENCE_ALPHABET.length];
  }
  return out;
}

// Standard success response
export function apiSuccess<T>(data: T, message?: string, status: number = 200): NextResponse {
  const body: SuccessResponse<T> = {
    success: true,
    data,
  };
  if (message) body.message = message;
  return NextResponse.json(body, { status });
}

/**
 * The same, for a payload that belongs to one signed-in account.
 *
 * `no-store` on the response itself is what stops a shared CDN or a phone's HTTP
 * cache from handing one fan's wallet, inbox or watch history to the next person
 * on the same connection. Route handlers that read cookies are dynamic already,
 * but dynamic is a rendering decision — this is a caching one, and the two do not
 * imply each other.
 */
export function apiPrivateSuccess<T>(data: T, message?: string): NextResponse {
  const body: SuccessResponse<T> = { success: true, data };
  if (message) body.message = message;
  return NextResponse.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

// Standard error response
export function apiError(
  error: string,
  status: number = 400,
  code?: string,
  reference?: string
): NextResponse {
  const body: ErrorResponse = {
    success: false,
    error,
  };
  if (code) body.code = code;
  if (reference) body.reference = reference;
  // Errors are never cacheable: a 403 or a 429 cached at the edge would be
  // replayed to the next visitor, and a cached 404 keeps answering after the
  // thing it denied exists again.
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

/**
 * Log a failure for the server and answer the client with a plain sentence.
 *
 * This is the ONE place a 5xx is built, so the two halves cannot drift: the
 * reference in the log line is the reference on the screen. `detail` may be as
 * internal as it needs to be — it is only ever written to the log.
 *
 * @param detail   Everything we know, for the operator. Never sent.
 * @param context  A short bracketed label for the log, e.g. "Payments".
 * @param status   HTTP status (default 500 — ours); pass 502/504 for upstreams.
 * @param message  What the user reads, when a plainer sentence exists for their
 *                 situation ("We could not start the payment. Nothing was
 *                 charged."). Anything not passed here uses the generic one.
 */
export function serverFailure(
  detail: unknown,
  context: string,
  status: number = 500,
  code: string = "INTERNAL_ERROR",
  message: string = GENERIC_SERVER_ERROR
): NextResponse {
  const reference = newReference();
  // The log line is the ONLY place the detail appears, and it always carries the
  // reference, so a report of "Reference: XXXX" is one grep away from the cause.
  console.error(`[${context}] reference=${reference}`, detail);
  return apiError(message, status, code, reference);
}

// Common error responses
export const api = {
  success: apiSuccess,
  privateSuccess: apiPrivateSuccess,
  error: apiError,
  unauthorized: (msg = "You are not authorized to perform this action") =>
    apiError(msg, 401, "UNAUTHORIZED"),
  forbidden: (msg = "You are not authorized to perform this action") =>
    apiError(msg, 403, "FORBIDDEN"),
  notFound: (msg = "Resource not found") =>
    apiError(msg, 404, "NOT_FOUND"),
  validation: (msg: string) =>
    apiError(msg, 422, "VALIDATION_ERROR"),
  rateLimited: (msg = "Too many requests — please wait a moment") =>
    apiError(msg, 429, "RATE_LIMITED"),
  /**
   * A 5xx. Anything passed in is treated as a DIAGNOSTIC and logged, never sent:
   * a caller that used to hand a Prisma message or a provider body straight to
   * the client now gets the generic sentence plus a reference instead, and the
   * detail still lands in the log where it is useful.
   */
  internal: (diagnostic?: string) => {
    if (diagnostic && /[^\s]/.test(diagnostic)) {
      // Named as a diagnostic in the log, so nobody reads it as user-facing text.
      return serverFailure(`internal diagnostic: ${diagnostic}`, "API");
    }
    return serverFailure("unhandled internal error", "API");
  },
  /**
   * A 5xx caused by something outside this app: a payment gateway, the CDN, a
   * mail or SMS provider, a database that is not ours to fix from here.
   *
   * The detail names the provider and the variable for the operator's log; the
   * user gets `message`. Callers with a more useful sentence for their situation
   * pass it — "We could not start the payment. Nothing was charged." — because a
   * generic sentence on a money screen is its own kind of unhelpful.
   */
  upstream: (
    detail: string,
    options: {
      context: string;
      status?: number;
      code?: string;
      message?: string;
    }
  ) =>
    serverFailure(
      detail,
      options.context,
      options.status ?? 502,
      options.code ?? "UPSTREAM_ERROR",
      options.message ?? GENERIC_SERVER_ERROR
    ),
};
