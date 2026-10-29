import { z } from 'zod';

export const attentionDegradedBaseSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('run_unreadable'),
});

export const attentionDegradedSchema = attentionDegradedBaseSchema.extend({
  runId: z.string().optional(),
});
export type AttentionDegraded = z.infer<typeof attentionDegradedSchema>;
type IdentifiedAttentionDegraded = AttentionDegraded & { runId: string };
export type AttentionRead<T> = T | IdentifiedAttentionDegraded;

export function isAttentionDegraded<T extends object>(
  entry: AttentionRead<T>
): entry is IdentifiedAttentionDegraded {
  return 'type' in entry && entry.type === 'degraded';
}

export function splitAttentionRead<T extends object>(
  entries: readonly AttentionRead<T>[]
): {
  values: T[];
  degraded: IdentifiedAttentionDegraded[];
} {
  const values: T[] = [];
  const degraded: IdentifiedAttentionDegraded[] = [];
  for (const entry of entries) {
    if (isAttentionDegraded(entry)) degraded.push(entry);
    else values.push(entry);
  }
  return { values, degraded };
}

/** Membership is unknown for unreadable rows; project views must not expose their identities. */
export function scopeAttentionDegraded(
  reports: readonly AttentionDegraded[],
  scope: { kind: 'all' | 'project' }
): { degraded?: AttentionDegraded[] } {
  if (reports.length === 0) return {};
  return {
    degraded: reports.map(report =>
      scope.kind === 'all' ? report : { type: report.type, reason: report.reason }
    ),
  };
}
