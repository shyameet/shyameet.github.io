/* The smallest service worker that does the job: it exists so the focus timer and the
   task reminders can show a notification with buttons (Android Chrome refuses the
   plain Notification constructor), and so tapping one brings the right page back.
   No fetch handler, no cache -- the site loads exactly as it would without this file. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', function (e) {
  var n = e.notification;
  var action = e.action || '';
  var ids = (n.data && n.data.ids) || [];
  var todo = n.tag === 'todo';
  n.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var home = todo ? '/tasks' : '/focus';
    var open = list.filter(function (c) { return new URL(c.url).pathname.indexOf(home) === 0; })[0]
      || list[0];
    if (open) {
      if (action) open.postMessage(todo ? { type: 'todo-action', action: action, ids: ids } : { type: 'focus-action', action: action });
      return open.focus();
    }
    /* nothing open: open the page, and let it do what the button said */
    if (todo) return self.clients.openWindow('/tasks/' + (action && ids[0] ? '?do=' + action + '&id=' + encodeURIComponent(ids[0]) : ''));
    return self.clients.openWindow('/focus/' + (action === 'again' ? '?again=1' : ''));
  }));
});
