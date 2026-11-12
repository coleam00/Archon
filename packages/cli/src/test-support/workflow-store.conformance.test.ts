import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CODEBASE_ID,
} from '@archon/workflows/store-conformance';
import { createInMemoryWorkflowHostStore, createInMemoryWorkflowStore } from './workflow-store';

describeWorkflowStoreConformance('in-memory CLI test store', async () => {
  const records = createInMemoryWorkflowHostStore();
  const codebase = await records.codebases.createCodebase({
    name: 'conformance',
    default_cwd: '/conformance',
  });
  const getCodebase = records.codebases.getCodebase;
  records.codebases.getCodebase = async id =>
    id === CONFORMANCE_CODEBASE_ID ? { ...codebase, id } : getCodebase(id);
  const reports: string[] = [];
  const resourceCaps = new Map<string, number>();
  const store = createInMemoryWorkflowStore(
    records,
    id => {
      reports.push(id);
    },
    resourceCaps
  );
  return {
    store,
    resourceCaps,
    reopenStore: async () => store,
    clearDeclaredCapacity: store.clearDeclaredCapacity,
    backdate: store.backdate,
    seedPersistedWait: store.seedPersistedWait,
    terminalReports: () => [...reports],
    close: async () => {},
  };
});
