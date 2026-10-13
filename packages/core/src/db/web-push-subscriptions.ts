import { pool, getDialect } from './connection';
import type { IDatabase } from './adapters/types';
import type { WebPushSubscription, WebPushSubscriptionRow } from '../schemas/web-push';

export async function listWebPushSubscriptions(
  query: IDatabase['query'] = pool.query
): Promise<WebPushSubscriptionRow[]> {
  const result = await query<WebPushSubscriptionRow>(
    'SELECT * FROM remote_agent_web_push_subscriptions ORDER BY created_at, id'
  );
  return [...result.rows];
}

/** Another user resubmitting a known endpoint leaves the row with its owner, who alone can delete it. */
export async function addWebPushSubscription(
  userId: string,
  subscription: WebPushSubscription,
  query: IDatabase['query'] = pool.query
): Promise<void> {
  await query(
    `INSERT INTO remote_agent_web_push_subscriptions (id, user_id, endpoint, p256dh, auth)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
    WHERE remote_agent_web_push_subscriptions.user_id = excluded.user_id`,
    [
      getDialect().generateUuid(),
      userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
    ]
  );
}

export async function deleteWebPushSubscription(endpoint: string, userId?: string): Promise<void> {
  await pool.query(
    `DELETE FROM remote_agent_web_push_subscriptions WHERE endpoint = $1${userId === undefined ? '' : ' AND user_id = $2'}`,
    userId === undefined ? [endpoint] : [endpoint, userId]
  );
}
