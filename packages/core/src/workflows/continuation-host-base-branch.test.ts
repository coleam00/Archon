import { expect, mock, test } from 'bun:test';
import type { IWorkflowEngine, WorkflowResumeInput } from '@archon/workflows/engine-port';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { HeadlessPlatform } from './headless-platform';

const run: WorkflowRun = {
  id: 'run',
  workflow_name: 'deliver',
  conversation_id: 'conv',
  parent_conversation_id: null,
  codebase_id: 'cb',
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
let storedBranch: string | null = null;
const childResolver = mock(() => async () => {
  throw new Error('not invoked');
});
mock.module('../db/workflows', () => ({
  getWorkflowRun: async () => run,
  WorkflowNotResumableError: class extends Error {},
}));
mock.module('../db/codebases', () => ({
  getCodebase: async () => ({
    id: 'cb',
    name: 'project',
    kind: 'repo',
    default_cwd: '/repo',
    default_branch: storedBranch,
  }),
}));
mock.module('../services/run-live-owner', () => ({
  startRunLiveOwner: async () => ({ close: async () => {} }),
  RunLiveOwnerAlreadyOwnedError: class extends Error {},
}));
mock.module('./resolve-run-workflow', () => ({
  resolveRunWorkflow: async () => ({ ok: true, workflow: { name: 'deliver', nodes: [] } }),
}));
mock.module('./child-isolation-resolver', () => ({ createChildWorktreeResolver: childResolver }));
const { resumeWorkflowContinuation } = await import('./continuation-host');

for (const choice of [null, '', ' release ']) {
  test(`continuation forwards ${String(choice)} to resume and child isolation`, async () => {
    storedBranch = choice;
    let captured: WorkflowResumeInput | undefined;
    const engine: IWorkflowEngine = {
      async submit() {
        throw new Error('not invoked');
      },
      async resume(input) {
        captured = input;
        return { accepted: false, reason: 'nothing-to-resume' };
      },
    };
    await resumeWorkflowContinuation(engine, run.id, async () => ({
      kind: 'ready',
      platform: new HeadlessPlatform('conv'),
      conversationId: 'conv',
    }));
    expect(captured?.options?.baseBranch).toBe(choice?.trim() || undefined);
    expect(childResolver).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseBranch: choice?.trim() || undefined })
    );
  });
}
