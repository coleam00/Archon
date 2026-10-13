import { describeStateDocumentConformance } from '@archon/workflows/state-document-conformance';
import { createInMemoryStateDocumentStore } from './state-document-store';
describeStateDocumentConformance('in-memory CLI store', async () => {
  const store = createInMemoryStateDocumentStore();
  return { store, backdate: store.backdate, close: async () => {} };
});
