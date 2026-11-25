import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
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
    setResourceCapacity: store.setResourceCapacity,
    backdate: store.backdate,
    seedPersistedWait: store.seedPersistedWait,
    terminalReports: () => [...reports],
    close: async () => {},
  };
});

test.skipIf(process.platform !== 'win32')(
  'the test host matches a forward-slash, lowercase-drive registration as the real stores do',
  async () => {
    const records = createInMemoryWorkflowHostStore();
    const checkout = resolve('archon-host-lookup');
    const created = await records.codebases.createCodebase({
      name: 'host-lookup',
      default_cwd: checkout.charAt(0).toLowerCase() + checkout.slice(1).replaceAll('\\', '/'),
    });

    expect((await records.codebases.findCodebaseByDefaultCwd(checkout))?.id).toBe(created.id);
    expect((await records.codebases.findCodebaseByPathPrefix(join(checkout, 'src')))?.id).toBe(
      created.id
    );
    expect(await records.codebases.findCodebaseByPathPrefix(`${checkout}-staging`)).toBeNull();
  }
);
