import { describeStateDocumentConformance } from '@archon/workflows/state-document-conformance';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/run-status';
import { createInMemoryStateDocumentStore } from './state-document-store';
describeStateDocumentConformance('in-memory CLI store', async () => {
  const statuses = new Map<string, WorkflowRunStatus>();
  const store = createInMemoryStateDocumentStore(id => statuses.get(id) ?? null);
  return {
    store,
    runs: {
      create: async () => {
        const id = crypto.randomUUID();
        statuses.set(id, 'pending');
        return id;
      },
      setStatus: async (id, status) => {
        statuses.set(id, status);
      },
      remove: async id => {
        statuses.delete(id);
      },
    },
    backdate: store.backdate,
    close: async () => {},
  };
});
