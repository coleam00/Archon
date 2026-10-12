import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';
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
import { isJsonPointer, resolveJsonPointer } from './json-pointer';
import { decodeSigningSecret, verifySignature } from './signature';

const bindingSchema = resourceStartBindingIntentSchema
  .omit({ bindingRevision: true })
  .extend({
    inputMapping: z.record(
      z.string().min(1),
      z.string().refine(isJsonPointer, 'Invalid JSON Pointer')
    ),
  })
  .strict();

export const standardWebhooksSourceConfigSchema = z
  .object({
    version: z.literal(1),
    signingSecretEnv: z.string().min(1),
    bindings: z.array(bindingSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, binding] of config.bindings.entries()) {
      if (seen.has(binding.bindingId))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      seen.add(binding.bindingId);
      if (!isAbsolute(binding.launch.cwd))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'launch', 'cwd'],
          message: 'Expected an absolute execution path',
        });
    }
  });

const createStandardWebhooksSource: WebhookSourcePluginFactory = ({
  sourceInstanceId,
  config: rawConfig,
}) => {
  const parsed = standardWebhooksSourceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw new Error('Invalid Standard Webhooks source plugin configuration');
  const config = parsed.data;
  const secret = decodeSigningSecret(process.env[config.signingSecretEnv]);
  return {
    async receive(request): Promise<WebhookSourceResult> {
      if (!verifySignature(request, secret))
        return { status: 'rejected', reason: 'unauthenticated' };
      const receipt: SourceReceiptInput = {
        id: randomUUID(),
        sourceInstanceId,
        deliveryId: request.headers['webhook-id'],
        contentDigest: createHash('sha256').update(request.body).digest('hex'),
        receivedAt: request.receivedAt,
        occurredAt: null,
        sourceActor: null,
      };
      let payload: JsonValue;
      try {
        payload = jsonValueSchema.parse(JSON.parse(request.body));
      } catch {
        return {
          status: 'received',
          acceptance: { receipt, outcome: 'malformed', reason: 'invalid_json', bindings: [] },
        };
      }
      const bindings: ResourceStartBindingIntent[] = [];
      const evaluatedBindings: NonNullable<
        Extract<WebhookSourceResult, { status: 'received' }>['acceptance']['evaluatedBindings']
      > = [];
      for (const { inputMapping, ...binding } of config.bindings) {
        const bindingRevision = createHash('sha256')
          .update(JSON.stringify({ ...binding, inputMapping }))
          .digest('hex');
        const mapped = new Map<string, JsonValue>();
        let missing: { input: string; pointer: string } | undefined;
        for (const [input, pointer] of Object.entries(inputMapping)) {
          const value = resolveJsonPointer(payload, pointer);
          if (value === undefined) {
            missing = { input, pointer };
            break;
          }
          mapped.set(input, value);
        }
        if (missing) {
          evaluatedBindings.push({
            bindingId: binding.bindingId,
            bindingRevision,
            status: 'rejected',
            reason: `Input '${missing.input}': pointer ${missing.pointer} did not resolve`,
          });
          continue;
        }
        bindings.push(
          resourceStartBindingIntentSchema.parse({
            ...binding,
            bindingRevision,
            launch: {
              ...binding.launch,
              inputs: { ...binding.launch.inputs, ...Object.fromEntries(mapped) },
            },
          })
        );
      }
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
export default createStandardWebhooksSource;
