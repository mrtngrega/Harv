/* global self, URLSearchParams */
// Harv's service worker on the phone (docs/PLAN.md §6q): notifications only, no caching (the
// dashboard always comes fresh from the computer). A push carries { title, body, tabId?, talk?, last?, tag? }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let note = { title: 'Harv', body: '' };
  try {
    note = { ...note, ...event.data.json() };
  } catch {
    if (event.data) note.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(note.title, {
      body: note.body,
      tag: note.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { tabId: note.tabId, talk: !!note.talk, last: !!note.last, body: note.body },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { tabId, talk, last, body } = event.notification.data ?? {};
  const params = new URLSearchParams();
  if (tabId) params.set('tab', tabId);
  if (talk) {
    params.set('talk', '1');
    if (last) params.set('last', '1');
    else if (body) params.set('say', body);
  }
  const url = `/${params.size ? `?${params}` : ''}`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        // The app is open: it switches to the chat (and voice mode) itself.
        open.postMessage({ type: 'harv.open', tabId, talk: !!talk, last: !!last, say: last ? undefined : body });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
