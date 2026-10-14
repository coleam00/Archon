import { setSystemTime } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { describeStateDocumentConformance } from '../state-document-conformance';
import { createFileWorkflowStore } from './store';

describeStateDocumentConformance('files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-state-contract-'));
  setSystemTime(new Date('2000-01-01T00:00:00Z'));
  try {
    return {
      store: await createFileWorkflowStore({ root }),
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
