import webPush from 'web-push';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger, getArchonHome } from '@archon/paths';
import { getDatabase, getDatabaseType } from '@archon/core/db/connection';
import {
  addWebPushSubscription,
  deleteWebPushSubscription,
  listWebPushSubscriptions,
} from '@archon/core/db/web-push-subscriptions';
import { hasAnyAttentionNotice } from '@archon/core/db/workflow-events';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import type {
  WebPushSubscription,
  WebPushSubscriptionRow,
  WebPushPayload,
} from '@archon/core/schemas/web-push';
import {
  recordActivationBaseline,
  type PushDestination,
  type PushDestinationState,
  type PushDeliveryResult,
} from './attention-router';

const vapidSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export function loadVapidKeys(home: string = getArchonHome()): z.infer<typeof vapidSchema> {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'web-push-vapid.json');
  try {
    return readKeys();
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  const temporary = join(home, `.web-push-vapid-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(webPush.generateVAPIDKeys()), {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    try {
      // Publish a complete pair without replacing another server process’s winner.
      linkSync(temporary, path);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    }
  } finally {
    unlinkSync(temporary);
  }
  return readKeys();

  function readKeys(): z.infer<typeof vapidSchema> {
    chmodSync(path, 0o600);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      // JSON parser diagnostics can quote private bytes from a malformed key file.
      if (err instanceof SyntaxError) throw new Error('VAPID key file is not valid JSON');
      throw err;
    }
    const parsed = vapidSchema.safeParse(value);
    if (!parsed.success) throw new Error('VAPID key file does not contain a valid key pair');
    return parsed.data;
  }
}

export class WebPushDestination implements PushDestination {
  readonly id = 'web-push';
  private readonly log = createLogger('server.web-push');
  constructor(
    private readonly inlinePlatforms: ReadonlySet<string> = new Set(),
    private readonly sender: typeof webPush.sendNotification = webPush.sendNotification
  ) {}

  publicKey(): string {
    return loadVapidKeys().publicKey;
  }

  async subscribe(userId: string, subscription: WebPushSubscription): Promise<void> {
    await getDatabase().withTransaction(async query => {
      // Serialize first subscriptions across server processes before checking activation.
      if (getDatabaseType() === 'postgresql')
        await query('LOCK TABLE remote_agent_web_push_subscriptions IN SHARE ROW EXCLUSIVE MODE');
      const subscriptions = await listWebPushSubscriptions(query);
      if (subscriptions.length === 0 && !(await hasAnyAttentionNotice(this.id, query)))
        await recordActivationBaseline(this.id, this.inlinePlatforms, query);
      await addWebPushSubscription(userId, subscription, query);
    });
  }

  async state(): Promise<PushDestinationState> {
    return (await listWebPushSubscriptions()).length > 0 ? 'active' : 'no_subscribers';
  }

  async deliver(notice: AttentionNotice): Promise<PushDeliveryResult> {
    const subscriptions = await listWebPushSubscriptions();
    if (subscriptions.length === 0) throw new Error('Web push has no subscribers');
    const keys = loadVapidKeys();
    const payload = JSON.stringify({
      runId: notice.run.id,
      workflowName: notice.run.workflow_name,
      kind: notice.kind,
    } satisfies WebPushPayload);
    let failed = false;
    let delivered = 0;
    for (const subscription of subscriptions) {
      const result = await this.sendToSubscription(subscription, payload, keys);
      if (result === 'delivered') delivered += 1;
      else if (result === 'failed') failed = true;
    }
    if (delivered === 0 && !failed)
      throw new Error('No browser received the push; expired subscriptions were removed');
    if (failed)
      throw new Error('Some web push deliveries failed; retrying the destination on the next scan');
    return {};
  }

  private async sendToSubscription(
    subscription: WebPushSubscriptionRow,
    payload: string,
    keys: z.infer<typeof vapidSchema>
  ): Promise<'delivered' | 'expired' | 'failed'> {
    try {
      await this.sender(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          vapidDetails: { subject: 'https://archon.diy', ...keys },
          timeout: 10_000,
        }
      );
      return 'delivered';
    } catch (error) {
      const status = error instanceof webPush.WebPushError ? error.statusCode : undefined;
      // Vendor errors contain subscription URLs, headers and bodies; retain only status.
      const err = new Error(
        status === undefined
          ? 'Web push transport failed'
          : `Web push failed with status ${String(status)}`
      );
      this.log.error({ err }, 'web_push.delivery_failed');
      if (status === 404 || status === 410) {
        await deleteWebPushSubscription(subscription.endpoint);
        return 'expired';
      }
      return 'failed';
    }
  }
}
