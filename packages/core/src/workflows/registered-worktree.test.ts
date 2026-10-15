// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { toBranchName, toRepoPath } from '@archon/git';
import type { WorktreeCreationEnvironment } from '@archon/isolation';

const actualIsolation = await import('@archon/isolation');
const create = mock<() => Promise<WorktreeCreationEnvironment>>();
mock.module('@archon/isolation', () => ({
  ...actualIsolation,
  getIsolationProvider: () => ({ create }),
}));
const { createRegisteredWorktree } = await import('./registered-worktree');

for (const metadata of [
  { provenance: 'created', adopted: false, creationId: 'creation-1', branchCreated: true },
  { provenance: 'created', adopted: false, creationId: 'creation-2', branchCreated: false },
  { provenance: 'adopted', adopted: true },
] satisfies WorktreeCreationEnvironment['metadata'][]) {
  test(`registration failure preserves recovery evidence for ${JSON.stringify(metadata)}`, async () => {
    const env: WorktreeCreationEnvironment = {
      id: '/worktrees/task',
      workingPath: '/worktrees/task',
      branchName: toBranchName('task'),
      provider: 'worktree',
      status: 'active',
      createdAt: new Date(),
      metadata,
    };
    create.mockResolvedValueOnce(env);
    const original = new Error('store unavailable');
    const error = await createRegisteredWorktree(
      {
        create: async () => {
          throw original;
        },
      },
      {
        request: {
          workflowType: 'task',
          identifier: 'task',
          codebaseId: 'codebase-1',
          canonicalRepoPath: toRepoPath('/repo'),
        },
        createdByPlatform: 'cli',
      }
    ).then(
      () => {
        throw new Error('registration must fail');
      },
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toBe(original);
    expect(error.message).toContain('store unavailable');
    expect(error.message).toContain('/worktrees/task');
    expect(error.message).toContain('/repo');
    expect(error.message).toContain('task');
    expect(error.message).toContain(metadata.provenance);
    expect(error.message).toContain('unregistered');
    if (metadata.provenance === 'created') {
      expect(error.message).toContain(metadata.creationId);
      expect(error.message).toContain(`branch created: ${String(metadata.branchCreated)}`);
    } else {
      expect(error.message).not.toContain('creation ID');
    }
  });
}
