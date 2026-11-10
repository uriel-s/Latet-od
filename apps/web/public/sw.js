// Minimal Service Worker for BottleRun ("לתת עוד") (ADR-0013).
//
// Used EXCLUSIVELY for receiving Web Push notifications (the `push` event) and focusing/opening
// the orders screen (the `notificationclick` event).
//
// CRITICAL: Deliberately contains ZERO `fetch` handlers and ZERO offline cache,
// ensuring it never serves stale HTML/JS assets after deploys (ADR-0006 & ADR-0013).

self.addEventListener('install', () => {
  self.skipWaiting?.();
});

self.addEventListener('activate', (event) => {
  if (self.clients?.claim) {
    event.waitUntil(self.clients.claim());
  }
});

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
    // The large colored picture shown beside the text.
    icon: '/icon-192.png',
    // The small status-bar icon. Android draws it as a single-color silhouette, so it must be white
    // on a transparent background; a colored picture here becomes a plain white square.
    badge: '/badge-96.png',
    // Two short buzzes, so a new order is noticed even with the sound off.
    vibrate: [200, 100, 200],
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

  const rawPath =
    event.notification.data && typeof event.notification.data.url === 'string'
      ? event.notification.data.url
      : '/app/orders';

  // Ensure relative path starting with / and not // to prevent open redirect
  const safePath =
    rawPath.startsWith('/') && !rawPath.startsWith('//') && !rawPath.includes('\\')
      ? rawPath
      : '/app/orders';
  const targetUrl = new URL(safePath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 1. If an existing window is exactly on the target URL, focus it
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // 2. If an existing window is on any collector app screen (/app/*), navigate and focus it
      for (const client of clientList) {
        if (client.url.startsWith(`${self.location.origin}/app`) && 'focus' in client) {
          if ('navigate' in client) {
            return client
              .navigate(targetUrl)
              .then((navigated) => (navigated ? navigated.focus() : client.focus()));
          }
          return client.focus();
        }
      }
      // 3. Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
