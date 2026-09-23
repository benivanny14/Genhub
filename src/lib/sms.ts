// =============================================================================
// GENHUB - Transactional SMS (Africa's Talking)
// Phone-only accounts (very common in Tanzania) need SMS for password reset —
// without it those users can never recover their account.
//
// Configuration (all optional in dev):
//   AT_API_KEY      Africa's Talking API key
//   AT_USERNAME     Your Africa's Talking username (or "sandbox" for testing)
//   AT_SENDER_ID    Optional sender ID
//
// Without AT_API_KEY the library logs to the console (dev), mirroring the
// SMTP behaviour in lib/email.ts. sendSms never throws.
// =============================================================================

import config from "./config";

export interface SmsResult {
  sent: boolean;
  transport: "africastalking" | "console";
}

/**
 * Normalise Tanzanian local formats to international: 0712345678 /
 * 255712345678 -> +255712345678 (Africa's Talking requires E.164).
 */
export function normalizeSmsNumber(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0")) return `+255${digits.slice(1)}`;
  if (digits.startsWith("255")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const apiKey = process.env.AT_API_KEY || "";
  const username = process.env.AT_USERNAME || "Genhub";
  const recipient = normalizeSmsNumber(to);

  if (!apiKey) {
    console.log(`[SMS:console] -> ${recipient} | ${message}`);
    return { sent: true, transport: "console" };
  }

  try {
    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        username,
        to: recipient,
        message,
        ...(process.env.AT_SENDER_ID ? { from: process.env.AT_SENDER_ID } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      SMSMessageData?: {
        Recipients?: Array<{ status?: string; statusCode?: number }>;
      };
    };

    if (!res.ok) {
      throw new Error(`Africa's Talking HTTP ${res.status}`);
    }
    const first = data.SMSMessageData?.Recipients?.[0];
    if (first && /fail|reject/i.test(first.status || "")) {
      throw new Error(`recipient status: ${first.status}`);
    }

    return { sent: true, transport: "africastalking" };
  } catch (error) {
    console.error(
      "[SMS] send failed:",
      error instanceof Error ? error.message : error
    );
    console.log(`[SMS:console:fallback] -> ${recipient} | ${message}`);
    return { sent: false, transport: "console" };
  }
}

// -----------------------------------------------------------------------------
// Password reset (same one-hour token link as the email flow)
// -----------------------------------------------------------------------------

export async function sendPasswordResetSms(
  phone: string,
  resetUrl: string
): Promise<SmsResult> {
  return sendSms(
    phone,
    `Genhub: reset your password (valid 1 hour): ${resetUrl}`
  );
}

// -----------------------------------------------------------------------------
// Welcome
// -----------------------------------------------------------------------------

export async function sendWelcomeSms(
  phone: string,
  displayName?: string
): Promise<SmsResult> {
  // config.appUrl also resolves the hosting provider's own URL when
  // NEXT_PUBLIC_APP_URL is unset.
  const home = config.appUrl;
  return sendSms(
    phone,
    `Genhub${displayName ? `, ${displayName}` : ""}: your account is ready. Start watching: ${home}`
  );
}
