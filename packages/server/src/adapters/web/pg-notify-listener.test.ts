import { describe, test, expect, mock } from 'bun:test';
import type { DbNotificationListener } from '@archon/core/db/adapters/types';
import { PgNotifyListener } from './pg-notify-listener';
import type { DashboardEventPoller } from './dashboard-event-poller';

describe('PgNotifyListener', () => {
  test('subscribes to the dashboard channel and a notification wakes the poller', async () => {
    let onNotify: ((p: string) => void) | undefined;
    const unsub = mock(() => undefined);
    const notifier: DbNotificationListener = {
      listen: mock((_channel, n: (p: string) => void) => {
        onNotify = n;
        return Promise.resolve(unsub);
      }),
    };
    const drainNow = mock(() => Promise.resolve());
    const poller = { drainNow } as unknown as DashboardEventPoller;

    const listener = new PgNotifyListener(notifier, poller);
    await listener.start();

    expect(notifier.listen).toHaveBeenCalledTimes(1);
    expect((notifier.listen as ReturnType<typeof mock>).mock.calls[0][0]).toBe(
      'archon_dashboard_event'
    );

    onNotify?.('run-1');
    expect(drainNow).toHaveBeenCalledTimes(1);

    listener.stop();
    expect(unsub).toHaveBeenCalled();
  });

  test('stop is idempotent and unsubscribes exactly once', async () => {
    const unsub = mock(() => undefined);
    const notifier: DbNotificationListener = {
      listen: mock(() => Promise.resolve(unsub)),
    };
    const listener = new PgNotifyListener(notifier, {
      drainNow: mock(() => Promise.resolve()),
    } as unknown as DashboardEventPoller);

    await listener.start();
    listener.stop();
    listener.stop();

    expect(unsub).toHaveBeenCalledTimes(1);
  });

  test('reconnects (with backoff) after the LISTEN connection drops', async () => {
    let calls = 0;
    let onError: ((e: Error) => void) | undefined;
    const unsub = mock(() => undefined);
    const notifier: DbNotificationListener = {
      listen: mock((_channel, _onNotify: (p: string) => void, oe: (e: Error) => void) => {
        calls += 1;
        onError = oe;
        return Promise.resolve(unsub);
      }),
    };
    const listener = new PgNotifyListener(
      notifier,
      { drainNow: mock(() => Promise.resolve()) } as unknown as DashboardEventPoller,
      5 // tiny backoff so the test doesn't wait a second
    );

    await listener.start();
    expect(calls).toBe(1);

    onError?.(new Error('connection lost')); // simulate the LISTEN connection dropping
    await new Promise(r => setTimeout(r, 30)); // wait past the 5ms backoff

    expect(calls).toBe(2); // reconnected
    expect(unsub).toHaveBeenCalled(); // old subscription cleaned up
    listener.stop();
  });
});
