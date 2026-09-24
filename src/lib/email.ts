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
