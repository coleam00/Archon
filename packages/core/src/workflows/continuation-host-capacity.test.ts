// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import { HeadlessPlatform } from './headless-platform';

const run: WorkflowRun = {
  origin: { conversationId: 'conv' },
  id: 'run',
  workflow_name: 'deliver',
  conversation_id: 'conv',
  parent_conversation_id: null,
  codebase_id: null,
  status: 'paused',
  outcome: null,
  user_message: 'deliver',
  metadata: {},
  started_at: new Date(),
  completed_at: null,
  last_activity_at: null,
  working_path: '/worktree',
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
};
const close = mock(async () => {});
mock.module('../services/run-live-owner', () => ({
  startRunLiveOwner: async () => ({ close }),
  RunLiveOwnerAlreadyOwnedError: class extends Error {},
}));
mock.module('./resolve-run-workflow', () => ({
  resolveRunWorkflow: async () => ({ ok: true, workflow: { name: 'deliver', nodes: [] } }),
}));
const { resumeWorkflowContinuation } = await import('./continuation-host');

test('a continuation refused for capacity waits for capacity instead of failing', async () => {
  const blocker = { kind: 'run' as const, id: 'holder' };
  const engine: IWorkflowEngine = {
    async submit() {
      throw new Error('not invoked');
    },
    async resume() {
      throw new WorkflowResourceBusyError(run.id, blocker, 'waiting');
    },
    async subscribe() {
      throw new Error('not invoked');
    },
    async watchAttention() {
      throw new Error('not invoked');
    },
  };
  const admission = await resumeWorkflowContinuation(
    {
      engine,
      deps: { store: { getWorkflowRun: async () => run } },
      records: {},
    } as unknown as import('./host-store').WorkflowHost,
    run.id,
    async () => ({ kind: 'ready', platform: new HeadlessPlatform(), conversationId: 'conv' })
  );
  expect(admission).toEqual({
    kind: 'waiting_for_capacity',
    blocker,
    message: expect.stringContaining('keeps its place'),
  });
  expect(close).toHaveBeenCalledTimes(1);
});
