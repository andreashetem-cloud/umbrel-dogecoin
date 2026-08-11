/* Service worker for block notifications.
 *
 * The push that wakes this worker carries no payload — see push.js for why —
 * so the details come from the dashboard's own API at the moment the phone is
 * woken. That also means the notification shows the CURRENT state: if the node
 * has since confirmed the block, it says so.
 */
'use strict';

self.addEventListener('install', (event) => {
  // Take over immediately. Waiting for every tab to close would mean the first
  // block after enabling notifications is handled by no worker at all.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function describeBlock() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store', credentials: 'include' });
    if (!res.ok) throw new Error('status ' + res.status);
    const d = await res.json();
    // The NEWEST block, which is what the push is about. Preferring the newest
    // *accepted* one would describe an older block on the "found" push, when
    // the new one is still being submitted — so a second block would arrive
    // announcing the first one's height, worker and reward.
    const b = (d.blocks || [])[0];
    if (!b) return { title: 'Solo mining', body: 'Something happened worth opening the dashboard for.' };
    const reward = Number.isFinite(b.reward)
      ? (b.reward / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' DOGE'
      : 'reward unknown';
    // A record restored from an older file may be missing fields; a
    // notification reading "Height undefined ... found by undefined" is worse
    // than one that simply omits them.
    const height = Number.isFinite(b.height) ? `Height ${b.height}` : 'A block';
    const who = b.worker ? ` · found by ${b.worker}` : '';
    const state = b.status === 'accepted' ? 'accepted by your node'
      : b.status === 'submitting' ? 'being submitted'
      : b.status;
    return {
      title: 'You found a block!',
      body: `${height} · ${reward} · ${state}${who}`,
    };
  } catch (e) {
    // The push still has to produce a notification: a push event that resolves
    // without showing one makes the browser show its own "this site was updated
    // in the background" message, which is worse than a plain sentence.
    return { title: 'You found a block!', body: 'Open the dashboard for the details.' };
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const { title, body } = await describeBlock();
    await self.registration.showNotification(title, {
      body,
      tag: 'doge-block',
      renotify: true,
      requireInteraction: true,
      badge: '/icon-192.png',
      icon: '/icon-192.png',
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) return client.focus();
    }
    const url = (event.notification.data && event.notification.data.url) || '/';
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
