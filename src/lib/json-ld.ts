// =============================================================================
// GENHUB - Structured data that cannot break out of its own <script> tag
//
// Every page ships JSON-LD for search engines, and the values in it are written
// by users: a video title, a video description, a creator's display name. The
// tag is rendered with `dangerouslySetInnerHTML`, which is fine and normal for
// JSON-LD — what is not fine is that `JSON.stringify` does not escape `<`.
//
// The HTML parser ends a `<script>` element at the first `</script` it sees, and
// the JSON string is inside the element, not inside a JS string literal. So a
// title of
//
//   </script><script>fetch('/api/wallet/withdraw', {method:'POST', ...})</script>
//
// closes our tag and opens a script of the attacker's own, with our origin and
// our visitor's session. The page-level CSP allows inline scripts (Next.js ships
// its hydration payload as one), so nothing else stands in the way.
//
// That was demonstrated, not theorised: the same markup in a browser ran the
// injected script and set a global. A creator — any creator, and sign-up is
// open — could have run code in the browser of every visitor of their video
// page, and in an admin's browser when an admin opened the video.
//
// The fix is to never emit a raw `<` (or `>`, `&`, or the line separators) from a
// JSON-LD string. `\u003c` is the same character to a JSON parser and a
// completely uninteresting byte to the HTML parser, so the data survives and the
// escape route does not. This is the standard treatment for JSON embedded in
// HTML; the alternative — trusting every field that reaches a template — is the
// bug that was just found.
// =============================================================================

/** Characters that must not appear raw inside a `<script>` element. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    // Valid in JSON, but not in JavaScript source before ES2019 — and a lone
    // U+2028 inside an inline script is a syntax error that would blank the tag.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
