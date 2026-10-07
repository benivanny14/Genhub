// =============================================================================
// GENHUB - One way to notify somebody
//
// An in-app notification and a push notification are the same message on two
// surfaces, and the failure mode of doing them separately is that they drift: a
// new notification is added, the bell shows it, and nobody on a phone ever hears
// about it — because the push was a second line the author forgot. This module
// makes them one call.
//
// Two shapes, because a notification is often written inside a transaction:
//
//   * createNotification()  — the common case. Writes the row, then mirrors it.
//   * pushForNotification() — for a row written with `tx.notification.create`
//     inside a transaction. Call it AFTER the transaction commits, because a
//     push for a membership or a payment that then rolls back is a message about
//     something that did not happen.
//
// Sending never throws and never blocks the write: push is an enhancement to a
// notice that is already delivered in-app (see push.service.ts).
// =============================================================================

import prisma from "@/lib/db";
import { sendPushToUser } from "./push.service";

export interface NotificationInput {
  userId: string;
  title: string;
  message: string;
  /** success | warning | error | info — the bell's colour. */
  type?: string;
  /** Where a tap should land. */
  link?: string | null;
  /**
   * Collapses successive pushes of the same kind into one banner on the device.
   * Defaults to a per-user key so unrelated notices never overwrite each other.
   */
  pushTag?: string;
}

/**
 * Write the in-app notification and mirror it to every device the person has.
 *
 * The push is fired without being awaited, so a slow push service cannot delay
 * the caller — which is usually a request handler that has real work to finish.
 */
export async function createNotification(input: NotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      message: input.message,
      type: input.type ?? "info",
      link: input.link ?? null,
    },
  });

  void pushForNotification(input);
  return notification;
}

/**
 * Tell every admin about something that needs a decision.
 *
 * The same alert, to every admin account, as one call — because the version of
 * this that gets written per feature is the version that forgets one of them:
 * `role: "ADMIN"` is asked once here, and a removed admin stops being told.
 *
 * Returns how many admins were told (0 when there are none). Never throws: a
 * missed alert must not fail the thing that already happened — the payout
 * request is on the record whether or not the bell rings. When nobody can be
 * told, that is logged loudly, because a queue with no reader is the failure
 * this exists to prevent.
 */
export async function notifyAdmins(input: {
  title: string;
  message: string;
  type?: string;
  link?: string | null;
  pushTag?: string;
}): Promise<number> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isBanned: false },
      select: { id: true },
    });

    if (admins.length === 0) {
      console.error(
        `[Notify] no ADMIN account can be told: "${input.title}" — it exists only in the database now.`
      );
      return 0;
    }

    await Promise.all(
      admins.map((admin) =>
        createNotification({ ...input, userId: admin.id }).catch((error) => {
          console.warn(
            `[Notify] could not tell admin ${admin.id}:`,
            (error as Error)?.message
          );
          return null;
        })
      )
    );

    return admins.length;
  } catch (error) {
    console.warn("[Notify] admin alert failed:", (error as Error)?.message);
    return 0;
  }
}

/**
 * Mirror an existing notification to the device.
 *
 * Use this after a transaction commits when the row was written with
 * `tx.notification.create`. It does not write anything, and never throws.
 */
export function pushForNotification(input: NotificationInput): Promise<unknown> {
  return sendPushToUser(input.userId, {
    title: input.title,
    body: input.message,
    url: input.link ?? "/",
    tag: input.pushTag,
  });
}
