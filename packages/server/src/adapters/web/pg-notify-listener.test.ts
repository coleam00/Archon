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
});
