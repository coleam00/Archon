/**
 * Per-node failure diagnostics captured in run records and workflow events.
 */
import { z } from '@hono/zod-openapi';

export const nodeFailureDetailSchema = z.object({
  node: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  error: z.string(),
  stderr: z.string().optional(),
  retry_count: z.number().int().nonnegative(),
  /** Set when execution was blocked by a per-run model circuit breaker. */
  circuit_breaker: z.boolean().optional(),
  /** Provider/model path used after primary failure or breaker open. */
  fallback_model: z.string().optional(),
});

export type NodeFailureDetail = z.infer<typeof nodeFailureDetailSchema>;

/** Metadata key on workflow runs — array of per-node failure records. */
export const WORKFLOW_RUN_NODE_FAILURES_KEY = 'node_failures';

export function readNodeFailuresFromMetadata(
  metadata: Record<string, unknown> | undefined
): NodeFailureDetail[] {
  if (!metadata) return [];
  const raw = metadata[WORKFLOW_RUN_NODE_FAILURES_KEY];
  if (!Array.isArray(raw)) return [];
  const parsed: NodeFailureDetail[] = [];
  for (const item of raw) {
    const result = nodeFailureDetailSchema.safeParse(item);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}
