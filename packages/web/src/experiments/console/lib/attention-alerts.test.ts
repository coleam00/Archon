import { afterEach, expect, test } from 'bun:test';
import { getAttentionAlertsState, requestNotificationAccess } from './attention-alerts';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'Notification', original);
  else delete (globalThis as { Notification?: unknown }).Notification;
});

test('a rejected permission request is reported in settings', async () => {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      permission: 'default',
      requestPermission: (): Promise<NotificationPermission> =>
        Promise.reject(new Error('blocked by policy')),
    },
  });

  requestNotificationAccess();
  await flush();

  expect(getAttentionAlertsState().notificationError).toBe(
    'The browser could not ask for notification permission: blocked by policy'
  );
});
