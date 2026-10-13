import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

type Subscription = components['schemas']['WebPushSubscription'];
type Success = components['schemas']['WebPushSuccess'];
export function getWebPushKey(): Promise<components['schemas']['WebPushKey']> {
  return requestJson('/api/web-push/key');
}
export function subscribeWebPush(subscription: Subscription): Promise<Success> {
  return requestJson('/api/web-push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}
export function unsubscribeWebPush(endpoint: string): Promise<Success> {
  return requestJson('/api/web-push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint } satisfies components['schemas']['WebPushDelete']),
  });
}
