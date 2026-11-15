// Firebase Cloud Messaging Service Worker for Background Push Notifications
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
const firebaseConfig = {
  apiKey: params.get('apiKey') || 'AIzaSyD302gnOe62JCFrXILhn2RoeRMiOqE9Okc',
  authDomain: params.get('authDomain') || 'aghbilia.firebaseapp.com',
  projectId: params.get('projectId') || 'aghbilia',
  storageBucket: params.get('storageBucket') || 'aghbilia.firebasestorage.app',
  messagingSenderId: params.get('messagingSenderId') || '614382303024',
  appId: params.get('appId') || '1:614382303024:web:333d30552b2bc07e30baf5',
};

const isConfigured = Object.values(firebaseConfig).every((value) => (
  value && !/dummy|placeholder|your_|000000000000/i.test(value)
));

try {
  if (isConfigured && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  if (isConfigured) {
    const messaging = firebase.messaging();
    // The push carries a `notification` block, so Firebase already shows it once.
    // Showing it here too made every status change appear more than once on the phone.
    messaging.onBackgroundMessage((payload) => {
      const rawCount = payload.data?.unread_count;
      const count = rawCount ? parseInt(rawCount, 10) : 1;
      if (self.navigator && self.navigator.setAppBadge) {
        self.navigator.setAppBadge(count).catch(() => {});
      }
    });
  }
} catch (error) {
  console.warn('Firebase background messaging initialization error.', error);
}

// ─── App Shell Cache for PWA Install Support ───
const CACHE_NAME = 'ashbiliya-pwa-v1';
const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/eshbelia-logo.png',
];

// Push notification click handler - opens the window or focuses open tab with direct deep link
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (self.navigator && self.navigator.clearAppBadge) {
    self.navigator.clearAppBadge().catch(() => {});
  }
  const rawUrl = event.notification.data?.url
    || event.notification.data?.fcmOptions?.link
    || event.notification.data?.FCM_MSG?.fcmOptions?.link
    || event.notification.data?.FCM_MSG?.data?.url
    || '/notifications';
  const targetUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ─── Fetch handler (Network-First with App Shell fallback) ───
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin navigation and app shell requests
  if (url.origin !== self.location.origin) return;

  // For navigation requests, try network first then cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache the latest HTML for offline
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', clone)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // For static assets (JS, CSS, images), try cache first then network
  if (event.request.destination === 'script' || event.request.destination === 'style' || event.request.destination === 'image') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        });
      })
    );
    return;
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => clients.claim())
  );
});

