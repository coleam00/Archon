import { afterEach, expect, mock, test } from 'bun:test';
import {
  disableBrowserPush,
  enableBrowserPush,
  getBrowserPushState,
  refreshBrowserPush,
} from './web-push';

const descriptors = new Map(
  ['window', 'navigator', 'PushManager', 'Notification', 'fetch'].map(name => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ])
);
afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

test('permission is requested during opt-in, subscription reaches the API, and disabling removes both sides', async () => {
  const unsubscribe = mock(async () => true);
  let subscribed = false;
  const subscription = {
    endpoint: 'https://push.example/test',
    toJSON: () => ({ keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }),
    unsubscribe,
  };
  const registration = {
    pushManager: {
      getSubscription: mock(async () => (subscribed ? subscription : null)),
      subscribe: mock(async (_options: PushSubscriptionOptionsInit) => {
        subscribed = true;
        return subscription;
      }),
    },
  };
  const register = mock(async () => registration);
  const permission = mock(async () => 'granted');
  const fetcher = mock(
    async (url: string, _options?: RequestInit) =>
      new Response(
        JSON.stringify(url.endsWith('/key') ? { publicKey: 'AQID' } : { success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );
  setGlobal('window', { isSecureContext: true, location: { origin: 'http://localhost' } });
  setGlobal('PushManager', function () {});
  setGlobal('Notification', { requestPermission: permission });
  setGlobal('navigator', {
    serviceWorker: {
      register,
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  setGlobal('fetch', fetcher);
  const enabling = enableBrowserPush();
  expect(permission).toHaveBeenCalledTimes(1);
  await enabling;
  expect(getBrowserPushState()).toMatchObject({ enabled: true, busy: false, error: null });
  expect(register).toHaveBeenCalledWith('/attention-sw.js', { scope: '/' });
  expect(registration.pushManager.subscribe.mock.calls[0]?.[0]).toEqual({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3]),
  });
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
    endpoint: subscription.endpoint,
    keys: subscription.toJSON().keys,
  });
  await disableBrowserPush();
  expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(getBrowserPushState().enabled).toBe(false);
  subscribed = false;
  await refreshBrowserPush();
});

test('denied permission and insecure origins remain visible and do not subscribe', async () => {
  setGlobal('window', { isSecureContext: false });
  await enableBrowserPush();
  expect(getBrowserPushState().unsupported).toBe('Browser push needs HTTPS or localhost.');
  setGlobal('window', { isSecureContext: true });
  setGlobal('navigator', { serviceWorker: {} });
  setGlobal('PushManager', function () {});
  setGlobal('Notification', { requestPermission: async () => 'denied' });
  await enableBrowserPush();
  expect(getBrowserPushState().error).toContain('Notifications are blocked');
});
