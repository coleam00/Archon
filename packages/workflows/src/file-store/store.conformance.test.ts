import { afterEach, spyOn } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestSchema, slotSchema, pathFor } from './admission-documents';
import { readJson } from './commit';
import { trackTempRoots } from '@archon/paths/test-utils';
import { CONFORMANCE_CODEBASE_ID, describeWorkflowStoreConformance } from '../store-conformance';
import * as telemetry from '../run-terminal-telemetry';
import { createFileWorkflowStore } from './store';
import { commit } from './commit';
const roots = trackTempRoots();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
});
describeWorkflowStoreConformance('files', async () => {
  const root = roots(await mkdtemp(join(tmpdir(), 'workflow-files-')));
  const reports: string[] = [];
  const spy = spyOn(telemetry, 'reportRunTerminalTelemetry').mockImplementation(run => {
    reports.push(run.id);
  });
  restore = () => spy.mockRestore();
  const resourceCaps = new Map<string, number>();
  const options = {
    root,
    resourceCapacityPolicy: { loadCaps: async () => new Map(resourceCaps) },
    // The host's codebase records, as every conformance target registers them.
    getCodebase: async (id: string) =>
      id === CONFORMANCE_CODEBASE_ID
        ? {
            id,
            name: 'conformance',
            repository_url: null,
            default_cwd: '/conformance',
            kind: 'repo' as const,
          }
        : null,
  };
  const store = await createFileWorkflowStore(options);
  return {
    store,
    resourceCaps,
    reopenStore: () => createFileWorkflowStore(options),
    clearDeclaredCapacity: id =>
      commit(root, [], async () => {
        const path = pathFor('requests', id);
        const row = requestSchema.parse(await readJson(join(root, path)));
        delete row.declaredCapacity;
        const slotPath = pathFor('slots', row.resource);
        const slot = slotSchema(slotPath).parse(await readJson(join(root, slotPath)));
        slot.capacity = 1;
        return { result: undefined, changes: { documents: { [path]: row, [slotPath]: slot } } };
      }),
    backdate: (id, dates) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        Object.assign(run, dates);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    seedPersistedWait: (id, wait) =>
      commit(root, [id], async runs => {
        const run = runs.get(id);
        if (!run) throw new Error('Missing run');
        run.metadata.wait = structuredClone(wait);
        return { result: undefined, changes: { runs: [{ run }] } };
      }),
    terminalReports: () => [...reports],
    close: async () => {},
  };
});
