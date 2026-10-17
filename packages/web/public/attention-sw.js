const attentionBodies = {
  gate: 'Waiting for your decision',
  attention: 'Needs attention',
  terminal: 'Run finished',
};

self.addEventListener('push', event => {
  const { runId, workflowName, kind } = event.data.json();
  if (
    typeof runId !== 'string' ||
    typeof workflowName !== 'string' ||
    !Object.hasOwn(attentionBodies, kind)
  ) {
    throw new Error('Invalid attention push');
  }
  event.waitUntil(
    self.registration.showNotification(workflowName, {
      body: attentionBodies[kind],
      tag: runId,
      data: { runId },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(
    `/runs/${encodeURIComponent(event.notification.data.runId)}`,
    self.location.origin
  );
  event.waitUntil(
    (async () => {
      // navigate() rejects for a tab this worker does not control, such as the tab that
      // enabled push before reloading; those tabs get a new window instead.
      const windows = await self.clients.matchAll({ type: 'window' });
      const existing = windows.find(client => new URL(client.url).origin === target.origin);
      if (existing) {
        const navigated = await existing.navigate(target.href);
        if (navigated) return navigated.focus();
      }
      return self.clients.openWindow(target.href);
    })()
  );
});
