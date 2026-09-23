import { z } from '@hono/zod-openapi';

/** Reserved `type` discriminator. An object carrying it MUST be a valid pointer. */
export const ARTIFACT_POINTER_TYPE = 'archon_artifact';

/**
 * The pointer shape. Unknown sibling keys are tolerated (an author may label a pointer for
 * their own downstream code); the three engine-owned fields are not optional. Validation
 * against a run lives in `../artifact-pointer`.
 */
export const artifactPointerSchema = z.object({
  type: z.literal(ARTIFACT_POINTER_TYPE),
  run_id: z.string().min(1),
  path: z.string().min(1),
});

export type ArtifactPointer = z.infer<typeof artifactPointerSchema>;
