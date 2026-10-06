import { beforeEach, expect, mock, test } from 'bun:test';
import type { DbNotificationListener } from '../db/adapters/types';
import { WORKFLOW_EVENT_NOTIFY_CHANNEL } from '../db/adapters/types';

const getListener = mock((): DbNotificationListener | null => null);
const connection = await import('../db/connection');
mock.module('../db/connection', () => ({ ...connection, getDbNotificationListener: getListener }));
const { subscribeToSqlRunDoorbell } = await import('./sql-host');

beforeEach(() => getListener.mockReset());

test('SQL notifications ring only for the requested run and expose unsubscribe', async () => {
  let notify: ((payload: string) => void) | undefined;
  const unsubscribe = mock(() => undefined);
  const listen = mock<DbNotificationListener['listen']>(async (_channel, callback) => {
    notify = callback;
    return unsubscribe;
  });
  getListener.mockReturnValue({ listen });
  const ring = mock(() => undefined);
  const close = await subscribeToSqlRunDoorbell('run', ring);
  expect(listen.mock.calls[0]?.[0]).toBe(WORKFLOW_EVENT_NOTIFY_CHANNEL);
  notify?.('other');
  expect(ring).not.toHaveBeenCalled();
  notify?.('run');
  expect(ring).toHaveBeenCalledTimes(1);
  close?.();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('missing and failed SQL listeners leave polling available', async () => {
  getListener.mockReturnValue(null);
  expect(await subscribeToSqlRunDoorbell('run', () => undefined)).toBeNull();
  getListener.mockReturnValue({
    listen: async () => {
      throw new Error('listener unavailable');
    },
  });
  expect(await subscribeToSqlRunDoorbell('run', () => undefined)).toBeNull();
});
