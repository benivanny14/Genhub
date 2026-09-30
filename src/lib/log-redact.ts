// =============================================================================
// GENHUB - What a log line is allowed to contain
// =============================================================================
// Server logs are the one place a failure may be described in full: which
// provider refused, which variable is wrong, the raw error. That is deliberate —
// see lib/api-response.ts, where the log line carries the reference the user is
// shown. But "in full" is about the FAULT, not about the secrets that happen to
// be in scope when it happens: an error object from a database client can carry
// the parameters of the statement it ran (an email, a reset token), and a
// request being logged for diagnosis can carry a cookie or an Authorization
// header. Logs are copied, shipped to a hosting provider's viewer, pasted into
// chats and kept for months; a token written once is a token leaked.
//
// So every value that goes to a log through here is put through the same two
// questions:
//
//   1. Is this a credential? (a JWT, a bearer token, a `?token=` query value,
//      user:password in a URL, a Cookie/Authorization header, a long opaque
//      secret) -> replace the value, keep the SHAPE, so the line still reads.
//   2. Is this personal data? (an email address, a phone number) -> keep enough
//      to correlate two log lines about the same person and nothing more.
//
// Everything else survives untouched on purpose. Redacting indiscriminately
// (order ids, statuses, hostnames, stack frames) would make the log useless for
// the one job it has, and a useless log is how a real incident gets missed.
//
// Pure and synchronous: it runs on the request path next to a failure.
// =============================================================================

/** What replaces a value that must not be written down. */
export const REDACTED = "[redacted]";

/** A JWT is three base64url segments separated by dots. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * `Bearer <token>`, `token=<token>` and `token: <token>`, as they appear in
 * headers, query strings and provider messages.
 *
 * The separator is required (`=`, `:` or whitespace) — "token" on its own is an
 * ordinary English word and must not swallow the sentence after it.
 */
const BEARER = /\b(bearer|token)\b\s*(?:[=:]\s*|\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

/** A query-string value under a name that means "credential". */
const SECRET_QUERY =
  /([?&](?:token|secret|password|passwd|key|api[_-]?key|access[_-]?token|refresh[_-]?token|signature|sig|auth|code|t)=)[^&\s"'\\]+/gi;

/** `scheme://user:password@host` — the credentials in front of a host. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^:@/\s]+:[^@/\s]+@/gi;

/** Whole header lines that are nothing but credentials. */
const CREDENTIAL_HEADER = /\b(cookie|set-cookie|authorization|x-cron-secret|x-api-key)\b\s*:\s*[^\n,;]+/gi;

/** A long hex or base64url run: a key, a hash, a session id, a signature. */
const OPAQUE_SECRET = /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/=-]{40,})\b/g;

/** An email address: keep the first character and the domain. */
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * A Tanzanian phone number as it is stored or dialled: `+255682642219`,
 * `0682642219`, or the same with spaces.
 *
 * Kept at three leading digits and the last three, which is what an operator
 * needs to match a customer's screenshot to a row without the log holding a
 * number that can be dialled.
 */
const PHONE = /(\+?255|0)(\d{2})[\s-]?(\d{3})[\s-]?(\d{3})/g;

/** The names whose VALUES are never logged, whatever the value looks like. */
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|authorization|cookie|signature|private)/i;

/**
 * Mask every credential and personal identifier in a string.
 *
 * Order matters: the header rule runs before the opaque-secret rule, so a value
 * after `Authorization:` is replaced once, with the reason it was replaced,
 * rather than twice.
 */
export function redactText(input: string): string {
  return input
    .replace(CREDENTIAL_HEADER, (match, name: string) => `${name}: ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(JWT, REDACTED)
    .replace(SECRET_QUERY, `$1${REDACTED}`)
    .replace(BEARER, (match, name: string) => `${name} ${REDACTED}`)
    .replace(OPAQUE_SECRET, REDACTED)
    .replace(EMAIL, `$1***$2`)
    .replace(PHONE, (match, prefix: string, region: string, block: string) => {
      void block;
      return `${prefix}${region}*****`;
    });
}

/**
 * An error, ready to be written to a log.
 *
 * The name and the STACK are kept — a stack is what makes a server log worth
 * having, and it names our own files, not a secret. The message is redacted,
 * because that is where a database client puts the parameters of the statement
 * that failed.
 */
export function safeErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack : "";
    // Redacted as ONE string, after assembly, because a stack's first line
    // repeats the message verbatim — redacting the message and then appending the
    // raw stack would publish the very value this function exists to remove.
    // (Found by the test for exactly that: `Error: … value [redacted]` followed by
    // the same line with the token intact.)
    return redactText(`${error.name}: ${error.message}${stack ? `\n${stack}` : ""}`);
  }
  if (typeof error === "string") return redactText(error);
  try {
    return redactText(JSON.stringify(error) ?? String(error));
  } catch {
    return REDACTED;
  }
}

/**
 * Put every `console.error`/`console.warn` argument through the rules above.
 *
 * Called once per server process from instrumentation.ts. The reason it is the
 * SINK rather than ninety call sites: `console.error("[X Error]", error)` is the
 * house pattern in this codebase, and an error object is exactly where a database
 * client keeps the parameters of the statement it ran. Redacting at the sink
 * means a route written next month is covered by default, which is the only kind
 * of log hygiene that survives a codebase growing.
 *
 * Only `error` and `warn` are wrapped. Those are where failures are written;
 * wrapping `log`/`info` would rewrite framework output for no gain, and Next's
 * own messages are not ours to redact.
 *
 * Idempotent, so a double `register()` cannot stack two layers of wrapping over
 * the same call.
 */
export function installLogRedaction(): void {
  if (installed) return;
  installed = true;

  for (const method of ["error", "warn"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      try {
        original(...args.map((argument) => redactLogValue(argument)));
      } catch {
        // Redaction must never be the reason a log line is lost.
        original(...args);
      }
    };
  }
}

/** Set once per process — see installLogRedaction. */
let installed = false;

/**
 * A value, ready to be written to a log: secrets by NAME are dropped, and every
 * string inside is put through `redactText`.
 *
 * Depth- and width-bounded, because this runs while something is already going
 * wrong and a cyclic or enormous object must not become the incident.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return safeErrorForLog(value);
  if (typeof value !== "object") return String(value);

  if (depth >= 3) return "[depth limit]";

  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => redactLogValue(item, depth + 1));
    return value.length > 20 ? [...head, `…${value.length - 20} more`] : head;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactLogValue(inner, depth + 1);
  }
  return out;
}
