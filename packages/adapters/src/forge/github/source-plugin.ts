import { createHash, randomUUID } from 'node:crypto';
import type { z } from '@hono/zod-openapi';
import {
  type ForgeEvent,
  mapForgeInputs,
  matchForgeEvent,
  readForgeEventField,
} from '@archon/forge';
import { normalizeGitHubWebhook } from './normalize-event';
export { githubSourceCapabilities as capabilities } from './normalize-event';
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  mappedItemKey,
  resourceStartBindingIntentSchema,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import type {
  WebhookSourcePluginFactory,
  WebhookSourceResult,
} from '@archon/workflows/webhook-source-plugin';
import { githubSourceBindingSchema, githubWebhookSourceConfigSchema } from './source-config';
import { verifyGitHubWebhookSignature } from './webhook-signature';

type EvaluatedBinding = NonNullable<
  Extract<WebhookSourceResult, { status: 'received' }>['acceptance']['evaluatedBindings']
>[number];

/** The start one configured binding makes of `event`, or why it makes none. */
function evaluateBinding(
  binding: z.infer<typeof githubSourceBindingSchema>,
  event: ForgeEvent
): { start: ResourceStartBindingIntent } | { skipped: EvaluatedBinding } {
  const bindingRevision = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  const skipped = (status: EvaluatedBinding['status'], reason: string) => ({
    skipped: { bindingId: binding.bindingId, bindingRevision, status, reason },
  });
  const { selector, inputMapping, item, trustedText, ...intent } = binding;
  if (!matchForgeEvent(selector, event)) return skipped('unmatched', 'selector_did_not_match');
  const mapped = mapForgeInputs(inputMapping, event);
  if (!mapped.ok) return skipped('rejected', `Input '${mapped.input}': ${mapped.reason}`);
  const itemKey = item ? mappedItemKey(item, readForgeEventField(event, item.field)) : undefined;
  if (itemKey && !itemKey.ok) return skipped('rejected', `Item: ${itemKey.reason}`);
  // Field mappings carry event content; literal mappings are the operator's own values.
  const literalInputs: Record<string, JsonValue> = {};
  const eventInputs: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(mapped.inputs))
    (inputMapping[name]?.source === 'field' ? eventInputs : literalInputs)[name] = value;
  return {
    start: resourceStartBindingIntentSchema.parse({
      ...intent,
      ...(trustedText
        ? {
            trustedText: {
              ...trustedText,
              subject: eventSubject(event),
            },
          }
        : {}),
      bindingRevision,
      launch: { ...binding.launch, inputs: { ...binding.launch.inputs, ...literalInputs } },
      eventInputs,
      ...(itemKey ? { itemKey: itemKey.key } : {}),
    }),
  };
}

function eventSubject(event: ForgeEvent) {
  switch (event.kind) {
    case 'issue.lifecycle':
      return { kind: 'issue' as const, ref: event.issue };
    case 'pr.lifecycle':
      return { kind: 'pr' as const, ref: event.pr };
    case 'label.changed':
    case 'comment.changed':
      return event.subject;
    case 'check.changed':
      throw new Error('trusted_text_check_event_unsupported');
  }
}

function evaluateBindings(
  configuredBindings: z.infer<typeof githubSourceBindingSchema>[],
  event: ForgeEvent
) {
  const bindings: ResourceStartBindingIntent[] = [];
  const evaluatedBindings: EvaluatedBinding[] = [];
  for (const binding of configuredBindings) {
    const evaluated = evaluateBinding(binding, event);
    if ('start' in evaluated) bindings.push(evaluated.start);
    else evaluatedBindings.push(evaluated.skipped);
  }
  return { bindings, evaluatedBindings };
}

/** Configured source plugins run as trusted operator-installed code. */
const createGitHubWebhookSource: WebhookSourcePluginFactory = ({
  sourceInstanceId,
  config: rawConfig,
}) => {
  const parsed = githubWebhookSourceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw new Error('Invalid GitHub source plugin configuration');
  const config = parsed.data;
  const secret = process.env[config.webhookSecretEnv];
  if (!secret) throw new Error('GitHub source plugin webhook secret is unavailable');
  return {
    async receive(request): Promise<WebhookSourceResult> {
      if (
        !verifyGitHubWebhookSignature(
          request.body,
          request.headers['x-hub-signature-256'] ?? '',
          secret
        )
      )
        return { status: 'rejected', reason: 'unauthenticated' };
      const delivery = {
        deliveryId: request.headers['x-github-delivery'] ?? null,
        eventName: request.headers['x-github-event'],
        contentDigest: createHash('sha256').update(request.body).digest('hex'),
        receivedAt: request.receivedAt,
      };
      const receipt: SourceReceiptInput = {
        id: randomUUID(),
        sourceInstanceId: sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        occurredAt: null,
        sourceActor: null,
      };
      let payload: unknown;
      try {
        payload = JSON.parse(request.body) as unknown;
      } catch {
        return {
          status: 'received',
          acceptance: { receipt, outcome: 'malformed', reason: 'invalid_json', bindings: [] },
        };
      }
      const normalized = normalizeGitHubWebhook(payload, {
        sourceInstanceId: sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        host: config.host,
        eventName: delivery.eventName ?? '',
      });
      if (normalized.status !== 'normalized') {
        return {
          status: 'received',
          acceptance: {
            receipt,
            outcome: normalized.status,
            reason: normalized.reason,
            bindings: [],
          },
        };
      }
      receipt.occurredAt = normalized.envelope.occurredAt;
      if (normalized.envelope.sourceActor) {
        receipt.sourceActor = {
          source: sourceInstanceId,
          id: normalized.envelope.sourceActor.id,
        };
      }
      const { bindings, evaluatedBindings } = evaluateBindings(
        config.bindings,
        normalized.envelope.event
      );
      const [first, ...rest] = bindings;
      return {
        status: 'received',
        acceptance: {
          receipt,
          evaluatedBindings,
          ...(first
            ? { outcome: 'matched', bindings: [first, ...rest] }
            : { outcome: 'unmatched', bindings: [] }),
        },
      };
    },
  };
};

export default createGitHubWebhookSource;
