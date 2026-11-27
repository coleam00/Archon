import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseProcessOwner } from '@archon/paths/process-owner';
import {
  preparedWorkflowLaunchSchema,
  resourceStartOverlapSchema,
  resourceStartRequestStatusSchema,
  startBindingInspectionSchema,
  sourceReceiptOutcomeSchema,
  resourceStartDispositionSchema,
  sourceReceiptInputSchema,
} from '../schemas/resource-start';
import { startOverridesSchema } from '../schemas/start-overrides';

export const slotMembershipSchema = z.object({
  holders: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('run'), id: z.string() }),
      z.object({ kind: z.literal('attempt'), id: z.string(), owner: z.unknown().optional() }),
    ])
  ),
  // Checkout membership survives giving back capacity while paused.
  admitted: z.array(z.string()).default([]),
});

export function hasReadableSlotMembership(raw: unknown, id: string): boolean {
  const admitted = slotMembershipSchema.pick({ admitted: true }).safeParse(raw);
  const holders = slotMembershipSchema.pick({ holders: true }).safeParse(raw);
  return (
    (admitted.success && admitted.data.admitted.includes(id)) ||
    (holders.success &&
      holders.data.holders.some(holder => holder.kind === 'run' && holder.id === id))
  );
}

/** `source` names the slot document in a malformed attempt owner's error. */
export const slotSchema = (source: string) =>
  slotMembershipSchema.extend({
    capacity: z.number().int().positive(),
    holders: slotMembershipSchema.shape.holders.transform(holders =>
      holders.map(holder =>
        holder.kind === 'attempt'
          ? { ...holder, owner: parseProcessOwner(holder.owner, source) }
          : holder
      )
    ),
    queue: z.array(z.string()),
  });
// The file store writes requests and receipts back from their parsed value, so both keep
// keys a newer binary added.
export const requestSchema = z.looseObject({
  id: z.string(),
  resource: z.string(),
  hostId: z.string(),
  overlap: resourceStartOverlapSchema,
  status: resourceStartRequestStatusSchema,
  blocker: resourceStartDispositionSchema.options[1].shape.blocker.nullable(),
  launch: preparedWorkflowLaunchSchema,
  position: z.number().int().nonnegative(),
});
export function queuedRequestSchema(id: string, slotPath: string) {
  return requestSchema.refine(
    row =>
      row.id === id &&
      row.launch.run.id === id &&
      row.status === 'queued' &&
      pathFor('slots', row.resource) === slotPath,
    { message: `Queued resource request '${id}' does not belong to resource slot '${slotPath}'` }
  );
}
export const requestEnvelopeSchema = requestSchema.pick({ resource: true, status: true }).extend({
  status: z.literal('admitted'),
  launch: z.unknown(),
});
/**
 * The overrides sit beside the intent, as the SQL store keeps them in their own column: the
 * intent is parsed strictly by an older binary sharing this directory, so a key it does not
 * know would make the whole receipt unreadable there. A binding-level key is dropped instead.
 */
export const bindingSchema = startBindingInspectionSchema.extend({
  requestIds: z.array(z.string()),
  startOverrides: startOverridesSchema.nullable().default(null),
});
export const receiptFieldsSchema = sourceReceiptInputSchema.strip();
export const receiptSchema = sourceReceiptInputSchema.loose().extend({
  sourceActor: sourceReceiptInputSchema.shape.sourceActor.unwrap().loose().nullable(),
  outcome: sourceReceiptOutcomeSchema,
  reason: z.string().nullable(),
  bindings: z.array(bindingSchema),
  createdAt: z.string(),
});
export type Request = z.infer<typeof requestSchema>;
export const pathFor = (kind: string, key: string): string =>
  `resource/${kind}/${createHash('sha256').update(key).digest('hex')}.json`;
export const deliveryPathFor = (sourceInstanceId: string, deliveryId: string): string =>
  pathFor('deliveries', JSON.stringify([sourceInstanceId, deliveryId]));
export type Slot = z.infer<ReturnType<typeof slotSchema>>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Binding = z.infer<typeof bindingSchema>;
