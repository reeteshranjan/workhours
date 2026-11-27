// Work Hours service worker. A click on a notification button calls the server directly, so the
// tab doesn't need to open (DESIGN §7.1). There is no fetch handler and nothing is cached.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleClick(event.action, event.notification.data));
});

/** The API call for a button, or null for a click on the notification itself. */
function callFor(action, data) {
  if ((action === 'count' || action === 'resume') && Number.isInteger(data?.sessionId)) {
    return { path: `/api/away/${data.sessionId}`, body: { action } };
  }
  if (action === 'resume-project' && Number.isInteger(data?.projectId)) {
    return { path: `/api/projects/${data.projectId}/start`, body: {} };
  }
  return null;
}

async function handleClick(action, data) {
  const call = callFor(action, data);
  if (call) {
    try {
      const response = await fetch(call.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.body),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The server is down.
    }
    // The call didn't go through: show the user the page instead.
  }
  await focusApp();
}

/** Brings an open Work Hours window to the front, or opens one. */
async function focusApp() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (mine) {
    await mine.focus();
    return;
  }
  await self.clients.openWindow('/');
}
