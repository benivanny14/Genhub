// =============================================================================
// GENHUB - Browser push notifications
//
// The in-app bell only helps someone who opens the app. Push is the channel that
// reaches a person who does not: a creator whose video finished encoding, a
// viewer whose payment settled, a fan whose favourite creator posted. It is Web
// Push — no vendor account, no per-message cost, and the browser handles the
// encryption.
//
// Two rules keep this from becoming a liability:
//
//   * UNCONFIGURED IS SAFE. With no VAPID keys the app behaves exactly as it did
//     before push existed: isPushConfigured() is false, the client hides the
//     toggle, and every send is a no-op. A deployment that has not set the keys
//     must not look broken.
//   * SENDING NEVER THROWS. Push is an enhancement to a notification that has
//     already been delivered in-app. A dead endpoint, an expired key or a push
//     service outage must not fail the thing that created the notification — so
//     sendPushToUser swallows every error and reports what it did instead.
//
// A 404 or 410 from the push service means the subscription is gone (the browser
// uninstalled, the permission was revoked, the keys rotated). Those rows are
// deleted rather than retried forever: an endpoint that will never work again is
// not a recipient, it is litter.
// =============================================================================

import webpush from "web-push";
import prisma from "@/lib/db";

/** The payload the service worker receives. Kept small and plain. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should land, in-app. */
  url?: string;
  /** Collapses successive notifications of the same kind on the device. */
  tag?: string;
}

function configuredKeys(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

/** Whether this deployment can send push at all. */
export function isPushConfigured(): boolean {
  return configuredKeys() !== null;
}

/** The public key the browser needs to subscribe, or null when unconfigured. */
export function getVapidPublicKey(): string | null {
  return configuredKeys()?.publicKey ?? null;
}

let vapidReady = false;

/**
 * Point web-push at our keys, once.
 *
 * `VAPID_SUBJECT` should be a `mailto:` the push services can reach; a sensible
 * default is used when it is absent so a missing env var degrades to a contact
 * nobody reads rather than a crash on the first send.
 */
function ensureVapid(): boolean {
  const keys = configuredKeys();
  if (!keys) return false;
  if (!vapidReady) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT?.trim() || "mailto:support@genhub.app",
        keys.publicKey,
        keys.privateKey
      );
      vapidReady = true;
    } catch (error) {
      console.error("[Push] VAPID keys are set but invalid", error);
      return false;
    }
  }
  return true;
}

export interface PushSendResult {
  sent: number;
  removed: number;
  /** True when push is switched off or an unexpected fault occurred. */
  skipped: boolean;
}

/**
 * Send one notification to every device a person has allowed.
 *
 * Never throws. A subscription the push service has forgotten (404/410) is
 * deleted; any other failure is logged and the row kept, because a transient
 * outage must not cost someone their notifications.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<PushSendResult> {
  if (!ensureVapid()) return { sent: 0, removed: 0, skipped: true };

  let subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[];
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  } catch (error) {
    console.error("[Push] could not read subscriptions", error);
    return { sent: 0, removed: 0, skipped: true };
  }

  if (subscriptions.length === 0) return { sent: 0, removed: 0, skipped: false };

  const body = JSON.stringify(payload);
  let sent = 0;
  const deadIds: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          // 12 hours: a notification about a payment or a finished upload is
          // stale by then, and a phone that was off all day should not then get
          // a pile of history.
          { TTL: 60 * 60 * 12 }
        );
        sent += 1;
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deadIds.push(sub.id);
        } else {
          console.warn("[Push] send failed", statusCode ?? (error as Error)?.message);
        }
      }
    })
  );

  if (deadIds.length > 0) {
    try {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: deadIds } } });
    } catch (error) {
      console.error("[Push] could not prune dead subscriptions", error);
    }
  }

  return { sent, removed: deadIds.length, skipped: false };
}
