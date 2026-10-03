/**
 * Zod schema for per-node provider sessions persisted across workflow re-runs.
 *
 * One row per (workflow_name, node_id, scope_key, provider) tuple — the
 * composite primary key. Stored when a node opts in via `persist_session: true`
 * (or workflow-level `persist_sessions: true`) and the resolved provider
 * supports session resume.
 *
 * Distinct from `AgentRequestOptions.persistSession` (the Claude SDK on-disk
 * transcript flag) — this records the provider's session ID so the executor can
 * pass it back as `resumeSessionId` on a later run with the same scope.
 */
import { z } from '@hono/zod-openapi';
import type { WorkflowRun } from './workflow-run';

export const workflowNodeSessionSchema = z.object({
  workflow_name: z.string(),
  node_id: z.string(),
  scope_key: z.string(),
  provider: z.string(),
  provider_session_id: z.string(),
  // Nullable because the FK to workflow_runs is ON DELETE SET NULL — deleting the
  // originating run clears this without dropping the resumable session itself.
  last_run_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WorkflowNodeSession = z.infer<typeof workflowNodeSessionSchema>;

/**
 * The `scope_key` a run reads and writes its persisted sessions under: the user
 * thread that launched it. `parent_conversation_id` records that thread on every
 * surface that has one (a web dispatch runs in a fresh hidden worker conversation,
 * so its own `conversation_id` differs on every run); a run without a parent, such
 * as a CLI run, is its own thread. Also keys the scope artifacts directory.
 */
export function persistScopeKey(
  run: Pick<WorkflowRun, 'conversation_id' | 'parent_conversation_id'>
): string {
  return run.parent_conversation_id ?? run.conversation_id;
}
