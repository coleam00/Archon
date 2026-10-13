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
  const store = createInMemoryWorkflowStore(records, id => {
    reports.push(id);
  });
  return {
    store,
    backdate: store.backdate,
    terminalReports: () => [...reports],
    close: async () => {},
  };
});
