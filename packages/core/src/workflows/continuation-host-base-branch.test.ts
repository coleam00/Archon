import { expect, mock, test } from 'bun:test';
import type { IWorkflowEngine, WorkflowResumeInput } from '@archon/workflows/engine-port';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IIsolationProvider } from '@archon/isolation';
import { toBranchName } from '@archon/git';
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
const providerCreate = mock<IIsolationProvider['create']>(async () => ({
  id: '/child',
  provider: 'worktree',
  workingPath: '/child',
  branchName: toBranchName('child'),
  status: 'active',
  createdAt: new Date(),
  metadata: {
    provenance: 'created',
    adopted: false,
    creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
  },
}));
const isolation = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  ...isolation,
  configureIsolation: mock(() => undefined),
  getIsolationProvider: () => ({ create: providerCreate }),
}));
mock.module('../db/isolation-environments', () => ({
  create: async () => ({ id: 'child-env' }),
}));
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
    const resolver = captured?.options?.resolveChildIsolation;
    if (!resolver) throw new Error('Child resolver missing');
    await resolver.resolve({ parentRun: run, nodeId: 'child', codebaseId: 'cb' });
    expect(providerCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseBranch: choice?.trim() || undefined })
    );
  });
}
