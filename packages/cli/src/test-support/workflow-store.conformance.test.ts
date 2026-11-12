import { test, expect } from 'bun:test';
import {
  describeWorkflowStoreConformance,
  CONFORMANCE_CODEBASE_ID,
  CONFORMANCE_CONVERSATION_ID,
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

test('new captured requests without a declared capacity use ten on drain and resume', async () => {
  const records = createInMemoryWorkflowHostStore();
  const codebase = await records.codebases.createCodebase({
    name: 'captured-default',
    default_cwd: '/captured-default',
  });
  const store = createInMemoryWorkflowStore(records);
  const ids: string[] = [];
  for (let index = 0; index < 11; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    expect(
      (
        await store.admitResourceStart({
          resource: 'resource',
          hostId: 'host',
          overlap: 'queue',
          launch: {
            version: 2,
            run: {
              id,
              codebase_id: codebase.id,
              workflow_name: 'captured-default',
              user_message: '',
              metadata: {
                workflow_source: {
                  version: 1,
                  root: '/captured',
                  origin: '/source',
                  captured_at: '2026-01-01T00:00:00Z',
                  digest: 'digest',
                  file_count: 1,
                  byte_count: 1,
                },
              },
            },
            execution: {
              cwd: `/captured-default/${id}`,
              conversationId: CONFORMANCE_CONVERSATION_ID,
              isolation: { kind: 'in-place' },
            },
          },
        })
      ).status
    ).toBe(index < 10 ? 'admitted' : 'queued');
  }
  const drain = () => store.drainResourceStarts({ resource: 'resource', hostId: 'host' });
  expect(await drain()).toEqual([]);
  await store.cancelWorkflowRun(ids[0]);
  expect(await drain()).toMatchObject([{ status: 'admitted', runId: ids[10] }]);
  await store.claimPendingWorkflowRun(ids[10]);
  await store.failWorkflowRun(ids[10], 'failed');
  expect((await store.resumeWorkflowRun(ids[10])).status).toBe('running');
});
