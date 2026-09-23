// =============================================================================
// GENHUB - Payment notifications
// Fired once per charge when it reaches a final state (settled, failed, or
// "we cannot tell yet"), so the customer does not have to keep the payments
// page open to find out. Writes an in-app notification and, when we have an
// address, an email.
//
// UNDER_INVESTIGATION exists because a charge that never settles may already
// have taken the customer's money. Telling them "payment failed, try again" in
// that case is how someone pays twice for one purchase, so the wording is
// deliberately "do not pay again until we have checked".
//
// Never throws: a notification or mail failure must never undo or block a
// payment settlement.
// =============================================================================

import prisma from "../db";
import config from "../config";

const TYPE_LABELS: Record<string, string> = {
  PPV_PURCHASE: "Video purchase",
  SUBSCRIPTION: "Subscription",
  WALLET_TOPUP: "Wallet top-up",
  TIP: "Tip",
};

export type PaymentOutcome = "SUCCESS" | "FAILED" | "UNDER_INVESTIGATION";

export interface PaymentNoticeParams {
  transactionId: string;
  outcome: PaymentOutcome;
  /** Why it failed (gateway reason, or "expired" for an unanswered prompt). */
  reason?: string;
}

function formatTZS(amount: number): string {
  return `TZS ${amount.toLocaleString("en-US")}`;
}

export async function notifyPaymentResult(params: PaymentNoticeParams): Promise<void> {
  try {
    const { transactionId, outcome } = params;

    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        viewer: { select: { id: true, email: true, displayName: true } },
        video: { select: { id: true, title: true } },
        creator: { select: { id: true, displayName: true } },
      },
    });

    if (!tx) return;

    const label = TYPE_LABELS[tx.type] || tx.type;
    const detail =
      tx.video?.title || tx.creator?.displayName
        ? ` — ${tx.video?.title || tx.creator?.displayName}`
        : "";
    const amount = formatTZS(tx.amount);
    const succeeded = outcome === "SUCCESS";
    const investigating = outcome === "UNDER_INVESTIGATION";

    const link = tx.videoId
      ? `/video/${tx.videoId}`
      : tx.type === "WALLET_TOPUP"
        ? "/wallet"
        : "/payments";

    const failureDetail =
      params.reason === "expired"
        ? "The USSD prompt was never approved, so the charge expired. You can try again."
        : params.reason === "resolved_not_paid"
          ? "We checked with the network and the money did not move, so you can safely try again."
          : params.reason
            ? `The gateway said: ${params.reason}`
            : "The payment was not completed. You can try again.";

    const investigationDetail =
      "Your operator confirmed the request but we have not received the money yet, so we are checking with them. " +
      "**Please do not pay again** — if it turns out the money did leave your phone we will unlock your purchase, " +
      "and if it did not we will release the charge so you can retry.";

    await prisma.notification.create({
      data: {
        userId: tx.userId,
        title: succeeded
          ? "Payment successful ✅"
          : investigating
            ? "We are checking your payment ⏳"
            : "Payment failed",
        message: succeeded
          ? `${label}${detail} — ${amount} has been paid.`
          : investigating
            ? `${label}${detail} — ${amount}: ${investigationDetail}`
            : `${label}${detail} — ${amount} did not go through. ${failureDetail}`,
        type: succeeded ? "success" : investigating ? "warning" : "error",
        link: succeeded ? link : "/payments",
      },
    });

    if (tx.viewer.email) {
      // config.appUrl also resolves the hosting provider's own URL when
      // NEXT_PUBLIC_APP_URL is unset.
      const home = config.appUrl;
      const url = `${home}${succeeded ? link : "/payments"}`;
      const subject = succeeded
        ? `Payment received — ${label} (${amount})`
        : investigating
          ? `We are checking your payment — ${label} (${amount})`
          : `Payment failed — ${label} (${amount})`;
      const text = succeeded
        ? `Your ${label.toLowerCase()}${detail} of ${amount} was successful.\n\nView it here: ${url}\n`
        : investigating
          ? `Your ${label.toLowerCase()}${detail} of ${amount}: your operator confirmed the request but we have not received the money yet.\n\n${investigationDetail}\n\nStatus: ${url}\n`
          : `Your ${label.toLowerCase()}${detail} of ${amount} did not go through.\n\n${failureDetail}\n\nTry again: ${url}\n`;

      import("../email")
        .then(({ sendMail }) =>
          sendMail({
            to: tx.viewer.email!,
            subject,
            text,
            html: `
              <div style="font-family:Arial,Helvetica,sans-serif;background:#0b0b14;padding:32px">
                <div style="max-width:520px;margin:auto;background:#15151f;border:1px solid #2a2a3d;border-radius:16px;padding:32px">
                  <div style="font-size:24px;font-weight:bold;color:#a78bfa;margin-bottom:16px">Genhub</div>
                  <p style="color:#d1d5db;font-size:15px;line-height:1.6">
                    ${
                      succeeded
                        ? "Your payment was successful."
                        : investigating
                          ? "We are checking this payment with your mobile operator."
                          : "Your payment did not go through."
                    }
                  </p>
                  <p style="color:#9ca3af;font-size:14px">
                    ${label}${detail} · <strong style="color:#e5e7eb">${amount}</strong>
                  </p>
                  ${
                    succeeded
                      ? ""
                      : investigating
                        ? `<p style="color:#fbbf24;font-size:13px">${investigationDetail}</p>`
                        : `<p style="color:#f87171;font-size:13px">${failureDetail}</p>`
                  }
                  <p style="text-align:center;margin:28px 0">
                    <a href="${url}" style="background:#7c3aed;color:#fff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold">
                      ${succeeded ? "Open Genhub" : "Try again"}
                    </a>
                  </p>
                </div>
              </div>`,
          })
        )
        .catch((mailError) => console.error("[Payment Email Error]", mailError));
    }
  } catch (error) {
    console.error(
      "[Payment Notify Error]",
      error instanceof Error ? error.message : error
    );
  }
}
