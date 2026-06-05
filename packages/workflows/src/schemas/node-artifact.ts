import { z } from '@hono/zod-openapi';

/**
 * Metadata for a node's typed output artifact, written when a node declares
 * `output_type`. Persisted as `nodes/<id>.meta.json` alongside the output file
 * `nodes/<id>.md` inside the run's artifacts dir, so other nodes and later runs
 * can locate a prior output by type instead of guessing filenames.
 *
 * Distinct from `artifactTypeSchema` (the workflow-event artifact kinds:
 * pr/commit/file_created/…) — this describes a node's on-disk output file.
 */
export const nodeArtifactSchema = z.object({
  nodeId: z.string(),
  outputType: z.string().min(1),
  /** Path to the output file, relative to the artifacts dir (e.g. `nodes/plan.md`). */
  path: z.string(),
  runId: z.string(),
  // ISO-8601 timestamp of when the artifact was written. Enforced as a valid
  // datetime so the lexicographic ordering in `latestNodeArtifactOfType` stays
  // correct — a corrupt/non-ISO value is rejected on read (skipped + warned)
  // rather than silently returning the wrong "latest" artifact.
  producedAt: z.string().datetime(),
  /** Byte size (UTF-8) of the output file. */
  size: z.number().int().nonnegative(),
  /** Provider session id that produced the output, when available. */
  sessionId: z.string().optional(),
});

export type NodeArtifact = z.infer<typeof nodeArtifactSchema>;
