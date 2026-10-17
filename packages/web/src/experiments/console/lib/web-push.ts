import { useSyncExternalStore } from 'react';
import { getWebPushKey, subscribeWebPush, unsubscribeWebPush } from '../skills/webPush';
import { errorDetail } from './http';

interface BrowserPushState {
  enabled: boolean;
  busy: boolean;
  error: string | null;
  unsupported: string | null;
}
const listeners = new Set<() => void>();
let state: BrowserPushState = { enabled: false, busy: false, error: null, unsupported: null };
function update(change: Partial<BrowserPushState>): void {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}
export function getBrowserPushState(): BrowserPushState {
  return state;
}
export function useBrowserPush(): BrowserPushState {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getBrowserPushState);
}
function unsupported(): string | null {
  if (!window.isSecureContext) return 'Browser push needs HTTPS or localhost.';
  if (
    !('serviceWorker' in navigator) ||
    typeof PushManager === 'undefined' ||
    typeof Notification === 'undefined'
  )
    return 'This browser does not support push notifications. On iOS, install Archon as a home-screen web app first.';
  return null;
}
function subscriptionBody(subscription: PushSubscription): Parameters<typeof subscribeWebPush>[0] {
  const json = subscription.toJSON();
  if (!json.keys?.p256dh || !json.keys.auth)
    throw new Error('The browser returned a subscription without encryption keys');
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

export async function refreshBrowserPush(): Promise<void> {
  const reason = unsupported();
  update({ unsupported: reason });
  if (reason || state.busy) return;
  update({ busy: true });
  try {
    const registration = await navigator.serviceWorker.getRegistration('/attention-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    update({ enabled: subscription !== null && subscription !== undefined });
    if (subscription) await subscribeWebPush(subscriptionBody(subscription));
    update({ error: null });
  } catch (err) {
    update({ error: errorDetail(err) });
  } finally {
    update({ busy: false });
  }
}

/** Notification permission must be requested during the checkbox's user gesture. */
export async function enableBrowserPush(): Promise<void> {
  if (state.busy) return;
  const reason = unsupported();
  if (reason) {
    update({ unsupported: reason });
    return;
  }
  update({ busy: true, error: null });
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
      throw new Error(
        'Notifications are blocked. Allow them in this browser’s site settings to enable push.'
      );
    const { publicKey } = await getWebPushKey();
    const registration = await navigator.serviceWorker.register('/attention-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char =>
      char.charCodeAt(0)
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      }));
    try {
      await subscribeWebPush(subscriptionBody(subscription));
    } catch (err) {
      await subscription.unsubscribe();
      throw err;
    }
    update({ enabled: true });
  } catch (err) {
    update({ error: errorDetail(err) });
  } finally {
    update({ busy: false });
  }
}

export async function disableBrowserPush(): Promise<void> {
  if (state.busy) return;
  update({ busy: true, error: null });
  try {
    const registration = await navigator.serviceWorker.getRegistration('/attention-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      await unsubscribeWebPush(subscription.endpoint);
      if (!(await subscription.unsubscribe()))
        throw new Error('The browser could not unsubscribe. Try again.');
    }
    update({ enabled: false });
  } catch (err) {
    update({ error: errorDetail(err) });
  } finally {
    update({ busy: false });
  }
}
