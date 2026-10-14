import { legacyDestination } from '@/routes/LegacyRedirect';
import type { components } from '@/lib/api.generated';
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface WindowClient {
  url: string;
  controlled: boolean;
  navigate: (url: string) => Promise<unknown>;
}

function worker(windows: WindowClient[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = mock(async (_title: string, _options: NotificationOptions) => {});
  const openWindow = mock(async (_url: string) => {});
  runInNewContext(
    readFileSync(new URL('../../../../public/attention-sw.js', import.meta.url), 'utf8'),
    {
      URL,
      self: {
        location: { origin: 'https://archon.example' },
        addEventListener: (name: string, listener: (event: unknown) => void) =>
          listeners.set(name, listener),
        registration: { showNotification },
        // Mirrors Clients.matchAll: uncontrolled tabs are listed only on request.
        clients: {
          matchAll: async (options: { includeUncontrolled?: boolean } = {}) =>
            windows.filter(client => client.controlled || options.includeUncontrolled),
          openWindow,
        },
      },
    }
  );
  async function dispatch(name: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> | undefined;
    listeners.get(name)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
  }
  return { dispatch, showNotification, openWindow };
}

test('the service worker names the workflow and attention kind and collapses duplicates by run id', async () => {
  const sw = worker();
  const bodies: Record<components['schemas']['WebPushPayload']['kind'], string> = {
    gate: 'Waiting for your decision',
    attention: 'Needs attention',
    terminal: 'Run finished',
  };
  for (const kind of Object.keys(bodies))
    await sw.dispatch('push', {
      data: { json: () => ({ runId: 'run-1', workflowName: 'nightly', kind }) },
    });
  expect(sw.showNotification.mock.calls.map(call => call[0])).toEqual([
    'nightly',
    'nightly',
    'nightly',
  ]);
  expect(sw.showNotification.mock.calls.map(call => call[1])).toEqual([
    { body: 'Waiting for your decision', tag: 'run-1', data: { runId: 'run-1' } },
    { body: 'Needs attention', tag: 'run-1', data: { runId: 'run-1' } },
    { body: 'Run finished', tag: 'run-1', data: { runId: 'run-1' } },
  ]);
});

test('click opens the run with no console tab, or navigates and focuses an existing console', async () => {
  const event = { notification: { close: mock(() => {}), data: { runId: 'run-1' } } };
  const closed = worker();
  await closed.dispatch('notificationclick', event);
  expect(closed.openWindow).toHaveBeenCalledWith('https://archon.example/runs/run-1');
  const openedUrl = closed.openWindow.mock.calls[0]?.[0];
  if (!openedUrl) throw new Error('The notification did not open a window');
  expect(legacyDestination(new URL(openedUrl).pathname, '')).toBe('/console/r/run-1');
  const focus = mock(async () => {});
  const navigate = mock(async (_url: string) => ({ focus }));
  const open = worker([{ url: 'https://archon.example/settings', controlled: true, navigate }]);
  await open.dispatch('notificationclick', event);
  expect(navigate).toHaveBeenCalledWith('https://archon.example/runs/run-1');
  expect(focus).toHaveBeenCalledTimes(1);
  expect(open.openWindow).not.toHaveBeenCalled();
});

test('click opens a new window when the open console tab is not controlled by the worker', async () => {
  const event = { notification: { close: mock(() => {}), data: { runId: 'run-1' } } };
  // Browsers reject navigate() on a tab the worker does not control.
  const navigate = mock(async (_url: string) => {
    throw new TypeError("This service worker is not the client's active service worker.");
  });
  const sw = worker([{ url: 'https://archon.example/console', controlled: false, navigate }]);
  await sw.dispatch('notificationclick', event);
  expect(navigate).not.toHaveBeenCalled();
  expect(sw.openWindow).toHaveBeenCalledWith('https://archon.example/runs/run-1');
});
