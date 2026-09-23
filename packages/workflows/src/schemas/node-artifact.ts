import { z } from '@hono/zod-openapi';

/** One enclosing loop_group execution frame for a typed body artifact. */
export const nodeArtifactLoopFrameSchema = z.object({
  groupId: z.string().min(1),
  iteration: z.number().int().positive(),
});

export type NodeArtifactLoopFrame = z.infer<typeof nodeArtifactLoopFrameSchema>;

/**
 * Metadata for a node's typed output artifact, written when a node declares
 * `output_type`. Top-level nodes persist as `nodes/<id>.meta.json` alongside
 * `nodes/<id>.md`; loop_group body executions qualify both names with their
 * ordered loop frames. Other nodes and later runs can locate prior output by
 * type instead of guessing filenames.
 *
 * Distinct from `artifactTypeSchema` (the workflow-event artifact kinds:
 * pr/commit/file_created/…) — this describes a node's on-disk output file.
 */
export const nodeArtifactSchema = z.object({
  nodeId: z.string(),
  outputType: z.string().min(1),
  /** Ordered outermost-to-innermost lineage for a loop_group body execution. */
  loopGroupPath: z.array(nodeArtifactLoopFrameSchema).min(1).optional(),
  /** Path to the output file, relative to the artifacts dir (e.g. `nodes/plan.md`). */
  path: z.string(),
  runId: z.string(),
  // ISO-8601 timestamp of when the artifact was written. A corrupt/non-ISO value
  // is rejected on read (reported as an error) rather than silently returning the
  // wrong "latest" artifact.
  producedAt: z.string().datetime(),
  /** Byte size (UTF-8) of the output file. */
  size: z.number().int().nonnegative(),
  /** Provider session id that produced the output, when available. */
  sessionId: z.string().optional(),
});

export type NodeArtifact = z.infer<typeof nodeArtifactSchema>;

/**
 * One record of a typed-artifact read that could not yield a usable artifact.
 *
 * `path` is relative to the artifacts dir and uses `/` on every platform, so the
 * record survives being handed to a container or a report unchanged. It names the
 * sidecar involved, or the `nodes/` directory itself for a directory fault.
 */
export const nodeArtifactReadErrorSchema = z.object({
  path: z.string(),
  kind: z.enum([
    'unreadable_directory',
    'unreadable_metadata',
    'invalid_metadata',
    'foreign_run',
    'unsafe_path',
    'missing_content',
    'unreadable_content',
  ]),
  /** Machine error code (ENOENT/EACCES/…) when the fault came from the filesystem. */
  code: z.string().optional(),
});

export type NodeArtifactReadError = z.infer<typeof nodeArtifactReadErrorSchema>;

/**
 * What one typed-artifact read observed: every readable artifact grouped by its
 * exact, case-sensitive `outputType`, plus every record that could not be used.
 *
 * A corrupt or foreign sidecar is never silently dropped — it has no trustworthy
 * type to group under, so it stays visible in `errors` for every selection.
 */
export const nodeArtifactReadResultSchema = z.object({
  artifactsByType: z.record(z.string(), z.array(nodeArtifactSchema)),
  errors: z.array(nodeArtifactReadErrorSchema),
});

export type NodeArtifactReadResult = z.infer<typeof nodeArtifactReadResultSchema>;

/**
 * The on-disk delivery envelope for a per-invocation typed-artifact listing.
 * `runId` identifies the run whose artifacts the listing observed, so a consumer
 * that has `$WORKFLOW_ID` can reject a listing handed to it out of scope.
 */
export const nodeArtifactsListingSchema = nodeArtifactReadResultSchema.extend({
  runId: z.string(),
});

export type NodeArtifactsListing = z.infer<typeof nodeArtifactsListingSchema>;
