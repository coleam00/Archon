import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseProcessOwner } from '@archon/paths/process-owner';
import {
  preparedWorkflowLaunchSchema,
  resourceStartOverlapSchema,
  resourceStartRequestStatusSchema,
  startBindingPreparationStatusSchema,
  sourceReceiptOutcomeSchema,
  resourceStartBindingIntentSchema,
  resourceStartDispositionSchema,
  sourceReceiptInputSchema,
} from '../schemas/resource-start';

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
export const requestSchema = z.object({
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
export const bindingSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  bindingRevision: z.string().nullable(),
  hostId: z.string().nullable(),
  status: startBindingPreparationStatusSchema,
  ownerId: z.string().nullable(),
  error: z.string().nullable(),
  intent: resourceStartBindingIntentSchema.nullable(),
  requestIds: z.array(z.string()),
});
export const bindingInspectionSchema = bindingSchema.omit({ requestIds: true });
export const receiptFieldsSchema = sourceReceiptInputSchema.strip();
export const receiptSchema = sourceReceiptInputSchema.extend({
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
