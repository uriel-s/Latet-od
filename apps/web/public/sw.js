// Minimal Service Worker for BottleRun ("לתת עוד") (ADR-0013).
//
// Used EXCLUSIVELY for receiving Web Push notifications (the `push` event) and focusing/opening
// the orders screen (the `notificationclick` event).
//
// CRITICAL: Deliberately contains ZERO `fetch` handlers and ZERO offline cache,
// ensuring it never serves stale HTML/JS assets after deploys (ADR-0006 & ADR-0013).

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'הזמנה חדשה — לתת עוד', body: event.data.text() };
  }

  const title = payload.title || 'הזמנה חדשה — לתת עוד';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    data: {
      url: payload.url || '/app/orders',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetPath =
    event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : '/app/orders';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
