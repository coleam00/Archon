self.addEventListener('push', event => {
  const { runId, workflowName, kind } = event.data.json();
  const bodies = {
    gate: 'Waiting for your decision',
    action_required: 'Waiting for your action',
    terminal: 'Run finished',
  };
  if (
    typeof runId !== 'string' ||
    typeof workflowName !== 'string' ||
    !Object.hasOwn(bodies, kind)
  ) {
    throw new Error('Invalid attention push');
  }
  event.waitUntil(
    self.registration.showNotification(workflowName, {
      body: bodies[kind],
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
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(client => new URL(client.url).origin === target.origin);
      if (existing) {
        const navigated = await existing.navigate(target.href);
        if (navigated) return navigated.focus();
      }
      return self.clients.openWindow(target.href);
    })()
  );
});
