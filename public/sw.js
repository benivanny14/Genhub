// =============================================================================
// GENHUB - Service worker (push only)
//
// Deliberately NOT an offline/PWA worker: there is no fetch handler and no
// cache. Its whole job is to receive a push message and show it, and to open the
// right page when the notification is tapped. Anything else a service worker can
// do — caching, offline shells, background sync — is a decision this project has
// not made, so this file makes none of them.
// =============================================================================

self.addEventListener("push", (event) => {
  let data = { title: "Genhub", body: "", url: "/", tag: undefined };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // A malformed payload still shows something rather than nothing.
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Genhub", {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing tab when there is one, so a tap does not scatter
        // duplicate tabs; otherwise open a new one.
        for (const client of clients) {
          if ("focus" in client && "navigate" in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});
