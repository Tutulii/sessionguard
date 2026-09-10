self.addEventListener("push", (event) => {
  let payload = { title: "SessionGuard", body: "A new risk event is ready.", url: "/app", tag: "sessionguard" };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: { url: payload.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).pathname === "/app");
    return existing ? existing.focus() : clients.openWindow(event.notification.data?.url || "/app");
  }));
});
