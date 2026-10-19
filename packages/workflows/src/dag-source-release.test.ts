// @archon-test-isolated
import { expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createMockDeps, createMockStore, dagOptions, makeWorkflowRun } from './dag/test-utils';
import { RunSourceUnreadableError } from './dag/node-source';

mock.module('./dag/run-layers', () => ({
  runLayers: async () => {
    throw new RunSourceUnreadableError('step', new Error('unreadable'));
  },
}));
import { executeDagWorkflow } from './dag-executor';
import { RunSourceReleaseError } from './run-source';

it('preserves the ownership signal and original cause when DAG source release rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-source-release-'));
  try {
    const cause = new Error('release store unavailable');
    const store = createMockStore();
    store.releaseRunForUnreadableSource.mockRejectedValueOnce(cause);
    const execution = executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflow: { name: 'source-release', nodes: [] },
        workflowRun: makeWorkflowRun('run'),
      })
    );
    await expect(execution).rejects.toBeInstanceOf(RunSourceReleaseError);
    await expect(execution).rejects.toMatchObject({ cause });
    expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  } finally {
    await removeTempTree(root);
  }
});
