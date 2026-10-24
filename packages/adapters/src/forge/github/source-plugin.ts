import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';
import {
  type ForgeEvent,
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventSelectorSchema,
  mapForgeInputs,
  matchForgeEvent,
} from '@archon/forge';
import { normalizeGitHubWebhook } from './normalize-event';
export { githubSourceCapabilities as capabilities } from './normalize-event';
import { jsonValueSchema, type JsonValue } from '@archon/workflows/output-ref';
import {
  resourceStartBindingIntentSchema,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import type {
  WebhookSourcePluginFactory,
  WebhookSourceResult,
} from '@archon/workflows/webhook-source-plugin';
import { verifyGitHubWebhookSignature } from './webhook-signature';

const bindingSchema = resourceStartBindingIntentSchema
  .omit({ bindingRevision: true, eventInputs: true })
  .extend({
    selector: forgeEventSelectorSchema,
    inputMapping: z.record(z.string(), createForgeInputBindingSchema(jsonValueSchema)),
  });

export const githubWebhookSourceConfigSchema = z
  .object({
    version: z.literal(1),
    webhookSecretEnv: z.string().min(1),
    host: z.literal('github.com'),
    bindings: z.array(bindingSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    const mappingSchema = createForgeBindingSchema(jsonValueSchema);
    for (const [index, binding] of config.bindings.entries()) {
      if (seen.has(binding.bindingId))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      seen.add(binding.bindingId);
      const mapping = mappingSchema.safeParse({
        selector: binding.selector,
        inputs: binding.inputMapping,
      });
      if (!mapping.success)
        for (const issue of mapping.error.issues)
          context.addIssue({
            code: 'custom',
            path: ['bindings', index, ...issue.path],
            message: issue.message,
          });
      if (!isAbsolute(binding.launch.cwd))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'launch', 'cwd'],
          message: 'Expected an absolute execution path',
        });
    }
  });
function evaluateBindings(configuredBindings: z.infer<typeof bindingSchema>[], event: ForgeEvent) {
  const bindings: ResourceStartBindingIntent[] = [];
  const evaluatedBindings: NonNullable<
    Extract<WebhookSourceResult, { status: 'received' }>['acceptance']['evaluatedBindings']
  > = [];
  for (const binding of configuredBindings) {
    const bindingRevision = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    const { selector, inputMapping, ...intent } = binding;
    if (!matchForgeEvent(selector, event)) {
      evaluatedBindings.push({
        bindingId: binding.bindingId,
        bindingRevision,
        status: 'unmatched',
        reason: 'selector_did_not_match',
      });
      continue;
    }
    const mapped = mapForgeInputs(inputMapping, event);
    if (!mapped.ok) {
      evaluatedBindings.push({
        bindingId: binding.bindingId,
        bindingRevision,
        status: 'rejected',
        reason: `Input '${mapped.input}': ${mapped.reason}`,
      });
      continue;
    }
    // Field mappings carry event content; literal mappings are the operator's own values.
    const literalInputs: Record<string, JsonValue> = {};
    const eventInputs: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(mapped.inputs))
      (inputMapping[name]?.source === 'field' ? eventInputs : literalInputs)[name] = value;
    bindings.push(
      resourceStartBindingIntentSchema.parse({
        ...intent,
        bindingRevision,
        launch: { ...binding.launch, inputs: { ...binding.launch.inputs, ...literalInputs } },
        eventInputs,
      })
    );
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
