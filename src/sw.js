/* The smallest service worker that does the job: it exists so the focus timer
   can show a notification with buttons (Android Chrome refuses the plain
   Notification constructor), and so tapping that notification brings the timer
   back. No fetch handler, no cache -- the site loads exactly as it would
   without this file. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', function (e) {
  var action = e.action || '';
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var open = list.filter(function (c) { return new URL(c.url).pathname.indexOf('/focus') === 0; })[0]
      || list[0];
    if (open) {
      if (action) open.postMessage({ type: 'focus-action', action: action });
      return open.focus();
    }
    return self.clients.openWindow('/focus/' + (action === 'again' ? '?again=1' : ''));
  }));
});
