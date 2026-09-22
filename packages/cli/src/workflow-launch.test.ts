import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';

const workflowRunCommand = mock(async () => {});

mock.module('./commands/workflow', () => ({
  assertWorkflowRequirementsForUser: async () => {},
  resolveRunCodebase: async () => ({
    codebase: null,
    lookupError: null,
    registrationError: null,
  }),
  workflowRunCommand,
}));

const { executePreparedWorkflowLaunch } = await import('./workflow-launch');

function launch(
  isolation: PreparedWorkflowLaunch['execution']['isolation']
): PreparedWorkflowLaunch {
  return {
    version: 1,
    run: {
      id: '11111111-1111-4111-8111-111111111111',
      workflow_name: 'review',
      conversation_id: 'conversation-db-id',
      codebase_id: 'codebase-1',
      user_message: 'review this',
      metadata: {},
      user_id: 'user-1',
    },
    execution: {
      cwd: '/workspace/project',
      conversationId: 'cli-trigger-1',
      conversationDbId: 'conversation-db-id',
      actingUserId: 'user-1',
      inputs: { count: 2, enabled: true, labels: ['bug'] },
      isolation,
    },
  };
}

describe('executePreparedWorkflowLaunch', () => {
  beforeEach(() => workflowRunCommand.mockClear());

  it('hands typed inputs and an in-place lane to the ordinary workflow host', async () => {
    const prepared = launch({ kind: 'in-place' });
    await executePreparedWorkflowLaunch(prepared);

    expect(workflowRunCommand).toHaveBeenCalledWith(
      '/workspace/project',
      'review',
      'review this',
      expect.objectContaining({
        preparedLaunch: prepared,
        conversationId: 'cli-trigger-1',
        codebaseId: 'codebase-1',
        noWorktree: true,
      })
    );
  });

  it('restores the frozen worktree lane without reconstructing CLI argv', async () => {
    const prepared = launch({
      kind: 'worktree',
      branch: 'trigger-review',
      fromBranch: 'dev',
      baseOverride: 'release',
    });
    await executePreparedWorkflowLaunch(prepared);

    expect(workflowRunCommand).toHaveBeenCalledWith(
      '/workspace/project',
      'review',
      'review this',
      expect.objectContaining({
        preparedLaunch: prepared,
        branchName: 'trigger-review',
        fromBranch: 'dev',
        baseBranch: 'release',
      })
    );
  });
});
