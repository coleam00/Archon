import { setSystemTime } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { describeStateDocumentConformance } from '../state-document-conformance';
import type { WorkflowRunStatus } from '../schemas/run-status';
import { createFileWorkflowStore } from './store';

type FileStore = Awaited<ReturnType<typeof createFileWorkflowStore>>;
function fileStoreLeaseRuns(store: FileStore) {
  return {
    create: async () =>
      (await store.createWorkflowRun({ workflow_name: 'lease', user_message: '' })).id,
    setStatus: async (id: string, status: WorkflowRunStatus) => {
      if (status === 'completed') await store.completeWorkflowRun(id, { duration_ms: 0 });
      else if (status === 'failed') await store.failWorkflowRun(id, 'stopped');
      else if (status === 'cancelled') await store.cancelWorkflowRun(id);
      else await store.updateWorkflowRun(id, { status });
    },
    remove: (id: string) => store.deleteWorkflowRun(id),
  };
}

describeStateDocumentConformance('files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-state-contract-'));
  setSystemTime(new Date('2000-01-01T00:00:00Z'));
  try {
    const store = await createFileWorkflowStore({ root });
    return {
      store,
      runs: fileStoreLeaseRuns(store),
      backdate: async () => {
        setSystemTime();
      },
      close: async () => {
        setSystemTime();
        await removeTempTree(root);
      },
    };
  } catch (error) {
    setSystemTime();
    await removeTempTree(root);
    throw error;
  }
});
