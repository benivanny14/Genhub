// =============================================================================
// GENHUB - Process startup hooks
//
// Next calls `register()` once per server process, before any request is
// handled. The one thing this app needs there is the log sink: every
// `console.error` / `console.warn` argument is put through lib/log-redact, so a
// token, a cookie, an email or a phone number that happens to be inside an error
// object cannot be written down verbatim — by a route that exists today or one
// written next month.
//
// Nothing else belongs here: startup is a bad place for work that can fail, and
// a throw in `register()` is a deployment that never answers.
// =============================================================================

export async function register(): Promise<void> {
  const { installLogRedaction } = await import("./lib/log-redact");
  installLogRedaction();
}
