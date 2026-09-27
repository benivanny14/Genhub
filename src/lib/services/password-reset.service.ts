// =============================================================================
// GENHUB - Issuing a password reset link
//
// One place issues a reset token, so the two callers that need one cannot drift:
//
//   * POST /api/auth/forgot-password — the account holder asking for it, and
//   * POST /api/admin/users { action: "SEND_RESET_LINK" } — an operator helping
//     somebody who cannot get in.
//
// -----------------------------------------------------------------------------
// Email is the ONLY delivery channel
// -----------------------------------------------------------------------------
// This flow used to send the link by SMS as well, for phone-only accounts. That
// was removed deliberately:
//
//   * SMS needs Africa's Talking to be configured and funded, and it was not —
//     so the SMS branch created a token, handed it to a console transport, and
//     the account holder was told to check a phone that would never buzz. A
//     recovery path that fails silently is worse than one that is absent,
//     because the person waits instead of asking for help.
//   * Two channels means two answers to "where is my link?", and a reset that
//     arrives by text is a link sitting in an SMS thread anyone holding the
//     phone can open.
//
// Registration now requires an email, so every account created from here on has
// somewhere to send this. The token is still stored only as a hash — see
// lib/token-hash.ts — and still lives for one hour.
// =============================================================================

import crypto from "node:crypto";
import prisma from "@/lib/db";
import config from "@/lib/config";
import { hashResetToken } from "@/lib/token-hash";

/** One hour, the same window the emailed link has always had. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export type ResetDelivery =
  | { delivered: true; to: string }
  /**
   * `NO_EMAIL_ON_FILE` is not an error the caller may report to the account
   * holder: saying "this account has no email" out loud would confirm the
   * account exists. It is for the log, and for the admin action, which is
   * looking at the row and already knows.
   */
  | { delivered: false; reason: "NO_SUCH_USER" | "NO_EMAIL_ON_FILE" };

/**
 * Issue a fresh reset token for one account and email the link.
 *
 * Outstanding tokens are retired before a new one is minted, so a second
 * request does not leave the first link working — otherwise every request the
 * account holder makes widens the window instead of narrowing it.
 */
export async function sendPasswordResetLink(userId: string): Promise<ResetDelivery> {
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!account) return { delivered: false, reason: "NO_SUCH_USER" };

  if (!account.email) {
    // Reachable only for an account that predates the email requirement. There
    // is nowhere to send this, and issuing a token nobody can receive would let
    // the screen say "sent" about nothing. Logged rather than thrown: the caller
    // must still answer identically, or the endpoint enumerates accounts.
    console.warn(
      `[Password Reset] user ${userId} has no email on file — nothing was sent. ` +
        "An admin can set one, or the account can be reset by hand."
    );
    return { delivered: false, reason: "NO_EMAIL_ON_FILE" };
  }

  await prisma.passwordReset.updateMany({
    where: { userId, used: false },
    data: { used: true },
  });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  // Only the hash is stored. The token itself travels in the email below and is
  // never readable from the database again.
  await prisma.passwordReset.create({
    data: { userId, token: hashResetToken(token), expiresAt },
  });

  const resetUrl = `${config.appUrl.replace(/\/$/, "")}/reset-password?token=${token}`;

  // sendMail never throws (console transport in dev, SMTP in production), so the
  // caller's response stays the same either way.
  const { sendPasswordResetEmail } = await import("@/lib/email");
  const result = await sendPasswordResetEmail(account.email, resetUrl);
  console.log(
    `[Password Reset] email user=${userId} transport=${result.transport} sent=${result.sent}`
  );

  return { delivered: true, to: account.email };
}
