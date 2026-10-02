"use client";

// =============================================================================
// GENHUB - Browser push, from the browser's side
//
// Registers the push-only service worker, asks the browser for permission, and
// hands the resulting subscription to the server. Kept apart from the component
// so the component is only about the button and its words.
//
// Every failure is reported as a STATE, never thrown: a browser with no push
// support, a person who declined, and a network that could not reach our own API
// all end with the toggle showing the right thing instead of a crash.
// =============================================================================

export type PushState = "loading" | "unsupported" | "denied" | "subscribed" | "off";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Register the worker once. Safe to call repeatedly — the browser dedupes. */
async function registerWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Is this browser able to do push at all? */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/** What the toggle should show right now. */
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const existing = registration ? await registration.pushManager.getSubscription() : null;
    if (existing) return "subscribed";
    return "off";
  } catch {
    return "off";
  }
}

export interface PushSubscribeResult {
  ok: boolean;
  state: PushState;
  error?: string;
}

/** Ask for permission and register this device. */
export async function subscribeToPush(): Promise<PushSubscribeResult> {
  if (!pushSupported()) return { ok: false, state: "unsupported" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, state: permission === "denied" ? "denied" : "off" };
  }

  try {
    const keyRes = await fetch("/api/push/vapid");
    const keyBody = await keyRes.json();
    const publicKey: string | null = keyBody?.data?.publicKey ?? null;
    if (!keyBody?.success || !publicKey) {
      return { ok: false, state: "off", error: "Notifications are not available right now" };
    }

    const registration = await registerWorker();
    await navigator.serviceWorker.ready;

    const subscription = await registration.pushManager.subscribe({
      // Chrome will not accept a push subscription without this.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    const saved = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    const savedBody = await saved.json().catch(() => null);
    if (!savedBody?.success) {
      // Do not leave a browser subscribed to a server that does not know it.
      await subscription.unsubscribe().catch(() => {});
      return { ok: false, state: "off", error: savedBody?.error || "Could not turn notifications on" };
    }

    return { ok: true, state: "subscribed" };
  } catch (error) {
    return {
      ok: false,
      state: "off",
      error: error instanceof Error ? error.message : "Could not turn notifications on",
    };
  }
}

/** Turn this device's notifications off. */
export async function unsubscribeFromPush(): Promise<PushSubscribeResult> {
  if (!pushSupported()) return { ok: false, state: "unsupported" };
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = registration ? await registration.pushManager.getSubscription() : null;

    if (subscription) {
      // Tell the server first, then the browser: if the second step failed and
      // the server still held the endpoint, a later push would error instead of
      // being pruned. The other order can leave a device the server forgets.
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {});
      await subscription.unsubscribe();
    }

    return { ok: true, state: "off" };
  } catch {
    return { ok: false, state: "off" };
  }
}
