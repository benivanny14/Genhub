// =============================================================================
// GENHUB - Storing a one-shot secret without storing the secret
//
// A password-reset token was written to the database exactly as it was emailed.
// That makes a database dump — a leaked backup, a screenshot of the table, an
// over-broad support query — into a set of working account-takeover links, and
// nothing downstream would look wrong: every token in the table is a valid one.
//
// So the row now holds sha256(token) and the token itself exists only in the
// message we sent. A dump yields hashes that cannot be replayed.
//
// SHA-256 rather than bcrypt: this is a 256-bit random value that we generated,
// not a password a human chose. There is no dictionary to try and no low-entropy
// input to stretch, so the only property that matters is that the stored value
// cannot be turned back into the token — which a hash gives, and which a slow
// KDF would only add latency to.
//
// The lookup stays a single indexed equality match on a unique column, because
// the client presents the token and we hash it before searching. Hashing per row
// (the way bcrypt forces) would mean scanning every outstanding reset.
// =============================================================================

import { createHash } from "node:crypto";

/** The value stored in `PasswordReset.token`. Never the token itself. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
