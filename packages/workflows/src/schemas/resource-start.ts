import { z } from '@hono/zod-openapi';
import { jsonValueSchema } from '../output-ref';
import { workflowRunOriginSchema } from './workflow-run';

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const preparedIsolationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('in-place') }).strict(),
  z
    .object({
      kind: z.literal('worktree'),
      branch: z.string().min(1).optional(),
      fromBranch: z.string().min(1).optional(),
      baseOverride: z.string().min(1).optional(),
    })
    .strict(),
]);

const preparedRunShape = {
  id: z.string().uuid(),
  workflow_name: z.string().min(1),
  codebase_id: z.string().min(1),
  user_message: z.string(),
  metadata: jsonObjectSchema,
  // Absent for a worktree lane: the checkout exists only once execution starts.
  working_path: z.string().min(1).optional(),
};
// Only what the run row cannot carry: the origin, inputs and sealed run configuration
// already live on `run`.
const preparedExecutionSchema = z
  .object({
    cwd: z.string().min(1),
    conversationId: z.string().min(1),
    isolation: preparedIsolationSchema,
  })
  .strict();

const preparedWorkflowLaunchV2Schema = z
  .object({
    version: z.literal(2),
    run: z.object({ ...preparedRunShape, origin: workflowRunOriginSchema.optional() }).strict(),
    execution: preparedExecutionSchema,
  })
  .strict();

/**
 * Launches written before runs could omit provenance. A queued one stays readable, and
 * its conversation and acting user become the run's origin when it is read.
 */
const preparedWorkflowLaunchV1Schema = z
  .object({
    version: z.literal(1),
    run: z
      .object({
        ...preparedRunShape,
        conversation_id: z.string().min(1),
        user_id: z.string().min(1),
      })
      .strict(),
    execution: preparedExecutionSchema,
  })
  .strict()
  .transform(
    ({ run: { conversation_id, user_id, ...run }, execution }): PreparedWorkflowLaunch => ({
      version: 2,
      run: { ...run, origin: { conversationId: conversation_id, userId: user_id } },
      execution,
    })
  );

/** Reads either stored version; every reader receives version 2. */
export const preparedWorkflowLaunchSchema = z.union([
  preparedWorkflowLaunchV2Schema,
  preparedWorkflowLaunchV1Schema,
]);
export type PreparedWorkflowLaunch = z.infer<typeof preparedWorkflowLaunchV2Schema>;

/** Run metadata key naming the receipt binding that requested a resource start. */
export const RESOURCE_START_METADATA_KEY = 'resource_start';
export interface ResourceStartRunMetadata {
  receiptId: string;
  bindingId: string;
}

/**
 * Resource keys under this prefix are provider-attempt slots owned by core provider
 * admission. An operator-named resource cannot use it, so a trigger resource never
 * shares a slot, or its capacity, with a provider cap.
 */
export const PROVIDER_RESOURCE_PREFIX = 'provider:';

const notProviderResource = {
  check: (name: string): boolean => !name.startsWith(PROVIDER_RESOURCE_PREFIX),
  message: `Resource names starting with '${PROVIDER_RESOURCE_PREFIX}' are reserved for provider admission`,
};

/**
 * How many admitted holders a resource slot allows at once. It defaults to 1, so a
 * resource means "must not overlap" unless configured otherwise. Every binding that
 * names a resource must declare the same capacity; admission refuses a mismatch.
 */
export const resourceSlotCapacitySchema = z.number().int().min(1).default(1);

export const resourceStartIntentSchema = z
  .object({
    resource: z
      .string()
      .trim()
      .min(1)
      .refine(notProviderResource.check, notProviderResource.message),
    capacity: resourceSlotCapacitySchema,
    hostId: z.string().trim().min(1),
    overlap: z.enum(['skip', 'queue']),
    launch: preparedWorkflowLaunchSchema,
    receipt: z
      .object({ receiptId: z.string().uuid(), bindingId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type ResourceStartIntent = z.infer<typeof resourceStartIntentSchema>;

export const resourceStartDispositionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('admitted'),
    requestId: z.string().uuid(),
    runId: z.string().uuid(),
  }),
  z.object({
    status: z.literal('queued'),
    requestId: z.string().uuid(),
    blocker: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('run'), id: z.string().uuid() }),
      z.object({ kind: z.literal('request'), id: z.string().uuid() }),
    ]),
  }),
  z.object({
    status: z.literal('skipped'),
    requestId: z.string().uuid(),
    blocker: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('run'), id: z.string().uuid() }),
      z.object({ kind: z.literal('request'), id: z.string().uuid() }),
    ]),
  }),
]);
export type ResourceStartDisposition = z.infer<typeof resourceStartDispositionSchema>;

export const sourceReceiptInputSchema = z
  .object({
    id: z.string().uuid(),
    sourceInstanceId: z.string().min(1),
    deliveryId: z.string().min(1).nullable(),
    contentDigest: z.string().min(1),
    receivedAt: z.string().datetime(),
    occurredAt: z.string().datetime().nullable(),
    sourceActor: z
      .object({
        source: z.string().min(1),
        id: z.string().min(1),
        display: z.string().min(1).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SourceReceiptInput = z.infer<typeof sourceReceiptInputSchema>;

export const resourceStartBindingIntentSchema = z
  .object({
    bindingId: z.string().min(1),
    bindingRevision: z.string().min(1).nullable(),
    hostId: z.string().min(1),
    runAsUserId: z.string().min(1),
    resource: z.string().min(1).refine(notProviderResource.check, notProviderResource.message),
    capacity: resourceSlotCapacitySchema,
    overlap: z.enum(['skip', 'queue']),
    launch: z
      .object({
        cwd: z.string().min(1),
        workflowName: z.string().min(1),
        inputs: z.record(z.string(), jsonValueSchema),
        discoveryCwd: z.string().min(1).optional(),
        configSource: z.string().min(1).optional(),
        isolation: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('default') }).strict(),
          z.object({ kind: z.literal('in-place') }).strict(),
          z
            .object({
              kind: z.literal('worktree'),
              branch: z.string().min(1).optional(),
              fromBranch: z.string().min(1).optional(),
              baseOverride: z.string().min(1).optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();
export type ResourceStartBindingIntent = z.infer<typeof resourceStartBindingIntentSchema>;

const sourceReceiptAcceptanceBaseSchema = z
  .object({
    receipt: sourceReceiptInputSchema,
    reason: z.string().optional(),
    evaluatedBindings: z
      .array(
        z
          .object({
            bindingId: z.string().min(1),
            bindingRevision: z.string().min(1).nullable(),
            status: z.enum(['unmatched', 'rejected']),
            reason: z.string(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export const sourceReceiptAcceptanceSchema = z
  .discriminatedUnion('outcome', [
    sourceReceiptAcceptanceBaseSchema.extend({
      outcome: z.literal('matched'),
      bindings: z.tuple([resourceStartBindingIntentSchema]).rest(resourceStartBindingIntentSchema),
    }),
    sourceReceiptAcceptanceBaseSchema.extend({
      outcome: z.enum(['unmatched', 'unsupported', 'malformed']),
      bindings: z.tuple([]),
    }),
  ])
  .superRefine((acceptance, context) => {
    const seen = new Set<string>();
    for (const [index, binding] of acceptance.bindings.entries()) {
      if (seen.has(binding.bindingId)) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      }
      seen.add(binding.bindingId);
    }
    for (const [index, binding] of (acceptance.evaluatedBindings ?? []).entries()) {
      if (seen.has(binding.bindingId)) {
        context.addIssue({
          code: 'custom',
          path: ['evaluatedBindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      }
      seen.add(binding.bindingId);
    }
  });
export type SourceReceiptAcceptance = z.infer<typeof sourceReceiptAcceptanceSchema>;
