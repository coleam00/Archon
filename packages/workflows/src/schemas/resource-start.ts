import { z } from 'zod';
import { isJsonPointer } from '../json-pointer';
import { jsonValueSchema } from '../output-ref';
import { ITEM_KEY_MAX_LENGTH, itemKeySchema, workflowRunOriginSchema } from './workflow-run';
import {
  DEFAULT_RESOURCE_CAPACITY,
  declaredCapacitySchema,
  notProviderResource,
  resourceNameSchema,
} from './resource-name';
export {
  DEFAULT_RESOURCE_CAPACITY,
  PROVIDER_RESOURCE_PREFIX,
  resourceNameSchema,
} from './resource-name';

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

export const ADMISSION_CHECKOUT_GUARD_METADATA_KEY = 'admission_checkout_guard';

export class AdmissionCheckoutGuardError extends Error {
  constructor(readonly requestId: string) {
    super(
      `Invalid ${ADMISSION_CHECKOUT_GUARD_METADATA_KEY} for request '${requestId}': expected a boolean`
    );
    this.name = 'AdmissionCheckoutGuardError';
  }
}

/** Older writers did not record the declaration, so their launches remain guarded. */
export function readAdmissionCheckoutGuard(launch: PreparedWorkflowLaunch): boolean {
  const value = launch.run.metadata[ADMISSION_CHECKOUT_GUARD_METADATA_KEY];
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new AdmissionCheckoutGuardError(launch.run.id);
  return value;
}

/** Run metadata key naming the receipt binding that requested a resource start. */
export const RESOURCE_START_METADATA_KEY = 'resource_start';
export const resourceStartReceiptOriginSchema = z
  .object({ receiptId: z.string().uuid(), bindingId: z.string().min(1) })
  .strict();
export type ResourceStartRunMetadata = z.infer<typeof resourceStartReceiptOriginSchema>;

/**
 * The receipt that requested this run's start, from its `resource_start` metadata.
 * Attribution only: a missing or malformed origin reads as no receipt.
 */
export function readResourceStartReceiptId(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const origin = resourceStartReceiptOriginSchema.safeParse(
    metadata?.[RESOURCE_START_METADATA_KEY]
  );
  return origin.success ? origin.data.receiptId : undefined;
}

/**
 * `sourceActor.source` of a receipt that `archon trigger fire` accepted from inside a
 * run: `id` is that run and `display` the node path. Provenance only; the started run
 * still acts as its binding's run-as user.
 */
export const RUN_SOURCE_ACTOR = 'archon-run';

/**
 * `sourceActor.source` of a receipt the end of a run caused (a run-ended binding): `id`
 * is the ended run and `display` the outcome it completed with, when that is not empty.
 */
export const RUN_ENDED_SOURCE_ACTOR = 'archon-run-ended';

/**
 * What caused a start, read from its receipt's source actor: a run that ended, a node
 * that fired, or another source (a schedule, a webhook, an operator's fire).
 */
export const startCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run_ended'), runId: z.string() }),
  z.object({ kind: z.literal('run_fired'), runId: z.string(), node: z.string().nullable() }),
  z.object({ kind: z.literal('receipt'), receiptId: z.string(), sourceInstanceId: z.string() }),
]);
export type StartCause = z.infer<typeof startCauseSchema>;

export function startCause(receipt: {
  id: string;
  sourceInstanceId: string;
  sourceActor: SourceReceiptInput['sourceActor'];
}): StartCause {
  const actor = receipt.sourceActor;
  if (actor?.source === RUN_ENDED_SOURCE_ACTOR) return { kind: 'run_ended', runId: actor.id };
  if (actor?.source === RUN_SOURCE_ACTOR)
    return { kind: 'run_fired', runId: actor.id, node: actor.display ?? null };
  return { kind: 'receipt', receiptId: receipt.id, sourceInstanceId: receipt.sourceInstanceId };
}

/** The run and node that requested a start, or null when the source was not a run. */
export function requestingRun(
  actor: SourceReceiptInput['sourceActor']
): { runId: string; nodePath: string | null } | null {
  return actor?.source === RUN_SOURCE_ACTOR
    ? { runId: actor.id, nodePath: actor.display ?? null }
    : null;
}

/**
 * How many admitted holders a resource slot allows at once, as a start declares it. It
 * defaults to 1, so a resource means "must not overlap" unless configured otherwise. The
 * install config's `concurrency.resources.<resource>` wins at admission.
 */
export const resourceSlotCapacitySchema = declaredCapacitySchema.default(DEFAULT_RESOURCE_CAPACITY);

export const resourceStartOverlapSchema = z.enum(['skip', 'queue']);
export const startBindingPreparationStatusSchema = z.enum([
  'pending',
  'preparing',
  'failed',
  'rejected',
  'unmatched',
  'complete',
]);
export const sourceReceiptOutcomeSchema = z.enum([
  'matched',
  'unmatched',
  'unsupported',
  'malformed',
]);

export const resourceStartIntentSchema = z
  .object({
    resource: resourceNameSchema,
    capacity: resourceSlotCapacitySchema,
    hostId: z.string().trim().min(1),
    overlap: resourceStartOverlapSchema,
    launch: preparedWorkflowLaunchSchema,
    receipt: resourceStartReceiptOriginSchema.optional(),
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
export const resourceStartRequestStatusSchema = z.union([
  ...resourceStartDispositionSchema.options.map(option => option.shape.status),
  z.literal('withdrawn'),
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
    /** The item this start is for. Every run the receipt starts belongs to it. */
    itemKey: itemKeySchema.optional(),
  })
  .strict();
export type SourceReceiptInput = z.infer<typeof sourceReceiptInputSchema>;

/**
 * How a binding names the item its start is on: the value of one field of the start's
 * event, after an optional fixed `prefix`. Data only, no expression; the engine gives the
 * key no meaning. For a source plugin's binding the field is one of the plugin's event
 * fields; for a fire-only trigger file it is a key of the fire's `--inputs`.
 */
export const itemMappingSchema = z
  .object({ field: z.string().min(1), prefix: z.string().min(1).optional() })
  .strict();
export type ItemMapping = z.infer<typeof itemMappingSchema>;

/**
 * The item key `mapping` makes of the field's value: text as it is, a finite number in
 * decimal. Anything else, a missing or empty value included, is refused with a reason
 * that names the field, so a start never falls through to no item.
 */
export function mappedItemKey(
  mapping: ItemMapping,
  value: unknown
): { ok: true; key: string } | { ok: false; reason: string } {
  const field = `field '${mapping.field}'`;
  if (value === undefined || value === null) return { ok: false, reason: `${field} is missing` };
  if (value === '') return { ok: false, reason: `${field} is empty` };
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
    return { ok: false, reason: `${field} is not text or a number` };
  const key = `${mapping.prefix ?? ''}${String(value)}`;
  if (!itemKeySchema.safeParse(key).success)
    return {
      ok: false,
      reason: `${field} makes an item key longer than ${String(ITEM_KEY_MAX_LENGTH)} characters`,
    };
  return { ok: true, key };
}

export const resourceStartBindingIntentSchema = z
  .object({
    bindingId: z.string().min(1),
    bindingRevision: z.string().min(1).nullable(),
    hostId: z.string().min(1),
    runAsUserId: z.string().min(1),
    resource: z.string().min(1).refine(notProviderResource.check, notProviderResource.message),
    /** Omitted, the start takes its workflow's declared capacity, else 1. */
    capacity: declaredCapacitySchema.optional(),
    overlap: resourceStartOverlapSchema,
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
    /**
     * Inputs a source copied from its event, kept apart from the operator's literal
     * `launch.inputs` and overriding them on a name clash. Preparation hands these only to
     * a workflow that declares them, so untrusted event content never fills the
     * passthrough of a workflow without `inputs:`. Operator configs omit this field. The
     * SQL store never writes it into the `intent` column, which older binaries parse
     * strictly; see `storableIntent` in core's start-receipt-writes.
     */
    eventInputs: z.record(z.string(), jsonValueSchema).optional(),
    /**
     * The item a source plugin's binding mapped from its event, for this binding's start
     * only, since one receipt can start several bindings. A receipt that names its own
     * `itemKey` leaves this unset. Like `eventInputs`, the SQL store keeps it out of the
     * `intent` column.
     */
    itemKey: itemKeySchema.optional(),
  })
  .strict();
export type ResourceStartBindingIntent = z.infer<typeof resourceStartBindingIntentSchema>;

/** A receipt binding as stores report it, without any store's own bookkeeping. */
export const startBindingInspectionSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  bindingRevision: z.string().nullable(),
  hostId: z.string().nullable(),
  status: startBindingPreparationStatusSchema,
  ownerId: z.string().nullable(),
  error: z.string().nullable(),
  intent: resourceStartBindingIntentSchema.nullable(),
});

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
            status: startBindingPreparationStatusSchema.extract(['unmatched', 'rejected']),
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
      outcome: sourceReceiptOutcomeSchema.extract(['matched']),
      bindings: z.tuple([resourceStartBindingIntentSchema]).rest(resourceStartBindingIntentSchema),
    }),
    sourceReceiptAcceptanceBaseSchema.extend({
      outcome: sourceReceiptOutcomeSchema.exclude(['matched']),
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
      if (acceptance.receipt.itemKey !== undefined && binding.itemKey !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'itemKey'],
          message: 'A binding names its item only when its receipt names none',
        });
      }
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

/**
 * Where a run-ended binding reads one input of the stage it starts: a JSON Pointer into
 * the ended run's result (its `returns:` node output), or one of the ended run's own
 * inputs by name. Data only: no expression, and nothing here names a workflow.
 */
export const runEndedInputSourceSchema = z.union([
  z.object({ result: z.string().refine(isJsonPointer, 'Invalid JSON Pointer') }).strict(),
  z.object({ input: z.string().min(1) }).strict(),
]);
export type RunEndedInputSource = z.infer<typeof runEndedInputSourceSchema>;

/**
 * `on.runEnded` of a trigger file: the binding starts when a run of `workflowName`
 * completes with `outcome` on an item, in the project the binding launches in.
 */
export const runEndedTriggerSchema = z
  .object({
    workflowName: z.string().min(1),
    outcome: z.string(),
    inputs: z.record(z.string().min(1), runEndedInputSourceSchema).optional(),
  })
  .strict();
export type RunEndedTrigger = z.infer<typeof runEndedTriggerSchema>;

/**
 * A trigger file: the binding, and what starts it. With `schedule` a clock fires it; with
 * `on.runEnded` the end of a run does; with neither it is fire-only, and nothing but
 * `trigger fire` starts it. A `schedule` or `on` that is present must be complete, so a
 * half-written one is never fire-only.
 *
 * `item` names a fire-only binding's item from a field of the fire's `--inputs`. It sits
 * beside `binding`, not in it, because the launch intent is what the store persists. A
 * timer tick and a run's end are about no event the file could map.
 */
export const triggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    binding: resourceStartBindingIntentSchema.omit({ eventInputs: true, itemKey: true }),
    item: itemMappingSchema.optional(),
    schedule: z
      .object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() })
      .strict()
      .optional(),
    on: z.object({ runEnded: runEndedTriggerSchema }).strict().optional(),
  })
  .strict()
  .refine(config => config.schedule === undefined || config.on === undefined, {
    message: 'A trigger has either a schedule or on.runEnded, not both',
    path: ['on'],
  })
  .refine(config => config.item === undefined || config.schedule === undefined, {
    message: 'A timer binding maps no item: a tick is about no item',
    path: ['item'],
  })
  .refine(config => config.item === undefined || config.on === undefined, {
    message: "A run-ended binding maps no item: its start is on the ended run's item",
    path: ['item'],
  });
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
