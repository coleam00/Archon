import { z } from 'zod';
import { isJsonPointer } from '../json-pointer';
import { jsonValueSchema } from '../output-ref';
import {
  asksSettledInputSourceSchema,
  entryReadsNeedLinkedItems,
  linkedReadsNoItemAnswers,
  runEndedInputSourceSchema,
} from './binding-input-source';
import { itemLinkKindSchema } from './item-link';
import { handoffRefusalSchema } from './run-metadata';
import { attentionOptionSchema } from './wait-node';
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

/** The receipt and binding that requested this run's start, from its `resource_start` metadata. */
export function readResourceStartOrigin(
  metadata: Readonly<Record<string, unknown>> | undefined
): ResourceStartRunMetadata | undefined {
  const origin = resourceStartReceiptOriginSchema.safeParse(
    metadata?.[RESOURCE_START_METADATA_KEY]
  );
  return origin.success ? origin.data : undefined;
}

/**
 * The receipt that requested this run's start, from its `resource_start` metadata.
 * Attribution only: a missing or malformed origin reads as no receipt.
 */
export function readResourceStartReceiptId(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  return readResourceStartOrigin(metadata)?.receiptId;
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
 * `sourceActor.source` of a receipt the settlement of a run's asks caused (an
 * asks-settled binding): `id` is the run that left the asks and `display` how the set
 * settled, `answered` or `withdrawn`.
 */
export const ASKS_SETTLED_SOURCE_ACTOR = 'archon-asks-settled';

/**
 * What caused a start, read from its receipt's source actor: a run that ended, the asks a
 * run left settling, a node that fired, or another source (a schedule, a webhook, an
 * operator's fire).
 */
export const startCauseSchema = z.discriminatedUnion('kind', [
  /** `sourceInstanceId` is the run-ended arrow that started the run (see `pack-graph`). */
  z.object({ kind: z.literal('run_ended'), runId: z.string(), sourceInstanceId: z.string() }),
  z.object({ kind: z.literal('asks_settled'), runId: z.string() }),
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
  if (actor?.source === RUN_ENDED_SOURCE_ACTOR)
    return { kind: 'run_ended', runId: actor.id, sourceInstanceId: receipt.sourceInstanceId };
  if (actor?.source === ASKS_SETTLED_SOURCE_ACTOR) return { kind: 'asks_settled', runId: actor.id };
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

/** What a queued or skipped start waits behind: a run holding the slot, or a request ahead. */
const resourceBlockerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), id: z.string().uuid() }),
  z.object({ kind: z.literal('request'), id: z.string().uuid() }),
]);

export const resourceStartDispositionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('admitted'),
    requestId: z.string().uuid(),
    runId: z.string().uuid(),
  }),
  z.object({
    status: z.literal('queued'),
    requestId: z.string().uuid(),
    blocker: resourceBlockerSchema,
  }),
  z.object({
    status: z.literal('skipped'),
    requestId: z.string().uuid(),
    blocker: resourceBlockerSchema,
  }),
]);
/**
 * A start on an item still waiting for capacity, as the item read lists it. What it waits
 * behind is `ahead`: the queued starts of the same resource and host with an earlier queue
 * position, read when the item is read; at 0 it waits for a free slot on `resource`. A drain
 * admits one host's requests in queue order. It is queue order, not a promise; a start whose
 * checkout is held is passed over. The blocker a request recorded when it queued is not
 * listed: drains do not refresh it, so it soon names a start that has ended.
 * `workflow` is null when the stored launch does not read.
 */
export const queuedItemStartSchema = z.object({
  requestId: z.string(),
  workflow: z.string().nullable(),
  resource: z.string(),
  hostId: z.string(),
  queuedAt: z.string().datetime(),
  ahead: z.number().int().nonnegative(),
  /**
   * The first request queued ahead of it whose stored launch does not read, or null: admission
   * keeps queue order, so nothing behind that request is admitted until it is withdrawn.
   */
  blockedBy: z.string().nullable(),
});
export type QueuedItemStart = z.infer<typeof queuedItemStartSchema>;

/**
 * The install hold: while it is set, admission admits no new run from any source, and
 * every start it holds back waits for the lift. `setBy` is the CLI identity that set it.
 */
export const installHoldSchema = z.object({
  setBy: z.string(),
  setAt: z.string().datetime(),
});
export type InstallHold = z.infer<typeof installHoldSchema>;

export function describeInstallHold(hold: InstallHold): string {
  return `set by ${hold.setBy} at ${hold.setAt}`;
}

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

/**
 * A checkout one run hands the next: `branch` at `commit`, kept in the estate of run
 * `runId`. That is the ended run, or, when the ended run worked on a copy, the run the
 * copy was taken from, so a check's end hands on the build's branch and not its own.
 */
export const checkoutHandoffSchema = z
  .object({
    runId: z.string().min(1),
    branch: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/, 'Expected a full commit id'),
  })
  .strict();
export type CheckoutHandoff = z.infer<typeof checkoutHandoffSchema>;

/** The checkout a run left when it ended, read for a binding that takes it: the hand-off, or why there is none. */
export const endedCheckoutSchema = z.union([
  z.object({ handoff: checkoutHandoffSchema }).strict(),
  z.object({ refused: z.string().min(1) }).strict(),
]);
export type EndedCheckout = z.infer<typeof endedCheckoutSchema>;

/**
 * Run metadata key of a run started on a hand-off, and the lane it got: `continue` works
 * on the hand-off's branch (a stage that mutates its checkout), `copy` works in a checkout
 * of its own cut at the hand-off's commit (a stage with `mutates_checkout: false`).
 */
export const CHECKOUT_HANDOFF_METADATA_KEY = 'checkout_handoff';
export const checkoutHandoffRunMetadataSchema = checkoutHandoffSchema
  .extend({ lane: z.enum(['continue', 'copy']) })
  .strict();
export type CheckoutHandoffRunMetadata = z.infer<typeof checkoutHandoffRunMetadataSchema>;

/**
 * The hand-off a run was started on, or undefined when it was not. A value that does not
 * parse throws: reading it as no hand-off would start the run somewhere it was not given.
 */
export function readCheckoutHandoff(run: {
  id: string;
  metadata: Readonly<Record<string, unknown>> | null | undefined;
}): CheckoutHandoffRunMetadata | undefined {
  const value = run.metadata?.[CHECKOUT_HANDOFF_METADATA_KEY];
  if (value === undefined) return undefined;
  const parsed = checkoutHandoffRunMetadataSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Run '${run.id}' has an invalid ${CHECKOUT_HANDOFF_METADATA_KEY}`);
  return parsed.data;
}

/**
 * Run metadata key of a run that completed leaving asks while an asks-settled binding
 * with `checkout: "asking-run"` matched it: the checkout it left, read at completion, and
 * the worktree that holds it (the run's own, or for a run that worked on a copy, the one
 * its source left). The settling transaction and the started run's execution each refuse
 * the hand-off when that worktree is gone, so the checkout is never recreated.
 */
export const ASKS_CHECKOUT_METADATA_KEY = 'asks_checkout';

export const asksCheckoutSchema = z.union([
  z.object({ handoff: checkoutHandoffSchema, worktree: z.string().min(1) }).strict(),
  z.object({ refused: z.string().min(1) }).strict(),
]);
export type AsksCheckout = z.infer<typeof asksCheckoutSchema>;

/** The metadata that records an asking run's checkout. */
export function asksCheckoutMetadata(checkout: AsksCheckout): Record<string, AsksCheckout> {
  return { [ASKS_CHECKOUT_METADATA_KEY]: checkout };
}

/**
 * The checkout an asking run recorded, or undefined when it recorded none. A value that
 * does not parse reads as a refusal, not a throw: this runs inside the transaction that
 * closes an ask, and a throw there would refuse the operator's answer.
 */
export function readAsksCheckout(run: {
  id: string;
  metadata: Readonly<Record<string, unknown>>;
}): AsksCheckout | undefined {
  const value = run.metadata[ASKS_CHECKOUT_METADATA_KEY];
  if (value === undefined) return undefined;
  const parsed = asksCheckoutSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : { refused: `run '${run.id}' has an invalid recorded ${ASKS_CHECKOUT_METADATA_KEY}` };
}

/** See `wake` on `resourceStartBindingIntentSchema`. */
export const bindingWakeSchema = z
  .object({
    workflowName: z.string().min(1),
    wait: z.string().min(1),
    about: z.string().min(1),
    input: z.string().min(1).optional(),
  })
  .strict();
export type BindingWake = z.infer<typeof bindingWakeSchema>;

/**
 * `limit` on a binding: how many starts it may make on one item, counted under `name`.
 * Only admitted starts and queued ones (a reserved start) count; a skipped, refused or
 * withdrawn start does not. Every file of one pack binding shares the name, so they share
 * one count. When a run of `resetOn` completes on the item the count starts again; without
 * it the count never resets by itself. An asks-settled binding that `grants` the name
 * allows one more start on that item each time it starts.
 */
export const startLimitSchema = z
  .object({
    name: z.string().min(1),
    starts: z.number().int().positive(),
    resetOn: z.string().min(1).optional(),
  })
  .strict();
export type StartLimit = z.infer<typeof startLimitSchema>;

export const resourceStartBindingIntentSchema = z
  .object({
    bindingId: z.string().min(1),
    bindingRevision: z.string().min(1).nullable(),
    hostId: z.string().min(1),
    runAsUserId: z.string().min(1),
    /**
     * The title a start from this binding records, shown as the run's message in the console
     * and as `user_message` wherever a run is read. Annotation only: a binding's message is
     * read by nothing that admits, queues or receipts a start, so setting one cannot change
     * whether or where a run starts.
     */
    message: z.string().min(1).optional(),
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
    /**
     * The checkout a run-ended binding with `checkout: "ended-run"` or an asks-settled
     * binding with `checkout: "asking-run"` hands the started run, recorded when the ended
     * or asking run completed. Preparation decides the lane from it, not from
     * `launch.isolation`, which names the branch only for older binaries. Operator configs
     * omit this field. The SQL store never writes it into the `intent` column; see
     * `storableIntent` in core's start-receipt-writes.
     */
    checkoutFrom: checkoutHandoffSchema.optional(),
    /**
     * A source plugin's binding that wakes waiting work: the open wait `wait` a run of
     * `workflowName` left, on an item of the project this binding launches in, whose `about`
     * is exactly this `about`. With `itemKey`, the item the event names, only a wait on that
     * item matches; an event that names its subject (a review names its pull request) must
     * set it, so another subject at the same commit wakes nothing here. The store resolves
     * the wake when it accepts the receipt, in the same transaction: a match closes the set
     * as met and the binding starts on the wait's item, with the met wait as event input
     * `input` when set; anything else is recorded as not started, with why. It never
     * reaches the `intent` column.
     */
    wake: bindingWakeSchema.optional(),
    /**
     * How many times this binding may start its stage on one item; see `startLimitSchema`.
     * A binding without it starts as often as it matches. Admission counts and refuses, in
     * the transaction that admits. The SQL store keeps it out of the `intent` column, which
     * older binaries parse strictly; see `storableIntent` in core's start-receipt-writes.
     */
    limit: startLimitSchema.optional(),
    /**
     * The name of a `limit` this binding's start raises by one on its item, once the start
     * is admitted. Only an asks-settled binding grants: the answer that settles the asks is
     * how an operator allows one more round. Kept out of the `intent` column like `limit`.
     */
    grants: z.string().min(1).optional(),
  })
  .strict();
export type ResourceStartBindingIntent = z.infer<typeof resourceStartBindingIntentSchema>;

/**
 * A binding refused at start because its pack's forge needs cannot be met: the pack and
 * each remote's reason and remedy. Older binaries read this stored shape, so `reason` is a
 * string, not the engine's union, and unknown keys are stripped rather than refused.
 */
const forgeRefusalFailureSchema = z.object({
  /** The git remote's name, never its URL: a URL can carry a credential. */
  remote: z.string().optional(),
  reason: z.string(),
  message: z.string(),
  /** The declared capabilities the plugin does not advertise. */
  unsupported: z.array(z.string()).readonly().optional(),
  /** The operator's next step, from the plugin or forge, or the engine's own. */
  remedy: z.string().optional(),
});
export type ForgeRefusalFailure = z.infer<typeof forgeRefusalFailureSchema>;

export const forgeRefusalSchema = z.object({
  pack: z.string(),
  failures: z.array(forgeRefusalFailureSchema).readonly(),
});
export type ForgeRefusal = z.infer<typeof forgeRefusalSchema>;

/** A receipt binding as stores report it, without any store's own bookkeeping. */
export const startBindingInspectionSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  bindingRevision: z.string().nullable(),
  hostId: z.string().nullable(),
  status: startBindingPreparationStatusSchema,
  ownerId: z.string().nullable(),
  error: z.string().nullable(),
  forgeRefusal: forgeRefusalSchema.nullable().default(null),
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
            refused: handoffRefusalSchema.optional(),
            /** The item the binding maps the event to, when it got that far before refusing. */
            itemKey: z.string().min(1).optional(),
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
      if (binding.wake !== undefined && acceptance.receipt.itemKey !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'wake'],
          message: 'A binding that wakes a wait names its item on the binding, not the receipt',
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
 * `on.runEnded.linked`: the stage starts on the items the ended run's item is linked to
 * (the holders), not on that item. `kind` names the link and `holder` the end of it the
 * started item is on; the ended run's item is on the other end. An order whose members are
 * `part_of` it uses `holder: 'to'`; an item that `depends_on` another uses
 * `holder: 'from'`. The engine gives the kind no meaning: the file names both the kind and
 * the end. Only links active when the run completes count. Without `items` every holder
 * starts, with the same inputs. `items` points into the ended run's result at a list of
 * item keys or objects with a string `key`; only those holders start, each reading its own
 * entry through `{ entry: <pointer> }` (see `namedLinkedStart` in core for the refusals).
 */
export const runEndedLinkedSchema = z
  .object({
    kind: itemLinkKindSchema,
    holder: z.enum(['from', 'to']),
    items: z.string().refine(isJsonPointer, 'Invalid JSON Pointer').optional(),
  })
  .strict();
export type RunEndedLinked = z.infer<typeof runEndedLinkedSchema>;

/**
 * The ended run's checkout is its own item's work, not the holder's. A pack's run-ended
 * binding applies the same rule to its `run_ended:`.
 */
export const linkedTakesNoCheckout = {
  check: (trigger: { linked?: unknown; checkout?: unknown }): boolean =>
    trigger.linked === undefined || trigger.checkout === undefined,
  message: {
    message: 'A linked start takes no checkout: the ended run left it for its own item',
    path: ['checkout'],
  },
};

/**
 * `on.runEnded` of a trigger file: the binding starts when a run of `workflowName`
 * completes with `outcome` on an item, in the project the binding launches in. Without
 * `linked`, the stage starts on the same item.
 */
export const runEndedTriggerSchema = z
  .object({
    workflowName: z.string().min(1),
    outcome: z.string(),
    inputs: z.record(z.string().min(1), runEndedInputSourceSchema).optional(),
    /**
     * `ended-run`: the started run works in the checkout the ended run left, on its branch
     * at the commit it ended on, or is refused naming why.
     */
    checkout: z.literal('ended-run').optional(),
    linked: runEndedLinkedSchema.optional(),
  })
  .strict()
  .refine(linkedTakesNoCheckout.check, linkedTakesNoCheckout.message)
  .refine(linkedReadsNoItemAnswers.check, linkedReadsNoItemAnswers.message)
  .refine(entryReadsNeedLinkedItems.check, entryReadsNeedLinkedItems.message);
export type RunEndedTrigger = z.infer<typeof runEndedTriggerSchema>;

/**
 * A linked run-ended start, as the completing write resolves it. Which items hold an
 * active link to the ended run's item can only be read exactly inside the transaction
 * that completes the run.
 *
 * Without `linked.items`, every holder starts: `acceptance` is the receipt for the ended
 * run, and the store sets its `id`, `itemKey` and `deliveryId` per holder. With it,
 * `named` lists the items the run named, each with its own `acceptance` (the store sets
 * its `id` and `deliveryId`) and the prebuilt `unlinked` refusal on the ended run's item
 * that the store writes instead when that item holds no such link.
 */
export type LinkedRunEndedStart = {
  link: RunEndedLinked;
  endedRunId: string;
  endedItemId: string;
} & (
  | { acceptance: SourceReceiptAcceptance }
  | {
      named: readonly {
        key: string;
        acceptance: SourceReceiptAcceptance;
        unlinked: SourceReceiptAcceptance;
      }[];
    }
);

/**
 * `on.asksSettled` of a trigger file: the binding starts when the asks a run of
 * `workflowName` left on an item are settled, in the project the binding launches in.
 * `answered` matches a set with at least one answer, `withdrawn` one whose every ask was
 * withdrawn, `any` either.
 *
 * `option` narrows `answered` to a set whose every answered ask chose that option id, as
 * `chosenAskOption` reads it; withdrawn asks are not counted. A mixed set, or an answer
 * that chose no offered option, matches no binding with `option`. Only the id is compared,
 * never answer text, as `runEnded.outcome` compares the ended run's outcome.
 */
export const asksSettledTriggerSchema = z
  .object({
    workflowName: z.string().min(1),
    settled: z.enum(['answered', 'withdrawn', 'any']),
    option: attentionOptionSchema.shape.id.optional(),
    inputs: z.record(z.string().min(1), asksSettledInputSourceSchema).optional(),
    /**
     * `asking-run`: the started run works in the checkout the asking run left, on its
     * branch at the commit it ended on, or is refused naming why. The checkout is read
     * when the asking run completes, not when its asks settle.
     */
    checkout: z.literal('asking-run').optional(),
  })
  .strict()
  // A withdrawn ask chose nothing, so an option can only select among answers.
  .refine(trigger => trigger.option === undefined || trigger.settled === 'answered', {
    message: 'option selects on an answer, so it takes settled: answered',
    path: ['option'],
  });
export type AsksSettledTrigger = z.infer<typeof asksSettledTriggerSchema>;

/**
 * A trigger file: the binding, and what starts it. With `schedule` a clock fires it; with
 * `on` the end of a run (`runEnded`) or the settling of a run's asks (`asksSettled`) does,
 * exactly one of them; with neither it is fire-only, and nothing but `trigger fire` starts
 * it. A `schedule` or `on` that is present must be complete, so a half-written one is
 * never fire-only.
 *
 * `item` names a fire-only binding's item from a field of the fire's `--inputs`. It sits
 * beside `binding`, not in it, because the launch intent is what the store persists. A
 * timer tick, a run's end and a settled set are about no event the file could map.
 */
export const triggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    binding: resourceStartBindingIntentSchema.omit({
      eventInputs: true,
      checkoutFrom: true,
      itemKey: true,
      wake: true,
    }),
    item: itemMappingSchema.optional(),
    schedule: z
      .object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() })
      .strict()
      .optional(),
    on: z
      .object({
        runEnded: runEndedTriggerSchema.optional(),
        asksSettled: asksSettledTriggerSchema.optional(),
      })
      .strict()
      .refine(on => (on.runEnded === undefined) !== (on.asksSettled === undefined), {
        message: 'on has exactly one of runEnded or asksSettled',
      })
      .optional(),
  })
  .strict()
  .refine(config => config.schedule === undefined || config.on === undefined, {
    message: 'A trigger has either a schedule or on, not both',
    path: ['on'],
  })
  .refine(config => config.item === undefined || config.schedule === undefined, {
    message: 'A timer binding maps no item: a tick is about no item',
    path: ['item'],
  })
  .refine(config => config.item === undefined || config.on === undefined, {
    message: 'An on binding maps no item: its start is on the item of the run its event names',
    path: ['item'],
  })
  .refine(config => config.binding.grants === undefined || config.on?.asksSettled !== undefined, {
    message: 'Only an asks-settled binding grants: an answer is how an operator allows one more',
    path: ['binding', 'grants'],
  })
  // The engine picks the lane of a start on another run's checkout; a fixed one here
  // would contradict it.
  .superRefine((config, context) => {
    const field =
      config.on?.runEnded?.checkout !== undefined
        ? 'on.runEnded.checkout'
        : config.on?.asksSettled?.checkout !== undefined
          ? 'on.asksSettled.checkout'
          : undefined;
    if (field !== undefined && config.binding.launch.isolation.kind !== 'default')
      context.addIssue({
        code: 'custom',
        message: `With ${field}, binding.launch.isolation must be { "kind": "default" }`,
        path: ['binding', 'launch', 'isolation'],
      });
  });
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;
