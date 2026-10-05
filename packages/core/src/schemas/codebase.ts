/**
 * Zod schemas for codebase row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Codebase
// ---------------------------------------------------------------------------

export const codebaseRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository_url: z.string().nullable(),
  default_cwd: z.string(),
  default_branch: z.string().nullable(),
  ai_assistant_type: z.string(),
  /**
   * Project kind discriminator. `'repo'` = a git repository (worktree isolation,
   * branch/PR flows). `'folder'` = a non-git workspace (multi-repo root or plain
   * ops folder) that runs in place with `_folder/<slug>/` named storage.
   * Backfilled to `'repo'` by DB DEFAULT for pre-existing rows.
   */
  kind: z.enum(['repo', 'folder']),
  commands: z.record(z.string(), z.object({ path: z.string(), description: z.string() })),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Codebase = z.infer<typeof codebaseRowSchema>;

export const projectBaseBranchInspectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder') }),
  z.object({
    kind: z.literal('repo'),
    defaultBranch: z.string().nullable(),
    reason: z
      .enum(['no_remote', 'ambiguous_remote', 'remote_unavailable', 'unknown_head'])
      .nullable(),
  }),
]);

export type ProjectBaseBranchInspection = z.infer<typeof projectBaseBranchInspectionSchema>;
