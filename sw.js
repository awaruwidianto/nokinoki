// NOKI NOKI Service Worker v4 (Persistent Background Watch + Sound & Push Notifications)
const CACHE_NAME = 'noki-noki-v4';
const DB_URL = 'https://noki-noki-3f23e-default-rtdb.asia-southeast1.firebasedatabase.app';

let bgWatchRunning = false;
let lastClientSyncAt = 0;

// --- IndexedDB Helper for persisting user state in Service Worker ---
function openSwDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nokiSwState', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openSwDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function idbSet(key, val) {
  try {
    const db = await openSwDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first fetch so updates on GitHub Pages always load fresh
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Check Firebase RTDB for new unread messages when tab is in background or closed
async function checkUnreadMessagesInBackground() {
  const state = await idbGet('userState');
  if (!state || !state.uid || !state.notifEnabled) return;

  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const anyFocused = clientList.some((c) => c.focused && c.visibilityState === 'visible');
  if (anyFocused) return;

  try {
    const res = await fetch(`${DB_URL}/friends/${encodeURIComponent(state.uid)}.json`, {
      cache: 'no-store'
    });
    if (!res.ok) return;
    const friends = (await res.json()) || {};

    const prevMap = state.unreadMap || {};
    const nextMap = {};
    let totalUnread = 0;

    for (const f of Object.values(friends)) {
      if (!f || !f.uid) continue;
      const count = f.unread || 0;
      totalUnread += count;
      nextMap[f.uid] = count;

      const prevCount = prevMap[f.uid] || 0;
      if (count > prevCount) {
        const sender = f.nickname || 'Friend';
        const avatar = f.avatar || '💬';
        const fallbackMsg =
          state.lang === 'ko'
            ? '새 메시지가 도착했습니다!'
            : state.lang === 'id'
            ? 'Pesan baru masuk!'
            : 'New message received!';
        const body = f.lastMessageText ? `${avatar} ${f.lastMessageText}` : fallbackMsg;

        await self.registration.showNotification(`NOKI NOKI · ${sender}`, {
          body,
          icon: 'icon.png',
          badge: 'icon.png',
          tag: 'noki-msg-' + f.uid,
          renotify: true,
          silent: false,
          vibrate: [200, 100, 200],
          requireInteraction: true,
          data: { friendUid: f.uid, url: '/nokinoki/' }
        });

        // Also tell any open background tab to play the retro NOKI NOKI chime
        for (const client of clientList) {
          client.postMessage({ type: 'PLAY_CHIME', friendUid: f.uid });
        }
      }
    }

    state.unreadMap = nextMap;
    await idbSet('userState', state);

    if (self.navigator && self.navigator.setAppBadge) {
      if (totalUnread > 0) {
        self.navigator.setAppBadge(totalUnread).catch(() => {});
      } else {
        self.navigator.clearAppBadge().catch(() => {});
      }
    }
  } catch (e) {}
}

// Persistent background watch loop when app is minimized or tab is backgrounded
async function runBackgroundWatchLoop() {
  if (bgWatchRunning) return;
  bgWatchRunning = true;
  try {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const anyFocused = clientList.some((c) => c.focused && c.visibilityState === 'visible');
      if (anyFocused) break;

      // If client is not actively syncing (e.g., tab throttled or closed), poll from SW
      if (Date.now() - lastClientSyncAt > 3500 || clientList.length === 0) {
        await checkUnreadMessagesInBackground();
      }
    }
  } finally {
    bgWatchRunning = false;
  }
}

// Receive user session & background watch triggers from index.html
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SET_USER' || data.type === 'START_BG_WATCH') {
    lastClientSyncAt = Date.now();
    event.waitUntil(
      (async () => {
        const existing = (await idbGet('userState')) || {};
        const updated = {
          uid: data.uid !== undefined ? data.uid : existing.uid,
          lang: data.lang || existing.lang || 'en',
          notifEnabled: data.notifEnabled !== undefined ? data.notifEnabled : existing.notifEnabled,
          unreadMap: data.unreadMap || existing.unreadMap || {}
        };
        await idbSet('userState', updated);
        if (data.type === 'START_BG_WATCH') {
          await runBackgroundWatchLoop();
        }
      })()
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'noki-msg-sync') {
    event.waitUntil(checkUnreadMessagesInBackground());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'noki-msg-sync') {
    event.waitUntil(checkUnreadMessagesInBackground());
  }
});

// Standard Web Push event handler
self.addEventListener('push', (event) => {
  if (!event.data) {
    event.waitUntil(checkUnreadMessagesInBackground());
    return;
  }

  let payload = {};
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'NOKI NOKI', body: event.data.text() };
  }

  const title = payload.title || 'NOKI NOKI';
  const options = {
    body: payload.body || '💬 New message received!',
    icon: payload.icon || 'icon.png',
    badge: 'icon.png',
    tag: payload.tag || 'noki-push',
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: { url: (payload.data && payload.data.url) || '/nokinoki/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap notification -> focus open NOKI NOKI window or open /nokinoki/
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/nokinoki/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'OPEN_INBOX',
            friendUid: event.notification.data ? event.notification.data.friendUid : null
          });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
