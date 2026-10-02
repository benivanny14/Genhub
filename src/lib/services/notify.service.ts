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
