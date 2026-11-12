import { z } from 'zod';
import { resourceStartDispositionSchema, sourceReceiptInputSchema } from './schemas/resource-start';
import type {
  ResourceStartRequestInspection,
  StartReceiptInspection,
} from './resource-start-store';

export const skippedStartFactsSchema = z.object({
  requestId: z.string(),
  receiptId: z.string(),
  bindingId: z.string(),
  resource: z.string(),
  overlap: z.literal('skip'),
  blocker: resourceStartDispositionSchema.options[1].shape.blocker,
  deliveryId: sourceReceiptInputSchema.shape.deliveryId,
  receivedAt: sourceReceiptInputSchema.shape.receivedAt,
  sourceActor: sourceReceiptInputSchema.shape.sourceActor,
  codebaseId: z.string(),
  cwd: z.string(),
});
export type SkippedStartFacts = z.infer<typeof skippedStartFactsSchema>;

export function skippedStartFacts(
  request: Pick<
    ResourceStartRequestInspection,
    'id' | 'status' | 'resource' | 'overlap' | 'blocker' | 'launch'
  >,
  receipt: Pick<StartReceiptInspection, 'id' | 'deliveryId' | 'receivedAt' | 'sourceActor'>,
  bindingId: string
): SkippedStartFacts | null {
  if (request.status !== 'skipped') return null;
  return skippedStartFactsSchema.parse({
    requestId: request.id,
    receiptId: receipt.id,
    bindingId,
    resource: request.resource,
    overlap: request.overlap,
    blocker: request.blocker,
    deliveryId: receipt.deliveryId,
    receivedAt: receipt.receivedAt,
    sourceActor: receipt.sourceActor,
    codebaseId: request.launch.run.codebase_id,
    cwd: request.launch.execution.cwd,
  });
}
