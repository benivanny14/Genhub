// =============================================================================
// GENHUB - Transactional email (SMTP via nodemailer)
// Password reset, welcome and other one-off emails.
//
// Configuration (all optional in dev):
//   SMTP_HOST   e.g. smtp.resend.com, smtp.gmail.com, smtp.mailgun.org
//   SMTP_PORT   default 587 (STARTTLS)
//   SMTP_USER   SMTP username
//   SMTP_PASS   SMTP password / app password
//   EMAIL_FROM   default "Genhub <no-reply@yourdomain>"
//
// Without SMTP_* the mailer runs in "console" transport: the full message is
// logged to the server console instead of being sent (dev/test behaviour).
// Every call reports which transport it used so callers can log misconfigures
// without ever failing the user-facing request.
// =============================================================================

import nodemailer, { type Transporter } from "nodemailer";
import config from "./config";
import { isCredentialFailure, reportCredentialFault } from "./credential-alert";

export interface MailResult {
  sent: boolean;
  transport: "smtp" | "console";
}

interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const from = () => process.env.EMAIL_FROM || "Genhub <no-reply@genhub.local>";
const isSmtpConfigured = () => Boolean(process.env.SMTP_HOST);

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      // Bounded, like every other external call on a request path. nodemailer's
      // defaults are the OS-level socket timeouts — minutes — so a mail host
      // that accepts the connection and then stalls would hold the
      // registration or password-reset request open until the function is
      // killed. `sendMail` already treats delivery as best-effort (a failure is
      // logged, never thrown), so giving up early costs a log line, not a send,
      // while waiting costs the whole request.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

/**
 * Send an email. Never throws — callers must not fail user requests because
 * of mail delivery. Returns which transport was used.
 */
export async function sendMail(options: SendMailOptions): Promise<MailResult> {
  if (!isSmtpConfigured()) {
    console.log(
      `[Email:console] -> ${options.to} | ${options.subject}\n${options.text}`
    );
    return { sent: true, transport: "console" };
  }

  try {
    await getTransporter().sendMail({ from: from(), ...options });
    return { sent: true, transport: "smtp" };
  } catch (error) {
    console.error(
      "[Email:smtp] send failed:",
      error instanceof Error ? error.message : error
    );
    // Only an auth or connection code. A single rejected address is a typo in a
    // signup form, not a rotated SMTP password, and reporting it as one would
    // teach whoever reads the alerts to stop reading them.
    if (isCredentialFailure(error)) {
      void reportCredentialFault({
        service: "SMTP",
        detail:
          `${config.email.host} refused the send (${(error as { code?: string })?.code}) ` +
          "— password resets and welcome emails are only reaching the server log",
      });
    }
    // Fall back to console so the link still reaches a developer log
    console.log(
      `[Email:console:fallback] -> ${options.to} | ${options.subject}\n${options.text}`
    );
    return { sent: false, transport: "console" };
  }
}

// -----------------------------------------------------------------------------
// Password reset
// -----------------------------------------------------------------------------

const brandHtml = (body: string) => `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#0b0b14;padding:32px">
    <div style="max-width:520px;margin:auto;background:#15151f;border:1px solid #2a2a3d;border-radius:16px;padding:32px">
      <div style="font-size:24px;font-weight:bold;color:#a78bfa;margin-bottom:16px">Genhub</div>
      ${body}
      <p style="color:#6b7280;font-size:12px;margin-top:24px">
        This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  </div>`;

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<MailResult> {
  return sendMail({
    to: email,
    subject: "Reset your Genhub password",
    text: `Someone requested a password reset for your Genhub account.\n\nReset your password (valid 1 hour):\n${resetUrl}\n\nIf this wasn't you, ignore this email — your password stays unchanged.`,
    html: brandHtml(`
      <p style="color:#d1d5db;font-size:15px;line-height:1.6">
        Someone requested a password reset for your Genhub account.
      </p>
      <p style="text-align:center;margin:28px 0">
        <a href="${resetUrl}"
           style="background:#7c3aed;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold">
          Reset Password
        </a>
      </p>
      <p style="color:#9ca3af;font-size:13px">Or paste this link into your browser:</p>
      <p style="color:#a78bfa;font-size:13px;word-break:break-all">${resetUrl}</p>
    `),
  });
}

// -----------------------------------------------------------------------------
// Weekly earnings digest (sent by the earnings-digest cron worker)
// -----------------------------------------------------------------------------

export interface EarningsDigestParams {
  to: string;
  displayName: string;
  /** Creator cut that finished its holding period in the last seven days. */
  clearedThisWeek: number;
  /** Still inside the holding window. */
  pending: number;
  /** Withdrawable right now. */
  available: number;
  holdingDays: number;
  /** ISO date the oldest held earning clears. Null when nothing is held. */
  nextReleaseAt: string | null;
  /** The withdrawal floor, quoted so the number matches what the app enforces. */
  minWithdrawal: number;
}

const tzs = (amount: number) => `TZS ${amount.toLocaleString("en-US")}`;

/**
 * A Monday-morning summary, not a receipt: what cleared, what is still held and
 * when it unlocks. The 14-day rule is spelled out in the body because this email
 * is the one place a creator reads it without opening the dashboard.
 */
export async function sendEarningsDigestEmail(
  params: EarningsDigestParams
): Promise<MailResult> {
  const home = config.appUrl;
  const where =
    params.clearedThisWeek > 0 ? "cleared" : params.available > 0 ? "available" : "held";
  const headline =
    where === "cleared"
      ? `${tzs(params.clearedThisWeek)} just cleared`
      : where === "available"
        ? `${tzs(params.available)} ready to withdraw`
        : `${tzs(params.pending)} on its way`;

  const nextLine = params.nextReleaseAt
    ? `Next release: ${new Date(params.nextReleaseAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}`
    : "Next release: nothing is being held right now";

  const text = [
    `${params.displayName || "Creator"}, here is your week on Genhub.`,
    "",
    `Cleared the 14-day hold this week: ${tzs(params.clearedThisWeek)}`,
    `Available to withdraw: ${tzs(params.available)}`,
    `Still held (pending): ${tzs(params.pending)}`,
    nextLine,
    "",
    `Every sale is held ${params.holdingDays} days from the day it is paid, so money keeps unlocking as those windows close. Withdrawals do not wait ${params.holdingDays} days — you can withdraw any available balance once it reaches ${tzs(params.minWithdrawal)}.`,
    "",
    `Open your dashboard: ${home}/creator`,
  ].join("\n");

  return sendMail({
    to: params.to,
    subject: `Genhub earnings: ${headline}`,
    text,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#0b0b14;padding:32px">
        <div style="max-width:520px;margin:auto;background:#15151f;border:1px solid #2a2a3d;border-radius:16px;padding:32px">
          <div style="font-size:24px;font-weight:bold;color:#a78bfa;margin-bottom:16px">Genhub</div>
          <p style="color:#d1d5db;font-size:15px;line-height:1.6">
            ${params.displayName ? `${params.displayName}, ` : ""}here is your week on Genhub.
          </p>
          <p style="color:#e5e7eb;font-size:18px;font-weight:bold;margin:20px 0">${headline}</p>
          <table style="width:100%;border-collapse:collapse;color:#d1d5db;font-size:14px">
            <tr><td style="padding:6px 0">Cleared the ${params.holdingDays}-day hold this week</td><td style="padding:6px 0;text-align:right;color:#34d399;font-weight:bold">${tzs(params.clearedThisWeek)}</td></tr>
            <tr><td style="padding:6px 0">Available to withdraw</td><td style="padding:6px 0;text-align:right;color:#34d399;font-weight:bold">${tzs(params.available)}</td></tr>
            <tr><td style="padding:6px 0">Still held (pending)</td><td style="padding:6px 0;text-align:right;color:#fbbf24;font-weight:bold">${tzs(params.pending)}</td></tr>
          </table>
          <p style="color:#9ca3af;font-size:13px;margin-top:16px">${nextLine}</p>
          <p style="color:#9ca3af;font-size:13px;line-height:1.6">
            Every sale is held ${params.holdingDays} days from the day it is paid, so money keeps unlocking as those windows close.
            Withdrawals do not wait ${params.holdingDays} days — withdraw any available balance once it reaches ${tzs(params.minWithdrawal)}.
          </p>
          <p style="text-align:center;margin:28px 0">
            <a href="${home}/creator" style="background:#7c3aed;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold">
              Open your dashboard
            </a>
          </p>
        </div>
      </div>`,
  });
}

// -----------------------------------------------------------------------------
// Welcome (sent once after registration)
// -----------------------------------------------------------------------------

export async function sendWelcomeEmail(
  email: string,
  displayName: string
): Promise<MailResult> {
  // config.appUrl, not process.env: it also resolves the hosting provider's
  // own URL when NEXT_PUBLIC_APP_URL is unset, so reset links work in production.
  const home = config.appUrl;
  return sendMail({
    to: email,
    subject: `Welcome to Genhub${displayName ? `, ${displayName}` : ""}`,
    text: `Your Genhub account is ready.\n\nExplore: ${home}\n\nCreators earn 70% of every sale. Upgrade from your profile any time.`,
    html: brandHtml(`
      <p style="color:#d1d5db;font-size:15px;line-height:1.6">
        Your Genhub account is ready — jump in and start watching.
      </p>
      <p style="text-align:center;margin:28px 0">
        <a href="${home}"
           style="background:#7c3aed;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold">
          Open Genhub
        </a>
      </p>
      <p style="color:#9ca3af;font-size:13px">
        Creators earn 70% of every sale. Upgrade to Creator from your profile.
      </p>
    `),
  });
}
