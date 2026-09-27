// =============================================================================
// GENHUB - Support tickets
// POST /api/support
//
// The support form used to have no backend at all: it built a `mailto:` link and
// navigated to it. That works only if the visitor's machine has a mail client
// registered — and on a phone it opened the Gmail composer with the ticket in a
// draft the person still had to send themselves. Nothing recorded that a message
// had been attempted, so a ticket that never left the browser was
// indistinguishable from one that arrived.
//
// This route is the delivery. A ticket goes out on TWO channels on purpose:
//
//   * an email to the support address, which is where somebody answers it, and
//   * a notification to every ADMIN, which survives a mail host that is down or
//     not configured.
//
// Either one landing means the message is not lost. The response reports failure
// only when BOTH do, so the visitor is never told "sent" about a ticket that
// went nowhere — the misreporting that made the old form untrustworthy.
//
// Signed-out tickets are accepted, because the people who most need support are
// the ones who cannot log in. They must leave an address to reply to; a
// signed-in ticket carries the account instead.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import { clientIp } from "@/lib/utils";
import config from "@/lib/config";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

const supportSchema = z.object({
  topic: z.string().trim().min(2).max(60),
  subject: z.string().trim().min(3, "Give the ticket a subject").max(200),
  message: z.string().trim().min(10, "Describe the issue in a sentence or two").max(4000),
  // Required only when there is no session; see the route body.
  email: z
    .union([z.string().trim().email("Enter a valid email address"), z.literal("")])
    .optional(),
});

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function POST(request: NextRequest) {
  try {
    // Keyed on the IP: a signed-out visitor is exactly who this route exists for,
    // so there is no account to key on. Five an hour is generous for a person and
    // useless for a script.
    const ip = clientIp(request.headers);
    const { allowed } = await checkRateLimit(`support:${ip}`, 5, 60 * 60_000);
    if (!allowed) {
      return api.rateLimited("You have sent several tickets already — we will reply to those.");
    }

    const body = await request.json().catch(() => ({}));
    const parsed = supportSchema.safeParse(body);
    if (!parsed.success) return api.validation(parsed.error.errors[0].message);

    const { topic, subject, message } = parsed.data;
    const session = await getCurrentUser();

    let account: { id: string; email: string | null; displayName: string | null; role: string } | null =
      null;
    if (session) {
      account = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, displayName: true, role: true },
      });
    }

    const replyTo = (account?.email || parsed.data.email || "").trim();
    if (!replyTo) {
      return api.validation(
        "Leave an email address so support can reply — you are not signed in."
      );
    }

    const who = account
      ? `${account.displayName || "Account"} <${replyTo}> (${account.role}, id ${account.id})`
      : `${replyTo} (not signed in)`;

    // 1. Email, which is where it gets answered.
    const { sendMail } = await import("@/lib/email");
    const mail = await sendMail({
      to: config.compliance.supportEmail,
      replyTo,
      subject: `[Genhub support] ${topic} — ${subject}`,
      text:
        `Topic: ${topic}\nFrom: ${who}\n\n${message}\n\n` +
        `— Reply to this email to answer ${replyTo} directly.`,
      html:
        `<p><strong>Topic:</strong> ${escapeHtml(topic)}</p>` +
        `<p><strong>From:</strong> ${escapeHtml(who)}</p>` +
        `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
    });

    // `transport: "console"` means there is no SMTP host and the message only
    // reached the server log. That is a developer convenience, not a delivered
    // ticket, so it does not count as delivery — otherwise a deployment with no
    // mail configured would report success for every ticket.
    const emailed = mail.sent && mail.transport === "smtp";

    // 2. The admin bell, which does not depend on the mail host.
    let notified = 0;
    try {
      const admins = await prisma.user.findMany({
        where: { role: "ADMIN", isBanned: false },
        select: { id: true },
      });
      if (admins.length > 0) {
        await prisma.notification.createMany({
          data: admins.map((admin) => ({
            userId: admin.id,
            title: `Support ticket — ${topic}`,
            message: `${subject}\n\nFrom ${who}:\n${message.slice(0, 400)}`,
            type: "info",
            link: "/admin",
          })),
        });
        notified = admins.length;
      }
    } catch (error) {
      // A ticket that could not be filed is still worth an email; say so in the
      // log rather than failing the request on the second channel.
      console.error("[Support] admin notification failed:", error);
    }

    if (!emailed && notified === 0) {
      console.error(
        `[Support] ticket from ${replyTo} reached NOTHING — email transport=${mail.transport}, ` +
          `admins notified=${notified}`
      );
      return api.error(
        `We could not deliver your message. Please email ${config.compliance.supportEmail} directly.`,
        503,
        "SUPPORT_UNDELIVERED"
      );
    }

    console.log(
      `[Support] ticket from ${replyTo} — emailed=${emailed} (${mail.transport}), admins notified=${notified}`
    );

    return api.success(
      { delivered: { email: emailed, admins: notified } },
      "Message received — support will reply by email"
    );
  } catch (error) {
    console.error("[Support Error]", error);
    return api.internal();
  }
}
