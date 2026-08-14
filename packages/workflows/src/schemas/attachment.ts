import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';

/**
 * A file attached to the message that triggered a workflow run. Structurally
 * identical to `AttachedFile` in `@archon/core/types` — redeclared here rather
 * than imported because `@archon/workflows` must never depend on `@archon/core`
 * (see the package-layer rules). Callers pass their `AttachedFile[]` straight
 * through; TypeScript accepts it because the shapes are structurally assignable.
 *
 * `path` must be absolute — every producer (adapters, the web upload endpoint)
 * already writes an absolute on-disk path, so a relative value only ever
 * indicates a malformed external input (e.g. `--attachments` on the CLI).
 */
export const workflowAttachmentSchema = z.object({
  path: z.string().min(1).refine(isAbsolute, { message: 'path must be an absolute path' }),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export type WorkflowAttachment = z.infer<typeof workflowAttachmentSchema>;
