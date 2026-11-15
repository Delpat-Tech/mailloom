// Mailloom Lightweight Service Worker for Instant Cold Startup & App Shell Caching
const CACHE_NAME = 'mailloom-shell-v5';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './mark.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass the service worker for other sites (fonts, remote mail images: the page CSP forbids the
  // worker's own fetch to them, the browser loads them directly), API endpoints and non-GET requests.
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.includes('/api/')) {
    return;
  }

  // Handle navigation requests (HTML shell)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      })
    );
    return;
  }

  // Stale-while-revalidate for static scripts, styles, and assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse || Response.error());

      return cachedResponse || fetchPromise;
    })
  );
});

// ---------------------------------------------------------------------------
// Push notifications (new mail while Mailloom is closed)
// Payload from the server: { v, kind: 'new-mail' | 'paused' | 'test', mailbox, title, body,
//   count?, unread?, folder?, uid?, silent?, tag }. Never the message text.
// Every push shows a notification: iPhone and Chrome stop delivering pushes to apps that do not.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const kind = typeof data.kind === 'string' ? data.kind : 'new-mail';
  const title = typeof data.title === 'string' && data.title ? data.title : 'New mail';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: './icon-192.png',
    badge: './badge-96.png',
    tag: typeof data.tag === 'string' ? data.tag : 'mailloom',
    // Replacing an older notification for the same mailbox still alerts, unless quiet.
    renotify: kind === 'new-mail' && !data.silent,
    silent: !!data.silent,
    timestamp: Date.now(),
    data: {
      kind,
      mailbox: typeof data.mailbox === 'string' ? data.mailbox : '',
      folder: typeof data.folder === 'string' ? data.folder : 'INBOX',
      uid: typeof data.uid === 'number' ? data.uid : null
    }
  };

  const tasks = [self.registration.showNotification(title, options)];

  if (kind === 'new-mail' && typeof data.unread === 'number' && 'setAppBadge' in self.navigator) {
    tasks.push(
      (data.unread > 0 ? self.navigator.setAppBadge(data.unread) : self.navigator.clearAppBadge()).catch(() => undefined)
    );
  }

  // An open Mailloom window refreshes its list at once.
  if (kind === 'new-mail') {
    tasks.push(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        for (const client of list) client.postMessage({ type: 'mailloom:new-mail', mailbox: options.data.mailbox });
      })
    );
  }

  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const target = { mailbox: info.mailbox || '', folder: info.folder || 'INBOX', uid: info.uid || null };
  const scopeUrl = new URL('./', self.registration.scope).href;

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = list.find((c) => c.url.startsWith(scopeUrl));
      if (existing) {
        await existing.focus().catch(() => undefined);
        if (target.mailbox) existing.postMessage({ type: 'mailloom:open', ...target });
        return;
      }
      // The fragment never reaches the server; the app reads and removes it.
      const hash = target.mailbox ? '#open=' + encodeURIComponent(JSON.stringify(target)) : '';
      await self.clients.openWindow(scopeUrl + hash);
    })()
  );
});
