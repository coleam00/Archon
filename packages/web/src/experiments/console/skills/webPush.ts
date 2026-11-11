import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

type Subscription = components['schemas']['WebPushSubscription'];
type Success = components['schemas']['WebPushSuccess'];
export function getWebPushKey(): Promise<components['schemas']['WebPushKey']> {
  return requestJson('/api/web-push/key', 'get');
}
export function subscribeWebPush(subscription: Subscription): Promise<Success> {
  return requestJson('/api/web-push/subscriptions', 'post', { body: subscription });
}
export function unsubscribeWebPush(endpoint: string): Promise<Success> {
  return requestJson('/api/web-push/subscriptions', 'delete', {
    body: { endpoint } satisfies components['schemas']['WebPushDelete'],
  });
}
