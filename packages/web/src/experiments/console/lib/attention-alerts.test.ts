import { afterEach, expect, test } from 'bun:test';
import {
  disableAttentionAlerts,
  getAttentionAlertsState,
  requestNotificationAccess,
} from './attention-alerts';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const originals = {
  Notification: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function stubPermissionRequest(request: () => Promise<NotificationPermission>): void {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { permission: 'default', requestPermission: request },
  });
}

test('a rejected permission request is reported until a retry succeeds', async () => {
  stubPermissionRequest(() => Promise.reject(new Error('blocked by policy')));
  requestNotificationAccess();
  await flush();
  expect(getAttentionAlertsState().notificationError).toBe(
    'The browser could not ask for notification permission: blocked by policy'
  );

  stubPermissionRequest(() => Promise.resolve('granted'));
  requestNotificationAccess();
  await flush();
  expect(getAttentionAlertsState()).toMatchObject({
    notifications: 'granted',
    notificationError: null,
  });
});

test('a setting the browser cannot save is reported', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      setItem: (): void => {
        throw new Error('quota exceeded');
      },
    },
  });
  disableAttentionAlerts();
  expect(getAttentionAlertsState()).toMatchObject({
    enabled: false,
    saveError:
      'This browser could not save the alert setting, so it lasts only until the page reloads: quota exceeded',
  });
});
