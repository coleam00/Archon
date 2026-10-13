import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
  WebhookSourceRequest,
  WebhookSourceResult,
} from '@archon/workflows/webhook-source-plugin';

function isJsonPointer(pointer: string): boolean {
  return (pointer === '' || pointer.startsWith('/')) && !/~(?:[^01]|$)/.test(pointer);
}

function resolveJsonPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (!isJsonPointer(pointer)) return undefined;
  if (pointer === '') return value;
  let current: JsonValue | undefined = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = current[key];
    } else return undefined;
  }
  return current;
}

function decodeSigningSecret(secret: string | undefined): Buffer {
  const encoded = secret?.startsWith('whsec_') ? secret.slice(6) : '';
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded)
    throw new Error('Standard Webhooks signing secret must be whsec_ followed by valid base64');
  return decoded;
}

function verifySignature(request: WebhookSourceRequest, secret: Buffer): boolean {
  const id = request.headers['webhook-id'];
  const timestamp = request.headers['webhook-timestamp'];
  const signatures = request.headers['webhook-signature'];
  if (!id || !timestamp || !signatures || !/^[0-9]+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  const received = Date.parse(request.receivedAt) / 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(received) ||
    Math.abs(received - seconds) > 300
  )
    return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${id}.${timestamp}.${request.body}`).digest('base64')
  );
  return signatures.split(' ').some(entry => {
    if (!entry.startsWith('v1,')) return false;
    const candidate = Buffer.from(entry.slice(3));
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

const bindingSchema = resourceStartBindingIntentSchema
  .omit({ bindingRevision: true, eventInputs: true })
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
            eventInputs: Object.fromEntries(mapped),
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
