import { z } from 'zod';
import { resourceStartDispositionSchema } from './schemas/resource-start';
import type { ResourceStartRequestInspection } from './resource-start-store';

export const skippedStartFactsSchema = z.object({
  requestId: z.string(),
  bindingId: z.string(),
  blocker: resourceStartDispositionSchema.options[1].shape.blocker,
});
export type SkippedStartFacts = z.infer<typeof skippedStartFactsSchema>;

export function skippedStartFacts(
  request: Pick<ResourceStartRequestInspection, 'id' | 'status' | 'blocker'>,
  bindingId: string
): SkippedStartFacts | null {
  if (request.status !== 'skipped') return null;
  return skippedStartFactsSchema.parse({
    requestId: request.id,
    bindingId,
    blocker: request.blocker,
  });
}
